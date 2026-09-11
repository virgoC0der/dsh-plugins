// Measure the real layout of the workboard in a real browser, over the Chrome
// DevTools Protocol. Avoids installing Playwright: the browser binary is already
// in the Playwright cache, and Node can speak CDP through its global WebSocket.
//
// Usage: node scripts/measure-scroll.mjs [url]
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_TO_OPEN = process.argv[2] ?? 'http://127.0.0.1:3080'
const PORT = 9333
const PROFILE = join(tmpdir(), 'dsh-wb-measure-profile')
const BINARY = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)
if (!existsSync(BINARY)) {
  console.error('chrome binary not found at ' + BINARY)
  process.exit(1)
}
rmSync(PROFILE, { recursive: true, force: true })

const chrome = spawn(
  BINARY,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1440,900',
    '--remote-debugging-port=' + String(PORT),
    '--user-data-dir=' + PROFILE,
    URL_TO_OPEN,
  ],
  { stdio: 'ignore' },
)

/** Poll the DevTools HTTP endpoint until a page target appears. */
async function pageTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:' + String(PORT) + '/json/list')
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page !== undefined) return page
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('no DevTools page target appeared')
}

/** Minimal CDP client: send a method, resolve its result by id. */
function cdp(ws) {
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const settle = pending.get(message.id)
    if (settle === undefined) return
    pending.delete(message.id)
    if (message.error) settle.reject(new Error(JSON.stringify(message.error)))
    else settle.resolve(message.result)
  })
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
}

const MEASURE = `(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const cs = getComputedStyle(el);
    return {
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
      offsetH: el.offsetHeight,
      overflowY: cs.overflowY,
      position: cs.position,
      alignItems: cs.alignItems,
      scrollable: el.scrollHeight > el.clientHeight + 1
    };
  };
  const out = {};
  for (const sel of ['.dswb-hero', '.dswb-hero-inner', '.dswb-grid', '.dswb-body', '.dswb-panel']) {
    out[sel] = pick(sel);
  }
  out.cards = document.querySelectorAll('.dswb-card').length;
  out.cardBodies = document.querySelectorAll('.dswb-card-body').length;
  out.rows = document.querySelectorAll('.dswb-row').length;
  out.cardBodiesScrollable = [...document.querySelectorAll('.dswb-card-body')]
    .filter((el) => el.scrollHeight > el.clientHeight + 1).length;
  // Prove the hero really scrolls: drive it and read the resulting offset back.
  const hero = document.querySelector('.dswb-hero');
  if (hero !== null) {
    const before = hero.scrollTop;
    hero.scrollTop = 100000;
    out.heroScrolledTo = Math.round(hero.scrollTop);
    hero.scrollTop = before;
  }
  out.viewport = { w: innerWidth, h: innerHeight };
  out.fab = document.querySelector('.dswb-fab') !== null;
  out.cardTitles = [...document.querySelectorAll('.dswb-card-head')].map((el) => el.textContent.trim().slice(0, 40));
  out.heroText = (document.querySelector('.dswb-hero-inner')?.textContent ?? '').slice(0, 160);
  return JSON.stringify(out, null, 1);
})()`

let ws
try {
  const target = await pageTarget()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const send = cdp(ws)
  await send('Runtime.enable')
  // Wait for the board to actually render rows, not just its loading placeholder:
  // the deck only proves scrolling once real content is in the DOM.
  const ready = `document.querySelectorAll('.dswb-row').length > 0
    || document.querySelector('.dswb-note') !== null
    || document.querySelectorAll('.dswb-card-body').length > 0`
  let rendered = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const probe = await send('Runtime.evaluate', { expression: ready, returnByValue: true })
    if (probe.result.value === true) {
      rendered = true
      break
    }
  }
  console.log('rendered real content: ' + String(rendered))
  // Settle a moment so fonts and the last source land before measuring.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const result = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })
  if (result.exceptionDetails) {
    console.error('evaluate failed:', JSON.stringify(result.exceptionDetails, null, 1))
  } else {
    console.log(result.result.value)
  }
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  chrome.kill('SIGKILL')
}
