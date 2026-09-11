// End-to-end check of "click a board row -> it lands in the composer as context",
// against the running GUI: click a real PR row on a new conversation, then read
// the composer's own value back (not the plugin's idea of it).
//
// Usage: node scripts/verify-context.mjs [url]
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_TO_OPEN = process.argv[2] ?? 'http://127.0.0.1:3080'
const PORT = 9341
const PROFILE = join(tmpdir(), 'dsh-wb-ctx-profile')
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

const RUN = `(async () => {
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { steps: [] };
  const field = () => document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
  const draft = () => { const f = field(); return f === null ? null : (f.tagName === 'TEXTAREA' ? f.value : f.textContent); };

  // Go to a new conversation, which is where the board belongs.
  const newSession = [...document.querySelectorAll('button')]
    .find((el) => (el.getAttribute('aria-label') ?? '').includes('新建会话') || /new session/i.test(el.getAttribute('aria-label') ?? ''));
  if (!newSession) { out.error = 'no New Session button'; return JSON.stringify(out, null, 1); }
  newSession.click();
  await settle(5000);

  out.boardVisible = document.querySelector('.dswb-home') !== null;
  out.draftBefore = draft();

  const adds = [...document.querySelectorAll('.dswb-add')];
  out.addControls = adds.length;
  if (adds.length === 0) { out.error = 'no add controls rendered'; return JSON.stringify(out, null, 1); }

  // Click the first two rows (a PR and, if present, the next one).
  adds[0].click();
  await settle(700);
  out.afterFirst = draft();
  out.feedbackAfterFirst = [...document.querySelectorAll('.dswb-added')].map((el) => el.textContent);
  out.firstRowLabel = adds[0].textContent.trim().slice(0, 60);

  // The same row again must report a duplicate rather than duplicating the line.
  adds[0].click();
  await settle(700);
  out.afterSecondClick = draft();
  out.duplicateReported = [...document.querySelectorAll('.dswb-added')].some((el) => /already/.test(el.textContent));

  if (adds.length > 1) {
    adds[1].click();
    await settle(700);
    out.afterSecondRow = draft();
    out.secondRowLabel = adds[1].textContent.trim().slice(0, 60);
  }

  // A Jira row, picked out of its own section, to check that format too.
  const jiraSection = [...document.querySelectorAll('.dswb-sec')]
    .find((sec) => /Jira/i.test(sec.querySelector('.dswb-sec-head')?.textContent ?? ''));
  const jiraAdd = jiraSection ? jiraSection.querySelector('.dswb-add') : null;
  if (jiraAdd) {
    jiraAdd.click();
    await settle(700);
    out.jiraLine = (draft() ?? '').split('\\n').filter((l) => l.startsWith('- JIRA'))[0] ?? null;
  } else {
    out.jiraLine = 'no Jira row found';
  }

  // The composer must accept the text as a real draft: submitting reads it back
  // through the input machine, so a send button that enabled proves React took it.
  const sendish = [...document.querySelectorAll('button')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.top > innerHeight * 0.4 && /send|发送/i.test((el.getAttribute('aria-label') ?? '') + (el.getAttribute('title') ?? ''));
  });
  out.sendControl = sendish.length > 0 ? { label: sendish[0].getAttribute('aria-label') ?? sendish[0].getAttribute('title'), disabled: sendish[0].disabled } : null;
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
  const result = await send('Runtime.evaluate', { expression: RUN, returnByValue: true, awaitPromise: true })
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
