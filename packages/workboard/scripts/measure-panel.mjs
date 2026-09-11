// Measure the workboard as the user actually sees it: drive the real Harness GUI
// in a real browser over the Chrome DevTools Protocol, open the floating panel,
// and read the resulting layout back.
//
// The homepage board only renders while the session list has settled with no
// current session; the Harness restores the last session, so the panel is the
// surface a headless run can reliably reach.
//
// Usage: node scripts/measure-panel.mjs [url]
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_TO_OPEN = process.argv[2] ?? 'http://127.0.0.1:3080'
const PORT = 9335
const PROFILE = join(tmpdir(), 'dsh-wb-panel-profile')
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
    '--window-size=1440,900',
    '--remote-debugging-port=' + String(PORT),
    '--user-data-dir=' + PROFILE,
    URL_TO_OPEN,
  ],
  { stdio: 'ignore' },
)

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
  const pick = (target) => {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (el === null || el === undefined) return null;
    const cs = getComputedStyle(el);
    return { scrollH: el.scrollHeight, clientH: el.clientHeight, overflowY: cs.overflowY, scrollable: el.scrollHeight > el.clientHeight + 1 };
  };
  const out = {
    hasFab: document.querySelector('.dswb-fab') !== null,
    hasPanel: document.querySelector('.dswb-panel') !== null,
    panel: pick('.dswb-panel'),
    body: pick('.dswb-body'),
    cardBodies: [...document.querySelectorAll('.dswb-card-body')].map(pick),
    cards: [...document.querySelectorAll('.dswb-card-head')].map((el) => el.textContent.trim().slice(0, 36)),
    rows: document.querySelectorAll('.dswb-row').length,
    viewport: { w: innerWidth, h: innerHeight },
  };
  // Drive the panel body and the first section; a container that cannot scroll
  // leaves scrollTop at 0.
  const body = document.querySelector('.dswb-body');
  if (body !== null) { body.scrollTop = 100000; out.bodyScrolledTo = Math.round(body.scrollTop); body.scrollTop = 0; }
  const firstCard = document.querySelector('.dswb-card-body');
  if (firstCard !== null) { firstCard.scrollTop = 100000; out.firstCardScrolledTo = Math.round(firstCard.scrollTop); firstCard.scrollTop = 0; }
  const panel = document.querySelector('.dswb-panel');
  if (panel !== null) { const r = panel.getBoundingClientRect(); out.panelBox = { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; }
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

  const waitFor = async (expression, attempts, label) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const probe = await send('Runtime.evaluate', { expression, returnByValue: true })
      if (probe.result.value === true) return true
    }
    console.error('timed out waiting for ' + label)
    return false
  }

  await waitFor(`document.querySelector('.dswb-fab') !== null`, 60, 'the floating button')
  await send('Runtime.evaluate', { expression: `document.querySelector('.dswb-fab').click()` })
  await waitFor(`document.querySelector('.dswb-panel') !== null`, 20, 'the panel')
  // Wait for real rows so the panel is measured with its true content height.
  await waitFor(
    `document.querySelectorAll('.dswb-row').length > 0 || document.querySelector('.dswb-note') !== null`,
    60,
    'source rows',
  )
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
