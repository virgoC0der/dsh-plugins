// Probe the floating button's real geometry against the composer, in the
// running GUI. Answers "what is the button actually overlapping" with numbers
// instead of a guess about the three-column layout.
//
// Usage: node scripts/probe-fab.mjs [url]
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_TO_OPEN = process.argv[2] ?? 'http://127.0.0.1:3080'
const PORT = 9336
const PROFILE = join(tmpdir(), 'dsh-wb-fab-profile')
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

const PROBE = `(() => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const fab = document.querySelector('.dswb-fab');
  const input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
  const out = {
    viewport: { w: innerWidth, h: innerHeight },
    fab: rect(fab),
    input: rect(input),
    fabCenter: null,
    beneathFab: null,
    composerStack: null,
    bar: null,
  };
  // Name the composer container structurally: the input's ancestors, largest first.
  if (input) {
    let node = input;
    const chain = [];
    for (let depth = 0; depth < 6 && node && node !== document.body; depth += 1) {
      const r = node.getBoundingClientRect();
      chain.push({ cls: (node.className || '').toString().slice(0, 44), y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) });
      node = node.parentElement;
    }
    out.composerChain = chain;
  }
  if (fab) {
    const r = fab.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + r.height / 2);
    out.fabCenter = { cx, cy };
    // What sits under the button's centre once the button itself is out of the way?
    const previous = fab.style.visibility;
    fab.style.visibility = 'hidden';
    const under = document.elementFromPoint(cx, cy);
    fab.style.visibility = previous;
    if (under) {
      out.beneathFab = { tag: under.tagName, cls: (under.className || '').toString().slice(0, 60), rect: rect(under) };
      // Is the composer the thing underneath? Walk up looking for the input.
      out.beneathContainsInput = input ? under.contains(input) || input.contains(under) : null;
    }
  }
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
    const probe = await send('Runtime.evaluate', {
      expression: `document.querySelector('.dswb-fab') !== null && document.querySelector('textarea') !== null`,
      returnByValue: true,
    })
    if (probe.result.value === true) break
  }
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const result = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
  if (result.exceptionDetails) console.error('evaluate failed:', JSON.stringify(result.exceptionDetails, null, 1))
  else console.log(result.result.value)
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  chrome.kill('SIGKILL')
}
