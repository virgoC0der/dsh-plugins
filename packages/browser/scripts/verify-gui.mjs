// Verify the running Harness GUI in a real browser, over CDP.
//
// This is the repo's established way of checking client-side work: drive the
// real shell, read the real DOM, and judge a design by looking at it rather
// than by reasoning about CSS. It differs from the workboard scripts in one
// respect that DSH 0.1.5 forced: the web server now requires an
// authority-bound signed cookie, so a throwaway browser profile would land on
// a 401 page. scripts/lib/dsh-auth.mjs mints that cookie from the secret DSH
// stores locally.
//
// Usage:
//   node scripts/verify-gui.mjs [url] [out.png]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { attachToPage, capturePng, evaluate, findTarget, waitForDevTools } from '../lib/cdp.js'
import { installCookie, mintCookie, selfCheck } from './lib/dsh-auth.mjs'

const TARGET = process.argv[2] ?? 'http://127.0.0.1:3080'
const OUT = process.argv[3] ?? '/tmp/dsh-gui.png'
const PORT = 9352
const PROFILE = join(tmpdir(), 'dsh-gui-verify-profile')
const BINARY = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)

if (!existsSync(BINARY)) {
  console.error('chrome binary not found at ' + BINARY)
  process.exit(1)
}

const target = new URL(TARGET)
const AUTHORITY = target.host

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
/** Record one assertion. */
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '  — ' + detail))
}

/** Poll a page expression until it returns truthy, or give up. */
async function waitFor(connection, expression, label, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(connection, expression, { awaitPromise: false, timeoutMs: 5000 }).catch(() => null)
    if (value) return true
    await sleep(250)
  }
  return false
}

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })

const chrome = spawn(
  BINARY,
  [
    '--headless=new',
    // The shell running this script is sandboxed; see scripts/cdp-smoke.mjs.
    '--no-sandbox',
    '--disable-crashpad',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)
let stderr = ''
chrome.stderr.on('data', (chunk) => { stderr += String(chunk) })

try {
  // Prove the cookie is valid before blaming the page for a 401.
  const cookie = mintCookie(AUTHORITY)
  check('minted a valid session cookie for ' + AUTHORITY, selfCheck(cookie, AUTHORITY), cookie.name)

  await waitForDevTools(PORT, 20000)
  const page = await findTarget(PORT, (entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
  const { connection } = await attachToPage(PORT, page.id)
  await connection.send('Page.enable')
  await connection.send('Runtime.enable')
  await connection.send('Network.enable')
  await installCookie(connection, AUTHORITY)

  const consoleErrors = []
  connection.on((message) => {
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push((message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' '))
    }
  })

  const loaded = connection.once('Page.loadEventFired', 20000).catch(() => null)
  await connection.send('Page.navigate', { url: TARGET })
  await loaded

  const bodyText = await evaluate(connection, 'document.body.innerText.slice(0, 200)', { awaitPromise: false }).catch(() => '')
  check('the authenticated shell is served', !String(bodyText).includes('authentication required'),
    String(bodyText).replace(/\s+/g, ' ').slice(0, 90) || '(empty body)')

  const booted = await waitFor(connection, 'document.querySelector("textarea, [contenteditable=true]") !== null', 'shell boot')
  check('the shell rendered its composer', booted)

  // Workboard compatibility: its client half injects `dsh-client-runtime`,
  // which no longer exists as a package in 0.1.5.
  const workboard = await waitFor(
    connection,
    'document.querySelector(".dswb-fab, .dswb-panel") !== null',
    'workboard mount',
    16,
  )
  check('workboard client half still mounts', workboard,
    workboard ? 'board found' : 'no .dswb-fab / .dswb-panel in the DOM')

  const probe = await evaluate(connection, `JSON.stringify({
    title: document.title,
    composer: document.querySelector('textarea, [contenteditable=true]') !== null,
    workboardFab: document.querySelector('.dswb-fab') !== null,
    workboardPanel: document.querySelector('.dswb-panel') !== null,
    workboardCss: document.querySelector('style[data-plugin="dsh-workboard"]') !== null,
    slotErrors: document.querySelectorAll('[data-slot-error]').length,
    browserCss: document.querySelector('style[data-plugin="dsh-browser"]') !== null,
    browserCards: document.querySelectorAll('.dshb-card').length,
    bodyLength: document.body.innerText.length
  })`, { awaitPromise: false })
  console.log('\nDOM probe: ' + probe)

  const png = await capturePng(connection, { fullPage: false })
  writeFileSync(OUT, png)
  check('captured the GUI as a PNG', png.length > 1000, `${png.length} bytes → ${OUT}`)
  if (consoleErrors.length > 0) console.log('console errors: ' + JSON.stringify(consoleErrors.slice(0, 5)))
} catch (error) {
  // An abort is a failure, never a neutral outcome.
  check('the GUI verification completed without aborting', false, error.message)
  console.error('\nGUI VERIFICATION FAILED: ' + error.message)
  if (stderr.trim() !== '') console.error(stderr.trim().split('\n').slice(-5).join('\n'))
} finally {
  chrome.kill('SIGKILL')
  rmSync(PROFILE, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1)
