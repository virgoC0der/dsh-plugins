// Prove the whole browser-control loop: launch Chrome for Testing, talk CDP
// over Node's global WebSocket, render a page, create a second tab, get real
// PNG bytes back, and then drive the plugin's own `BrowserManager` interaction
// methods (locate, clickAt, typeText, waitFor, uploadFiles, scroll, settle)
// against a purpose-built page. No dependencies.
//
// The connection shape follows packages/workboard/scripts/measure-panel.mjs,
// which already works in this repository: connect straight to a page target's
// own webSocketDebuggerUrl and send commands WITHOUT a sessionId. A separate
// browser-level connection is used only for target (tab) management.
//
// Usage:
//   node scripts/cdp-smoke.mjs [out.png]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { BrowserManager } from '../lib/browser.js'
import { BrowserError } from '../lib/cdp.js'
import { resolveConfig } from '../lib/config.js'

const OUT = process.argv[2] ?? '/tmp/dsh-browser-smoke.png'
const PORT = 9351
const PROFILE = join(tmpdir(), 'dsh-browser-smoke-profile')
// A real file for `uploadFiles`; created here and removed in `finally`.
const UPLOAD = join(tmpdir(), 'dsh-browser-smoke-upload.txt')
const BINARY = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)

if (!existsSync(BINARY)) {
  console.error('chrome binary not found at ' + BINARY)
  process.exit(1)
}
rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })
writeFileSync(UPLOAD, 'dsh browser smoke upload payload\n')

const chrome = spawn(
  BINARY,
  [
    '--headless=new',
    // This script is run from a sandboxed shell, where Chrome's own OS sandbox
    // cannot initialize ("sandbox initialization failed: Operation not
    // permitted") and crashpad cannot write its dumps. Neither flag belongs in
    // the plugin's runtime defaults — see the note in the package README.
    '--no-sandbox',
    '--disable-crashpad',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--window-size=1280,800',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)

let stderr = ''
chrome.stderr.on('data', (chunk) => { stderr += chunk })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll the DevTools HTTP endpoint until it answers. */
async function waitForDevTools(deadlineMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (response.ok) return await response.json()
    } catch {}
    await sleep(150)
  }
  throw new Error('DevTools endpoint never came up.\nchrome stderr:\n' + stderr)
}

/** Poll /json/list for a target matching a predicate. */
async function findTarget(predicate, deadlineMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (response.ok) {
        const match = (await response.json()).find(predicate)
        if (match) return match
      }
    } catch {}
    await sleep(150)
  }
  throw new Error('no matching DevTools target appeared')
}

/** One CDP connection. Commands are sent without a sessionId. */
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(message.error.message))
        else entry.resolve(message.result)
        return
      }
      for (const listener of this.listeners) listener(message)
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('websocket failed: ' + url)), { once: true })
    })
    return new Cdp(socket)
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('CDP timeout: ' + method))
      }, 20000)
    })
  }

  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Wait for one event name, with a deadline. */
  once(method, deadlineMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('event timeout: ' + method)) }, deadlineMs)
      const off = this.on((message) => {
        if (message.method !== method) return
        clearTimeout(timer)
        off()
        resolve(message.params)
      })
    })
  }

  close() {
    try { this.socket.close() } catch {}
  }
}

/** Connect to a target by its id, via the HTTP target list. */
async function attach(targetId) {
  const target = await findTarget((t) => t.id === targetId && t.webSocketDebuggerUrl)
  return Cdp.connect(target.webSocketDebuggerUrl)
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) {
    throw new Error('page threw: ' + (result.exceptionDetails.exception?.description ?? 'unknown'))
  }
  return result.result.value
}

const PAGE = (heading, colour) => `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#0f1115;color:#e6e8eb}
    .wrap{padding:48px}.title{font-size:28px;font-weight:700;letter-spacing:-0.02em}
    .dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:${colour};margin-right:8px}
    .card{margin-top:24px;padding:20px;border:1px solid #2a2f3a;border-radius:12px;background:#161a21}
    button{margin-top:20px;padding:10px 18px;font-size:15px;border-radius:8px;border:1px solid #3a4150;background:#1e242e;color:#e6e8eb}
  </style></head><body><div class="wrap">
    <div class="title"><span class="dot"></span>${heading}</div>
    <div class="card" id="verdict">awaiting measurement</div>
    <button id="go">click me</button>
  </div>
  <script>
    console.log('smoke: page script ran');
    document.getElementById('verdict').textContent =
      'viewport ' + innerWidth + 'x' + innerHeight + ' | dpr ' + devicePixelRatio;
    document.getElementById('go').addEventListener('click', () => { console.log('smoke: clicked'); });
  </script></body></html>`

const asDataUrl = (html) => 'data:text/html;charset=utf-8,' + encodeURIComponent(html)

// The page the BrowserManager interaction checks run against. It carries every
// fixture the interaction methods need: a prefilled text input, a textarea, a
// button whose handler changes the DOM, an element that appears only after a
// delay, a file input, and enough height to scroll.
const INTERACTION = `<!doctype html><html><head><meta charset="utf-8"><title>interactions</title><style>
    html,body{margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#0f1115;color:#e6e8eb}
    .wrap{padding:24px}
    input,textarea{display:block;margin:10px 0;padding:8px;font:inherit;width:320px;background:#161a21;color:#e6e8eb;border:1px solid #2a2f3a;border-radius:8px}
    button{margin:10px 0;padding:10px 18px;font-size:15px;border-radius:8px;border:1px solid #3a4150;background:#1e242e;color:#e6e8eb}
    #late{display:none;margin:10px 0;color:#4ade80}
    .pad{height:1600px}
  </style></head><body><div class="wrap">
    <h1 id="heading">interaction page</h1>
    <input id="text" type="text" value="OLD">
    <input id="secret" type="password" value="hunter2">
    <textarea id="area"></textarea>
    <button id="go">click me</button>
    <div id="verdict">idle</div>
    <div id="late">appeared</div>
    <input id="file" type="file" multiple>
    <div id="file-verdict">no files</div>
    <div class="pad"></div>
    <div id="deep">deep target</div>
    <div class="pad"></div>
  </div>
  <script>
    console.log('smoke: interaction page ran');
    window.clicks = 0;
    window.submitted = 0;
    document.getElementById('go').addEventListener('click', function () {
      window.clicks += 1;
      document.getElementById('verdict').textContent = 'clicked ' + window.clicks;
    });
    document.getElementById('text').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        window.submitted += 1;
        document.getElementById('verdict').textContent = 'submitted ' + window.submitted;
      }
    });
    document.getElementById('file').addEventListener('change', function () {
      var input = document.getElementById('file');
      document.getElementById('file-verdict').textContent =
        input.files.length + ':' + (input.files[0] ? input.files[0].name : '');
    });
    setTimeout(function () {
      document.getElementById('late').style.display = 'block';
    }, 1500);
  </script></body></html>`

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '  — ' + detail))
}

try {
  const version = await waitForDevTools()
  check('DevTools endpoint answers', version['Browser'] !== undefined,
    version['Browser'] + ' | protocol ' + version['Protocol-Version'])

  // --- browser-level connection: tab management only -----------------------
  const browser = await Cdp.connect(version.webSocketDebuggerUrl)
  const first = await findTarget((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  check('page target visible in /json/list', first !== undefined, first?.url)

  // --- page-level connection, the workboard pattern ------------------------
  const page = await attach(first.id)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Network.enable')
  check('Page.enable / Runtime.enable / Network.enable', true, 'no sessionId needed')

  const consoleLines = []
  page.on((message) => {
    if (message.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
    }
  })

  const loaded = page.once('Page.loadEventFired')
  await page.send('Page.navigate', { url: asDataUrl(PAGE('Tab one', '#4ade80')) })
  await loaded
  check('Page.navigate + loadEventFired', true)

  const facts = JSON.parse(await evaluate(page, `JSON.stringify({
    title: document.title,
    verdict: document.getElementById('verdict').textContent,
    hasButton: document.querySelector('#go') !== null
  })`))
  check('Runtime.evaluate reads live DOM', facts.hasButton && facts.verdict.includes('viewport'), JSON.stringify(facts))

  // --- click through the input domain, then confirm the handler ran --------
  const box = JSON.parse(await evaluate(page, `(() => {
    const r = document.getElementById('go').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`))
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(200)
  check('Input.dispatchMouseEvent drives a real click', consoleLines.includes('smoke: clicked'), JSON.stringify(consoleLines))

  // --- screenshot ----------------------------------------------------------
  const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const bytes = Buffer.from(shot.data, 'base64')
  writeFileSync(OUT, bytes)
  const signature = bytes.subarray(0, 8).toString('hex')
  check('Page.captureScreenshot returns a real PNG', signature === '89504e470d0a1a0a' && bytes.length > 1000,
    bytes.length + ' bytes, sig ' + signature)

  check('console capture', consoleLines.includes('smoke: page script ran'), JSON.stringify(consoleLines))

  // --- a second tab, end to end -------------------------------------------
  const { targetId } = await browser.send('Target.createTarget', { url: asDataUrl(PAGE('Tab two', '#60a5fa')) })
  const second = await attach(targetId)
  await second.send('Page.enable')
  await second.send('Runtime.enable')
  const secondLoaded = second.once('Page.loadEventFired')
  await second.send('Page.navigate', { url: asDataUrl(PAGE('Tab two', '#60a5fa')) }).catch(() => {})
  await secondLoaded.catch(() => {})
  const secondFacts = JSON.parse(await evaluate(second, `JSON.stringify({
    heading: document.querySelector('.title').textContent.trim(),
    verdict: document.getElementById('verdict').textContent
  })`))
  check('multi-tab: second target is independent', secondFacts.heading === 'Tab two', JSON.stringify(secondFacts))

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const openPages = list.filter((t) => t.type === 'page')
  check('tab enumeration via /json/list', openPages.length >= 2, openPages.length + ' page targets')

  // --------------------------------------------------------------------------
  // The plugin's own interaction methods, driven end to end.
  //
  // `BrowserManager` is pointed at the very browser this script launched (same
  // port), so it ADOPTS that process instead of starting a second one and the
  // checks exercise lib/browser.js itself. Every assertion below reads the
  // result back out of the page with this script's own CDP client — never
  // "the call did not throw, so it must have worked".
  // --------------------------------------------------------------------------
  const manager = new BrowserManager(
    resolveConfig({
      port: PORT,
      headless: true,
      browserPath: BINARY,
      idleShutdownMs: 0,
      chromeFlags: [],
    }),
  )
  const tab = await manager.newTab('about:blank')
  check('BrowserManager adopts the running smoke browser', manager.adopted === true, 'port ' + PORT)

  const nav = await manager.navigate(tab, asDataUrl(INTERACTION))
  const domReady = await evaluate(
    tab.connection,
    `JSON.stringify({ heading: document.getElementById('heading').textContent, readyState: document.readyState })`,
  )
  check(
    'BrowserManager.navigate loads the interaction page',
    nav.timedOut === false && JSON.parse(domReady).heading === 'interaction page',
    domReady,
  )

  // --- waitFor -------------------------------------------------------------
  // The delayed element appears 1500ms after the page loads. Reading its
  // display just before the call proves `waitFor` had to poll for it rather
  // than finding it already there.
  const lateAtCall = await evaluate(tab.connection, `getComputedStyle(document.getElementById('late')).display`)
  const delayed = await manager.waitFor(tab, {
    selector: '#late',
    text: 'appeared',
    urlContains: 'data:text/html',
  })
  check(
    'waitFor polls until a delayed element, text, and URL condition all hold',
    lateAtCall === 'none' &&
      delayed.matched === true &&
      delayed.waitedMs >= 100 &&
      delayed.condition.includes('#late'),
    'displayAtCall=' + lateAtCall + ' ' + JSON.stringify(delayed),
  )

  const impossible = await manager.waitFor(tab, { selector: '#never-exists', timeoutMs: 400 })
  check(
    'waitFor returns matched:false on timeout instead of throwing',
    impossible.matched === false && impossible.waitedMs >= 400 && impossible.observed.includes('url='),
    JSON.stringify(impossible),
  )

  // --- locate --------------------------------------------------------------
  const button = await manager.locate(tab, '#go')
  const viewport = JSON.parse(await evaluate(tab.connection, `JSON.stringify({ w: innerWidth, h: innerHeight })`))
  const hit = await evaluate(tab.connection, `document.elementFromPoint(${button.x}, ${button.y}).id`)
  check(
    'locate returns an in-viewport centre point with a useful label',
    Number.isInteger(button.x) &&
      Number.isInteger(button.y) &&
      button.x >= 0 &&
      button.x < viewport.w &&
      button.y >= 0 &&
      button.y < viewport.h &&
      button.width > 0 &&
      button.height > 0 &&
      button.visible === true &&
      button.label.startsWith('button') &&
      button.label.includes('click me') &&
      hit === 'go',
    JSON.stringify(button) + ' elementFromPoint=' + hit,
  )

  let locateError = null
  try {
    await manager.locate(tab, '#missing-element')
  } catch (error) {
    locateError = error
  }
  check(
    'locate throws element-not-found for a missing selector',
    locateError instanceof BrowserError && locateError.code === 'element-not-found',
    locateError === null ? 'no error thrown' : locateError.code + ': ' + locateError.message,
  )

  const secret = await manager.locate(tab, '#secret')
  check(
    'locate never copies a password value into the model-visible label',
    secret.label.startsWith('input') && !secret.label.includes('hunter2'),
    JSON.stringify(secret),
  )

  // --- clickAt -------------------------------------------------------------
  await manager.clickAt(tab, button.x, button.y, { button: 'left', clickCount: 1 })
  const verdict = await evaluate(tab.connection, `document.getElementById('verdict').textContent`)
  check(
    'clickAt drives the page click handler at the located point',
    verdict === 'clicked 1',
    'verdict=' + JSON.stringify(verdict),
  )

  // --- typeText ------------------------------------------------------------
  const typed = await manager.typeText(tab, { text: 'hello world', selector: '#text', clear: true })
  const textDom = await evaluate(tab.connection, `document.getElementById('text').value`)
  check(
    'typeText with clear=true replaces the prefilled value',
    typed.fieldValue === 'hello world' && textDom === 'hello world' && typed.submitted === false,
    JSON.stringify(typed) + ' dom=' + JSON.stringify(textDom),
  )

  const area = await manager.typeText(tab, { text: 'second field', selector: '#area', clear: true })
  check(
    'typeText targets a textarea through its selector',
    area.fieldValue === 'second field',
    JSON.stringify(area),
  )

  const submitted = await manager.typeText(tab, { text: 'query', selector: '#text', clear: true, submit: true })
  await sleep(150)
  const enterCount = await evaluate(tab.connection, `window.submitted`)
  check(
    'typeText with submit=true presses Enter and the page handler sees it',
    submitted.submitted === true && submitted.fieldValue === 'query' && enterCount === 1,
    JSON.stringify(submitted) + ' pageSubmitted=' + enterCount,
  )

  // --- uploadFiles ---------------------------------------------------------
  await manager.uploadFiles(tab, '#file', [UPLOAD])
  const attached = JSON.parse(
    await evaluate(
      tab.connection,
      `JSON.stringify({
        count: document.getElementById('file').files.length,
        name: document.getElementById('file').files[0] ? document.getElementById('file').files[0].name : null,
        verdict: document.getElementById('file-verdict').textContent,
      })`,
    ),
  )
  check(
    'uploadFiles attaches a real file and the page reports it',
    attached.count === 1 && attached.name === basename(UPLOAD) && attached.verdict === '1:' + basename(UPLOAD),
    JSON.stringify(attached),
  )

  let uploadError = null
  try {
    await manager.uploadFiles(tab, '#go', [UPLOAD])
  } catch (error) {
    uploadError = error
  }
  check(
    'uploadFiles rejects a selector that is not a file input',
    uploadError instanceof BrowserError && uploadError.code === 'not-a-file-input',
    uploadError === null ? 'no error thrown' : uploadError.code + ': ' + uploadError.message,
  )

  // --- scroll --------------------------------------------------------------
  await manager.scroll(tab, { position: 'top' })
  const scrolled = await manager.scroll(tab, { deltaY: 600 })
  const pageScrollY = await evaluate(tab.connection, `Math.round(window.scrollY)`)
  check(
    'scroll by deltaY moves window.scrollY and reports the real geometry',
    scrolled.scrollY >= 590 &&
      scrolled.scrollY === pageScrollY &&
      scrolled.scrollHeight > 3000 &&
      scrolled.viewportHeight > 0 &&
      scrolled.target === 600,
    JSON.stringify(scrolled) + ' page=' + pageScrollY,
  )

  const bottom = await manager.scroll(tab, { position: 'bottom' })
  const atBottom = await evaluate(
    tab.connection,
    `window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2`,
  )
  check(
    "scroll with position:'bottom' reaches the end of the document",
    atBottom === true && bottom.target === 'bottom' && bottom.scrollY > 0,
    JSON.stringify(bottom) + ' atBottom=' + atBottom,
  )

  const intoView = await manager.scroll(tab, { selector: '#deep' })
  const deepRect = JSON.parse(
    await evaluate(
      tab.connection,
      `(() => {
        const r = document.getElementById('deep').getBoundingClientRect();
        return JSON.stringify({ top: Math.round(r.top), bottom: Math.round(r.bottom), height: innerHeight });
      })()`,
    ),
  )
  check(
    'scroll by selector centres the element in the viewport',
    deepRect.top >= 0 && deepRect.bottom <= deepRect.height && intoView.target === '#deep',
    JSON.stringify(intoView) + ' rect=' + JSON.stringify(deepRect),
  )

  // --- settle --------------------------------------------------------------
  const settleStart = Date.now()
  await manager.settle(tab, 120)
  const settleMs = Date.now() - settleStart
  const readyState = await evaluate(tab.connection, `document.readyState`)
  check(
    'settle waits for the delay and leaves the document ready',
    settleMs >= 120 && readyState === 'complete',
    settleMs + 'ms, readyState=' + readyState,
  )

  // --- the adopted tab's own streams ---------------------------------------
  check(
    'adopted tab streams console output from the interaction page',
    tab.console.some((entry) => entry.text.includes('smoke: interaction page ran')),
    JSON.stringify(tab.console.slice(-3)),
  )

  await browser.send('Target.closeTarget', { targetId })
  page.close(); second.close(); browser.close()
} catch (error) {
  // An abort is a failure, not a neutral outcome: record it, or a script that
  // crashed halfway could still exit 0 with every recorded check green.
  check('the smoke run completed without aborting', false, error.message)
  console.error('SMOKE FAILED:', error.message)
  if (stderr.trim() !== '') console.error('chrome stderr:\n' + stderr.trim().split('\n').slice(-8).join('\n'))
} finally {
  chrome.kill('SIGKILL')
  // Chrome keeps writing to its user-data directory until it has actually
  // exited, so deleting it immediately races the shutdown.
  await new Promise((resolve) => setTimeout(resolve, 500))
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  rmSync(UPLOAD, { force: true })
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
if (failed.length > 0) console.log('failed: ' + failed.map((r) => r.label).join(' | '))
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1)
