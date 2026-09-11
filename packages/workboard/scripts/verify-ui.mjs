// Verify the three behaviours against the running GUI, in a real browser:
//   1. the button is circular and does not intersect the composer card
//   2. every section folds and unfolds
//   3. the board appears on a blank (newly opened) conversation
//
// Usage: node scripts/verify-ui.mjs [url]
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_TO_OPEN = process.argv[2] ?? 'http://127.0.0.1:3080'
const PORT = 9337
const PROFILE = join(tmpdir(), 'dsh-wb-verify-profile')
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

const HELPER = `
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const overlaps = (a, b) => a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
  const composer = () => {
    const input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
    if (!input) return null;
    let node = input;
    for (let d = 0; d < 8 && node && node !== document.body; d += 1) {
      const cs = getComputedStyle(node);
      const painted = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      if (painted && parseFloat(cs.borderTopLeftRadius) > 0) return node;
      node = node.parentElement;
    }
    return null;
  };
`

const CHECK = `(() => {${HELPER}
  const out = {};
  const fab = document.querySelector('.dswb-fab');
  if (fab === null) { return JSON.stringify({ error: 'no .dswb-fab in the DOM' }); }
  out.fabBox = rect(fab);
  out.fabShape = { borderRadius: getComputedStyle(fab).borderTopLeftRadius, width: Math.round(fab.getBoundingClientRect().width), height: Math.round(fab.getBoundingClientRect().height) };
  out.fabLabel = fab.textContent.trim();
  const card = composer();
  out.composerBox = card ? rect(card) : null;
  out.fabOverlapsComposer = card ? overlaps(out.fabBox, out.composerBox) : null;
  out.boardVisible = document.querySelector('.dswb-home') !== null;
  return JSON.stringify(out, null, 1);
})()`

// React batches state updates and re-renders asynchronously, so the probe must
// yield a frame after each click before reading the DOM back — a synchronous
// read right after .click() always sees the pre-click tree.
const FOLD = `(async () => {${HELPER}
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)));
  const results = [];
  const buttons = [...document.querySelectorAll('.dswb-fold')];
  for (const button of buttons) {
    const card = button.closest('.dswb-card');
    const title = [...card.querySelectorAll('.dswb-card-head > span')].map(el => el.textContent.trim()).filter(Boolean)[0] ?? '?';
    const bodyBefore = card.querySelector('.dswb-card-body') !== null;
    const hBefore = Math.round(card.getBoundingClientRect().height);
    button.click();
    await settle();
    const bodyAfter = card.querySelector('.dswb-card-body') !== null;
    const hAfter = Math.round(card.getBoundingClientRect().height);
    button.click();
    await settle();
    const bodyRestored = card.querySelector('.dswb-card-body') !== null;
    const hRestored = Math.round(card.getBoundingClientRect().height);
    results.push({ title, bodyBefore, bodyAfter, bodyRestored, hBefore, hAfter, hRestored, folds: bodyBefore && !bodyAfter && bodyRestored });
  }
  return JSON.stringify(results, null, 1);
})()`

const NEW_CONVERSATION = `(async () => {${HELPER}
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const newSession = [...document.querySelectorAll('button')]
    .find((el) => (el.getAttribute('aria-label') ?? '').includes('新建会话') || /new session/i.test(el.getAttribute('aria-label') ?? ''));
  if (!newSession) return JSON.stringify({ error: 'no New Session button found' });
  newSession.click();
  await settle(5000);
  const out = {};
  const home = document.querySelector('.dswb-home');
  out.boardVisible = home !== null;
  out.board = home ? rect(document.querySelector('.dswb-board')) : null;
  const card = composer();
  out.composerBox = card ? rect(card) : null;
  if (home !== null && card !== null) {
    const board = document.querySelector('.dswb-board');
    const br = board.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    out.sameWidthAsComposer = Math.abs(br.width - cr.width) <= 2;
    out.startsBelowComposer = br.top >= cr.bottom;
    out.withinViewport = br.bottom <= innerHeight + 1 && br.right <= innerWidth + 1 && br.left >= -1;
    out.viewportFractionW = Math.round((br.width * br.height) / (innerWidth * innerHeight) * 100) + '%';
    // Containment is the whole point: the page must stay usable around the board.
    const hitAt = (x, y) => { const el = document.elementFromPoint(x, y); return el === null ? null : el.className.toString().slice(0, 40); };
    out.composerHitTestable = (() => { const el = document.elementFromPoint(Math.round(cr.x + cr.width / 2), Math.round(cr.y + cr.height / 2)); return el !== null && (card.contains(el) || el.contains(card)); })();
    out.sidebarHitTestable = hitAt(24, 200);
    out.belowBoardHitTestable = hitAt(24, innerHeight - 40);
    out.sectionMarks = [...document.querySelectorAll('.dswb-sec-head .dswb-mark svg')].length;
    out.sections = [...document.querySelectorAll('.dswb-sec-head')].map((el) => [...el.querySelectorAll(':scope > span')].map(s => s.textContent.trim()).filter(Boolean)[0] ?? '?');
    out.fabShape = (() => { const f = document.querySelector('.dswb-fab'); if (!f) return null; const cs = getComputedStyle(f); return { radius: cs.borderTopLeftRadius, w: Math.round(f.getBoundingClientRect().width), h: Math.round(f.getBoundingClientRect().height), hasSvg: f.querySelector('svg') !== null, text: f.textContent.trim() }; })();
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
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails))
    return result.result.value
  }

  // Wait for the app to boot, then open the panel so the deck is on screen.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (await evaluate(`document.querySelector('.dswb-fab') !== null`)) break
  }
  await evaluate(`document.querySelector('.dswb-fab').click()`)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (await evaluate(`document.querySelectorAll('.dswb-row').length > 0`)) break
  }
  await new Promise((resolve) => setTimeout(resolve, 1500))

  console.log('=== button + composer geometry ===')
  console.log(await evaluate(CHECK))
  console.log('\n=== section folding ===')
  console.log(await evaluate(FOLD))
  // Close the panel first: the board is suppressed while it is open.
  await evaluate(`document.querySelector('.dswb-fab').click()`)
  await new Promise((resolve) => setTimeout(resolve, 800))
  console.log('\n=== new conversation: contained board ===')
  console.log(await evaluate(NEW_CONVERSATION))
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  chrome.kill('SIGKILL')
}
