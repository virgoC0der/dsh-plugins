// End-to-end: make a real agent call a browser tool, and verify the card that
// appears in the conversation.
//
// This is the only check that proves the client half RENDERS. Everything else
// stops short of it: verify-client.mjs proves the bundle registers, verify-gui.mjs
// proves the bundle loads, and verify-tools.mjs proves the host half works. Here
// a fresh session is created through the GUI, an actual prompt is submitted, the
// agent actually calls `browser_navigate`, and the resulting card is inspected —
// including the image's `naturalWidth`, which is only non-zero if the browser
// really fetched and decoded the PNG from `/browser/shot/<id>`.
//
// It drives the GUI the way a user does (a real click, real typing, a real
// Enter), so it costs one model turn. It creates a session in the workspace it
// is told to use and leaves it there.
//
// Usage:
//   node scripts/verify-inline.mjs [--workspace dsh-plugins] [--url https://example.com] [--timeout-ms 180000]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { attachToPage, capturePng, evaluate, findTarget, waitForDevTools } from '../lib/cdp.js'
import { installCookie } from './lib/dsh-auth.mjs'

/** Read `--name value` from argv. */
function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 || process.argv[at + 1] === undefined ? fallback : process.argv[at + 1]
}

const TARGET = arg('target', 'http://127.0.0.1:3080')
const AUTHORITY = new URL(TARGET).host
const WORKSPACE = arg('workspace', 'dsh-plugins')
const PAGE_URL = arg('url', 'https://example.com')
const TIMEOUT_MS = Number(arg('timeout-ms', '180000'))
const OUT = arg('out', '/tmp/dsh-inline-card.png')
const PORT = 9354
const PROFILE = join(tmpdir(), 'dsh-inline-verify')
const BINARY = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)

if (!existsSync(BINARY)) {
  console.error('chrome binary not found at ' + BINARY)
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
/** Record one assertion. */
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '  — ' + detail))
}

/** Evaluate and JSON-parse a page expression. */
async function probe(connection, expression) {
  const raw = await evaluate(connection, expression, { awaitPromise: false, timeoutMs: 10000 }).catch(() => null)
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Wait until an expression is truthy, returning the last value seen. */
async function until(connection, expression, deadlineMs) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < deadlineMs) {
    last = await probe(connection, expression)
    if (Array.isArray(last) ? last.length > 0 : last) return last
    await sleep(1000)
  }
  return last
}

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })

const chrome = spawn(BINARY, [
  '--headless=new',
  '--no-sandbox',
  '--disable-crashpad',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  '--window-size=1440,1000',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = ''
chrome.stderr.on('data', (chunk) => { stderr += String(chunk) })

try {
  await waitForDevTools(PORT, 20000)
  const page = await findTarget(PORT, (entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
  const { connection } = await attachToPage(PORT, page.id)
  await connection.send('Page.enable')
  await connection.send('Runtime.enable')
  await installCookie(connection, AUTHORITY)

  const loaded = connection.once('Page.loadEventFired', 20000).catch(() => null)
  await connection.send('Page.navigate', { url: TARGET })
  await loaded

  await until(connection, 'document.querySelector("textarea, [contenteditable=true]") !== null', 30000)
  const styles = await probe(connection, 'JSON.stringify(document.querySelector(\'style[data-plugin="dsh-browser"]\') !== null)')
  check('the browser plugin client half is loaded', styles === true)

  // Start a session in a real workspace, through the GUI's own control.
  const started = await evaluate(connection, `(() => {
    const button = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').includes('${WORKSPACE}') && (b.getAttribute('aria-label') || '').includes('新建会话'))
      ?? [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '新建会话')
    if (button === undefined) return 'no-new-session-button'
    button.click()
    return 'clicked:' + (button.getAttribute('aria-label') || '')
  })()`, { awaitPromise: false }).catch(() => 'error')
  check('a session was started from the GUI', String(started).startsWith('clicked'), String(started))

  await sleep(1500)
  const focused = await evaluate(connection, `(() => {
    const field = document.querySelector('textarea, [contenteditable=true]')
    if (field === null) return 'no-composer'
    field.focus()
    return field.tagName
  })()`, { awaitPromise: false }).catch(() => 'error')
  check('the composer took focus', focused === 'TEXTAREA' || focused === 'DIV', String(focused))

  // Type and submit like a user: real input events, then a real Enter key.
  const PROMPT = `只做一件事，不要做别的：调用 browser_navigate 工具，url 用 ${PAGE_URL}，screenshot 设为 true。收到结果后用一句话说明你看到了什么。`
  await connection.send('Input.insertText', { text: PROMPT })
  await sleep(400)
  const typed = await probe(connection, `JSON.stringify((document.querySelector('textarea')?.value ?? document.querySelector('[contenteditable=true]')?.textContent ?? '').includes('browser_navigate'))`)
  check('the prompt reached the composer', typed === true)

  for (const type of ['rawKeyDown', 'keyDown', 'keyUp']) {
    await connection.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
  }

  // The agent must actually call the tool; the card only exists after that.
  const started2 = Date.now()
  const cards = await until(connection, 'JSON.stringify(document.querySelectorAll(".dshb-card").length)', TIMEOUT_MS)
  const cardCount = Number(cards ?? 0)
  check('the agent called a browser tool and a card appeared', cardCount > 0,
    `${cardCount} card(s) after ${Math.round((Date.now() - started2) / 1000)}s`)

  // The card exists the moment the call starts, so the interesting states come
  // later: the call settles, and the image is fetched and decoded.
  const settled = await until(
    connection,
    `JSON.stringify(document.querySelector('.dshb-card .dshb-dot')?.getAttribute('data-state') === 'ok')`,
    TIMEOUT_MS,
  )
  check('the card settled to a successful state', settled === true,
    `${Math.round((Date.now() - started2) / 1000)}s after the call started`)

  const imageReady = await until(
    connection,
    `JSON.stringify((document.querySelector('.dshb-card img')?.naturalWidth ?? 0) > 0)`,
    TIMEOUT_MS,
  )
  check('the screenshot actually loaded in the page', imageReady === true,
    `${Math.round((Date.now() - started2) / 1000)}s after the call started`)

  if (cardCount > 0) {
    const card = await probe(connection, `(() => {
      const card = document.querySelector('.dshb-card')
      const img = card.querySelector('img')
      return JSON.stringify({
        head: card.querySelector('.dshb-name')?.textContent ?? null,
        target: card.querySelector('.dshb-target')?.textContent ?? null,
        state: card.querySelector('.dshb-dot')?.getAttribute('data-state') ?? null,
        body: (card.querySelector('.dshb-body')?.textContent ?? '').slice(0, 200),
        imageSrc: img === null ? null : img.getAttribute('src'),
        imageNaturalWidth: img === null ? 0 : img.naturalWidth,
        imageNaturalHeight: img === null ? 0 : img.naturalHeight,
        foot: card.querySelector('.dshb-shot-foot')?.textContent ?? null
      })
    })()`, { awaitPromise: false })
    console.log('\ncard: ' + JSON.stringify(card, null, 1))
    check('the card names the tool it rendered', card?.head === 'Navigate', String(card?.head))
    check('the card reports a settled, non-error state', card?.state === 'ok', String(card?.state))
    check('the card shows the model-facing report', typeof card?.body === 'string' && card.body.includes('loaded '),
      JSON.stringify(card?.body?.slice(0, 60)))
    check('the card embeds the screenshot from the plugin route',
      typeof card?.imageSrc === 'string' && card.imageSrc.startsWith('/browser/shot/'), String(card?.imageSrc))
    // naturalWidth is the real proof: the browser fetched and decoded the PNG.
    check('the screenshot actually loaded in the page', card?.imageNaturalWidth > 0,
      `${card?.imageNaturalWidth}x${card?.imageNaturalHeight}`)
  }

  const png = await capturePng(connection, { fullPage: false })
  writeFileSync(OUT, png)
  check('captured the conversation as a PNG', png.length > 1000, `${png.length} bytes → ${OUT}`)
} catch (error) {
  check('the end-to-end run completed without aborting', false, error.message)
  if (stderr.trim() !== '') console.error(stderr.trim().split('\n').slice(-6).join('\n'))
} finally {
  chrome.kill('SIGKILL')
  await sleep(400)
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) console.log('failed: ' + failed.map((result) => result.label).join(' | '))
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1)
