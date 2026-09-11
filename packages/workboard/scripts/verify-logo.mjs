// Verify the brand artwork in the board header, including the fallback path.
//
// Before the host half is restarted the new /workboard/icon route 404s, which is
// exactly the degraded case the fallback exists for; after the restart the same
// check must show a loaded image instead.
//
// Usage: node scripts/verify-logo.mjs [url]
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_TO_OPEN = process.argv[2] ?? 'http://127.0.0.1:3080'
const PORT = 9342
const PROFILE = join(tmpdir(), 'dsh-wb-logo-profile')
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

const CHECK = `(async () => {
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const newSession = [...document.querySelectorAll('button')]
    .find((el) => (el.getAttribute('aria-label') ?? '').includes('新建会话') || /new session/i.test(el.getAttribute('aria-label') ?? ''));
  if (newSession) newSession.click();
  await settle(5500);
  const head = document.querySelector('.dswb-board-head');
  const out = { boardVisible: document.querySelector('.dswb-home') !== null, inHeader: head !== null };
  if (head === null) return JSON.stringify(out, null, 1);
  const img = head.querySelector('img.dswb-logo');
  const svg = head.querySelector('.dswb-mark svg');
  out.rendersImage = img !== null;
  out.rendersVectorFallback = svg !== null;
  if (img !== null) {
    const r = img.getBoundingClientRect();
    // naturalWidth is 0 when the fetch failed, which is what makes onError fire.
    out.imageLoaded = img.complete && img.naturalWidth > 0;
    out.imageNatural = img.naturalWidth + 'x' + img.naturalHeight;
    out.displayBox = Math.round(r.width) + 'x' + Math.round(r.height);
  }
  out.headerHeight = Math.round(head.getBoundingClientRect().height);
  out.title = head.querySelector('.dswb-board-title')?.textContent ?? null;
  out.status = head.querySelector('.dswb-board-sub')?.textContent ?? null;
  out.actions = head.querySelectorAll('.dswb-iconbtn').length;
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
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const probe = await send('Runtime.evaluate', { expression: `document.querySelector('.dswb-fab') !== null`, returnByValue: true })
    if (probe.result.value === true) break
  }
  const result = await send('Runtime.evaluate', { expression: CHECK, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) console.error('failed:', JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails))
  else console.log(result.result.value)
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  chrome.kill('SIGKILL')
}
