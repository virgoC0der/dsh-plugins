/**
 * Chrome process lifecycle and tab bookkeeping.
 *
 * One Chrome instance serves the whole plugin: launching a browser per tool
 * call would cost seconds each time and would break any multi-step flow
 * ("open this page, click, then screenshot the result"). The instance is
 * started lazily on the first tool call and reclaimed after an idle period.
 *
 * A browser already listening on the configured port is ADOPTED rather than
 * duplicated, so a plugin reload (the DSH loader restarts host halves) keeps
 * the tabs and their logged-in state.
 *
 * @module dsh-browser/lib/browser
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  BrowserError,
  CDP_TIMEOUT_MS,
  CdpConnection,
  attachToPage,
  capturePng,
  evaluate,
  layoutMetrics,
  listTargets,
  waitForDevTools,
} from './cdp.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** How many console lines / failed requests one tab remembers. */
const CONSOLE_LIMIT = 300
const FAILURE_LIMIT = 200

/** Candidate Chrome/Chromium locations, most specific first. */
function chromeCandidates() {
  const home = homedir()
  const candidates = []

  // Playwright's cache — how this repository's own scripts find a browser, so a
  // machine that has ever run them needs no new download.
  const macCache = join(home, 'Library/Caches/ms-playwright')
  const linuxCache = join(home, '.cache/ms-playwright')
  for (const cache of [macCache, linuxCache]) {
    if (!existsSync(cache)) continue
    const dirs = readdirSync(cache).filter((name) => name.startsWith('chromium-')).sort().reverse()
    for (const dir of dirs) {
      candidates.push(
        join(cache, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        join(cache, dir, 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        join(cache, dir, 'chrome-linux/chrome'),
        join(cache, dir, 'chrome-linux64/chrome'),
      )
    }
  }

  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    )
  }
  if (process.platform === 'linux') {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser')
  }
  if (process.platform === 'win32') {
    candidates.push(
      join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
      join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    )
  }
  return candidates
}

/**
 * Locate a usable browser binary.
 * @param {string} [override] - explicit path from configuration.
 * @returns {string} an existing binary path.
 * @throws {BrowserError} when nothing usable is installed.
 */
export function findChromeBinary(override) {
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) throw new BrowserError('chrome-missing', `configured browser not found at ${override}`)
    return override
  }
  for (const candidate of chromeCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  throw new BrowserError(
    'chrome-missing',
    'no Chrome or Chromium binary found. Set browserPath in the plugin config (or BROWSER_PLUGIN_CHROME) to the executable.',
  )
}

/** Whether anything already answers on a DevTools port, and what it is. */
async function probeDevTools(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`)
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/** Append to a capped array in place. */
function pushCapped(list, entry, limit) {
  list.push(entry)
  if (list.length > limit) list.splice(0, list.length - limit)
}

/**
 * Page-side helper shared by `locate` and `waitFor`, injected into the
 * evaluated expression so both decide "is it there and visible?" the same way.
 *
 * A `position: fixed` element legitimately reports a null `offsetParent`, so
 * that check alone would call a visible element unrendered; the element must
 * also carry no client rect at all, which is what `display: none` produces.
 */
const DOM_HELPERS = `
  const rendered = (el) => {
    if (el === null || el.isConnected !== true) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (el.getClientRects().length === 0) return false;
    if (el.offsetParent === null && style.position !== 'fixed' && el !== document.body && el !== document.documentElement) return false;
    return true;
  };
`

/** One tab: its page connection plus the streams a debugging session needs. */
class Tab {
  /**
   * @param {string} targetId - DevTools target id.
   * @param {import('./cdp.js').CdpConnection} connection - the page session.
   */
  constructor(targetId, connection) {
    this.targetId = targetId
    this.connection = connection
    /** @type {Array<{type: string, text: string, at: number}>} */
    this.console = []
    /** @type {Array<{url: string, status: number, at: number}>} */
    this.httpErrors = []
    /** @type {Array<{url: string, error: string, at: number}>} */
    this.requestFailures = []
    /** @type {Map<string, string>} */
    this.requestUrls = new Map()
    this.navigatedAt = Date.now()
  }

  /**
   * Start streaming console, log, and network facts for this tab.
   *
   * `Page.enable` is required before `Page.loadEventFired` is delivered, and
   * `Log.enable` is best-effort: some targets refuse it, and the console stream
   * from `Runtime` alone is still useful.
   */
  async startStreams() {
    const { connection } = this
    await connection.send('Page.enable')
    await connection.send('Runtime.enable')
    await connection.send('Network.enable')
    await connection.send('Log.enable').catch(() => undefined)

    connection.on((message) => {
      const params = message.params ?? {}
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (params.args ?? [])
          .map((arg) => {
            if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
            return arg.description ?? arg.unserializableValue ?? `<${arg.type}>`
          })
          .join(' ')
        pushCapped(this.console, { type: params.type ?? 'log', text, at: Date.now() }, CONSOLE_LIMIT)
        return
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails ?? {}
        const text = details.exception?.description ?? details.text ?? 'uncaught exception'
        pushCapped(this.console, { type: 'error', text: text.split('\n')[0], at: Date.now() }, CONSOLE_LIMIT)
        return
      }
      if (message.method === 'Log.entryAdded') {
        const entry = params.entry ?? {}
        if (entry.level === 'error' || entry.level === 'warning') {
          pushCapped(this.console, { type: entry.level, text: entry.text ?? '', at: Date.now() }, CONSOLE_LIMIT)
        }
        return
      }
      if (message.method === 'Network.requestWillBeSent') {
        this.requestUrls.set(params.requestId, params.request?.url ?? '')
        return
      }
      if (message.method === 'Network.responseReceived') {
        const status = params.response?.status ?? 0
        if (status >= 400) {
          pushCapped(
            this.httpErrors,
            { url: params.response?.url ?? this.requestUrls.get(params.requestId) ?? '', status, at: Date.now() },
            FAILURE_LIMIT,
          )
        }
        return
      }
      if (message.method === 'Network.loadingFailed') {
        // A cancelled navigation is noise, not a defect worth reporting.
        if (params.canceled === true) return
        pushCapped(
          this.requestFailures,
          {
            url: this.requestUrls.get(params.requestId) ?? '',
            error: params.errorText ?? 'unknown network error',
            at: Date.now(),
          },
          FAILURE_LIMIT,
        )
      }
    })
  }

  /** Forget everything observed since the last navigation. */
  resetStreams() {
    this.console.length = 0
    this.httpErrors.length = 0
    this.requestFailures.length = 0
    this.requestUrls.clear()
  }

  /** The tab's present URL and title, read from the page itself. */
  async describe() {
    const facts = await evaluate(
      this.connection,
      `({ url: location.href, title: document.title, readyState: document.readyState })`,
      { awaitPromise: false, timeoutMs: 5000 },
    ).catch(() => null)
    return facts ?? { url: '', title: '', readyState: 'unknown' }
  }
}

/** The plugin's whole browser: one process, many tabs, one active tab. */
export class BrowserManager {
  /**
   * @param {object} config - resolved plugin configuration.
   */
  constructor(config) {
    this.config = config
    this.process = null
    this.port = config.port
    this.browserConnection = null
    this.adopted = false
    /** @type {Map<string, Tab>} */
    this.tabs = new Map()
    this.activeTabId = null
    this.idleTimer = null
    this.starting = null
    this.lastUsedAt = Date.now()
  }

  /** The plugin's browser profile directory. */
  get profileDir() {
    return join(this.config.stateDir, 'profile')
  }

  /**
   * Ensure a browser is running and its DevTools endpoint is reachable.
   * @returns {Promise<{port: number, adopted: boolean, browser: string}>} the live browser.
   */
  async ensureBrowser() {
    if (this.starting !== null) return await this.starting
    this.starting = this._startBrowser().finally(() => {
      this.starting = null
    })
    return await this.starting
  }

  async _startBrowser() {
    this.touch()

    // Adopt a browser already on this port: after a plugin reload the same
    // Chrome keeps serving, and its tabs (and logins) survive.
    const existing = await probeDevTools(this.port)
    if (existing !== null) {
      this.adopted = true
      return { port: this.port, adopted: true, browser: existing.Browser ?? 'unknown' }
    }

    const binary = findChromeBinary(this.config.browserPath)
    const args = [
      ...(this.config.headless ? ['--headless=new'] : []),
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      `--window-size=${this.config.windowWidth},${this.config.windowHeight}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      ...this.config.chromeFlags,
      'about:blank',
    ]

    this.process = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false })
    let stderr = ''
    this.process.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    this.process.on('exit', (code, signal) => {
      this.process = null
      this.browserConnection?.close()
      this.browserConnection = null
      this.tabs.clear()
      this.activeTabId = null
      if (code !== 0 && code !== null && this.config.verbose) {
        process.stderr.write(`[dsh-browser] chrome exited with code ${code} (signal ${signal})\n`)
      }
    })

    try {
      const version = await waitForDevTools(this.port, this.config.startupTimeoutMs)
      return { port: this.port, adopted: false, browser: version.Browser ?? 'unknown' }
    } catch (error) {
      const tail = stderr.trim().split('\n').slice(-6).join('\n')
      this.stop()
      throw new BrowserError(
        'browser-start-failed',
        `${error.message}${tail === '' ? '' : `\nchrome stderr:\n${tail}`}`,
      )
    }
  }

  /** The browser-level connection, used only for tab management. */
  async ensureBrowserConnection() {
    if (this.browserConnection !== null && !this.browserConnection.closed) return this.browserConnection
    const version = await waitForDevTools(this.port, this.config.startupTimeoutMs)
    this.browserConnection = await CdpConnection.connect(version.webSocketDebuggerUrl)
    return this.browserConnection
  }

  /** All open pages, as {targetId, url, title, active}. */
  async listTabs() {
    const targets = (await listTargets(this.port)).filter((target) => target.type === 'page')
    return targets.map((target) => ({
      targetId: target.id,
      url: target.url,
      title: target.title,
      active: target.id === this.activeTabId,
    }))
  }

  /**
   * The active tab, creating a page if the browser has none, or reusing the
   * first page when the active one was closed.
   * @returns {Promise<Tab>} the active tab.
   */
  async ensureTab() {
    await this.ensureBrowser()

    if (this.activeTabId !== null) {
      const tab = this.tabs.get(this.activeTabId)
      if (tab !== undefined && !tab.connection.closed) return tab
      this.tabs.delete(this.activeTabId)
      this.activeTabId = null
    }

    const pages = (await listTargets(this.port)).filter((target) => target.type === 'page')
    const existing = pages.find((target) => this.tabs.has(target.id)) ?? pages[0]
    if (existing !== undefined) return await this.adoptTab(existing.id)

    return await this.newTab('about:blank')
  }

  /**
   * Attach to an existing target and start its streams.
   * @param {string} targetId - DevTools target id.
   * @returns {Promise<Tab>} the adopted tab.
   */
  /**
   * Make a tab the foreground target.
   *
   * Attaching to a target does not activate it, and a tab that is not in the
   * foreground does not produce compositor frames — which is what makes a
   * capture of it hang. Failures are ignored: an old target may refuse the call
   * while still being perfectly driveable.
   *
   * @param {Tab} tab - the tab to bring forward.
   * @returns {Promise<void>} resolves once the request has been made.
   */
  async bringToFront(tab) {
    await tab.connection.send('Page.bringToFront').catch(() => undefined)
  }

  async adoptTab(targetId) {
    const known = this.tabs.get(targetId)
    if (known !== undefined && !known.connection.closed) {
      this.activeTabId = targetId
      this.touch()
      await this.bringToFront(known)
      return known
    }
    const { connection } = await attachToPage(this.port, targetId)
    const tab = new Tab(targetId, connection)
    await tab.startStreams()
    this.tabs.set(targetId, tab)
    this.activeTabId = targetId
    this.touch()
    await this.bringToFront(tab)
    return tab
  }

  /**
   * Open a new tab and make it active.
   * @param {string} url - the URL to open.
   * @returns {Promise<Tab>} the new tab.
   */
  async newTab(url) {
    await this.ensureBrowser()
    const browser = await this.ensureBrowserConnection()
    const { targetId } = await browser.send('Target.createTarget', { url: url === '' ? 'about:blank' : url })
    return await this.adoptTab(targetId)
  }

  /**
   * Make an existing tab active.
   * @param {string} targetId - DevTools target id.
   * @returns {Promise<Tab>} the selected tab.
   */
  async selectTab(targetId) {
    await this.ensureBrowser()
    const open = (await listTargets(this.port)).some((target) => target.id === targetId && target.type === 'page')
    if (!open) throw new BrowserError('tab-not-found', `no open tab with id ${targetId}`)
    return await this.adoptTab(targetId)
  }

  /**
   * Close one tab.
   * @param {string} targetId - DevTools target id.
   * @returns {Promise<{closed: string, remaining: number}>} what happened.
   */
  async closeTab(targetId) {
    await this.ensureBrowser()
    const browser = await this.ensureBrowserConnection()
    const before = (await listTargets(this.port)).filter((target) => target.type === 'page')
    if (before.length <= 1) {
      throw new BrowserError('last-tab', 'refusing to close the last tab; the browser would have no page')
    }
    await browser.send('Target.closeTarget', { targetId })
    const tab = this.tabs.get(targetId)
    if (tab !== undefined) {
      tab.connection.close()
      this.tabs.delete(targetId)
    }
    if (this.activeTabId === targetId) this.activeTabId = null
    this.touch()
    return { closed: targetId, remaining: Math.max(before.length - 1, 0) }
  }

  /**
   * Navigate the active tab and wait for the page to settle.
   * @param {Tab} tab - the tab to drive.
   * @param {string} url - destination URL.
   * @param {object} [options] - `waitUntil` (`load` | `domcontentloaded` | `none`), `timeoutMs`.
   * @returns {Promise<{url: string, title: string, readyState: string, waitedMs: number, timedOut: boolean}>} page facts.
   */
  async navigate(tab, url, options = {}) {
    const waitUntil = options.waitUntil ?? 'load'
    const timeoutMs = options.timeoutMs ?? this.config.navigationTimeoutMs
    tab.resetStreams()
    const started = Date.now()

    if (waitUntil === 'none') {
      await tab.connection.send('Page.navigate', { url })
      tab.navigatedAt = Date.now()
      this.touch()
      return { ...(await tab.describe()), waitedMs: Date.now() - started, timedOut: false }
    }

    // The load listener must be armed BEFORE navigating, or a fast page wins
    // the race and the event is missed.
    const loaded = tab.connection.once('Page.loadEventFired', timeoutMs).catch(() => null)
    await tab.connection.send('Page.navigate', { url })
    let timedOut = false
    const settled = await loaded
    if (settled === null) {
      timedOut = true
      await this.waitForReady(tab, 2000)
    }
    tab.navigatedAt = Date.now()
    this.touch()
    return { ...(await tab.describe()), waitedMs: Date.now() - started, timedOut }
  }

  /**
   * Poll `document.readyState` until the page reports complete.
   * @param {Tab} tab - the tab to poll.
   * @param {number} [deadlineMs] - how long to wait.
   * @returns {Promise<boolean>} whether the page became ready.
   */
  async waitForReady(tab, deadlineMs = this.config.navigationTimeoutMs) {
    const start = Date.now()
    while (Date.now() - start < deadlineMs) {
      const state = await evaluate(tab.connection, 'document.readyState', { awaitPromise: false, timeoutMs: 5000 })
        .catch(() => null)
      if (state === 'complete' || state === 'interactive') return true
      await sleep(100)
    }
    return false
  }

  /**
   * Wake the display before a capture, on the platforms that need it.
   *
   * `Page.captureScreenshot` is answered by the browser's compositor, and on
   * macOS a sleeping display stops it producing frames: the request simply never
   * returns, on every launch-flag combination. Measured here — the identical
   * capture succeeds in ~2s with `caffeinate -u` and times out without it. An
   * agent that is left running unattended would therefore lose every screenshot,
   * so the display is woken for the duration of the capture only, and the timer
   * expires on its own.
   *
   * Fire-and-forget on purpose: the wake is best effort, and a platform without
   * `caffeinate` must not fail the capture.
   *
   * @returns {void}
   */
  wakeDisplay() {
    if (this.config.wakeDisplay !== true || process.platform !== 'darwin') return
    const seconds = Math.ceil((this.config.captureTimeoutMs + 5000) / 1000)
    try {
      const child = spawn('caffeinate', ['-u', '-t', String(seconds)], { stdio: 'ignore', detached: true })
      child.unref()
    } catch {
      /* best effort */
    }
  }

  /**
   * Capture the active tab.
   * @param {Tab} tab - the tab to capture.
   * @param {object} [options] - `fullPage`, `selector`.
   * @returns {Promise<{png: Buffer, viewport: {width: number, height: number}, fullPage: boolean, selector?: string}>} the capture.
   */
  async capture(tab, options = {}) {
    // A background tab does not composite, and `Page.captureScreenshot` on one
    // can simply never answer. Bringing the target to the front first is what
    // keeps a capture after `browser_tabs select` from hanging.
    await this.bringToFront(tab)
    this.wakeDisplay()
    let clip
    if (options.selector !== undefined) {
      const box = await evaluate(
        tab.connection,
        `(() => {
          const el = document.querySelector(${JSON.stringify(options.selector)});
          if (el === null) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height) };
        })()`,
        { awaitPromise: false },
      )
      if (box === null || box.width === 0 || box.height === 0) {
        throw new BrowserError('element-not-visible', `no visible element matched ${options.selector}`)
      }
      clip = box
    }
    const metrics = await layoutMetrics(tab.connection)
    const request = { fullPage: options.fullPage === true, clip, timeoutMs: this.config.captureTimeoutMs }
    let png
    try {
      png = await capturePng(tab.connection, request)
    } catch (error) {
      // The compositor occasionally drops a single request. One retry, after
      // re-fronting the tab and nudging the display again, turns a spurious
      // failure into a capture; a second timeout is reported as itself.
      if (!(error instanceof BrowserError) || error.code !== 'cdp-timeout') throw error
      await this.bringToFront(tab)
      this.wakeDisplay()
      try {
        png = await capturePng(tab.connection, request)
      } catch (retryError) {
        if (retryError instanceof BrowserError && retryError.code === 'cdp-timeout') {
          throw new BrowserError(
            'screenshot-timeout',
            `the browser produced no frame within ${this.config.captureTimeoutMs}ms. ` +
              (process.platform === 'darwin'
                ? 'On macOS this happens while the display is asleep; wake it (or leave wakeDisplay enabled) and retry.'
                : 'The renderer may be stalled; retry, or capture a smaller region.'),
          )
        }
        throw retryError
      }
    }
    this.touch()
    return {
      png,
      viewport: { width: metrics.viewportWidth, height: metrics.viewportHeight },
      fullPage: options.fullPage === true,
      ...(options.selector === undefined ? {} : { selector: options.selector }),
    }
  }

  /**
   * Resolve a selector to a viewport point a real mouse event can use.
   *
   * The point is the centre of the element's intersection with the viewport, so
   * an element that is only partly scrolled into view is still clicked where it
   * is actually visible. An element that is rendered but lies entirely outside
   * the viewport has no such point and is reported as not visible rather than
   * clicked at a clamped coordinate that would hit something else.
   *
   * @param {Tab} tab - the tab to inspect.
   * @param {string} selector - CSS selector for the element.
   * @returns {Promise<{x: number, y: number, width: number, height: number, label: string, visible: boolean}>} the clickable point and a short description.
   * @throws {BrowserError} `element-not-found` when nothing matches, `element-not-visible` when the match cannot be clicked, `invalid-selector` when the CSS does not parse.
   */
  async locate(tab, selector) {
    const result = await evaluate(
      tab.connection,
      `(() => {
        ${DOM_HELPERS}
        let el;
        try {
          el = document.querySelector(${JSON.stringify(selector)});
        } catch (error) {
          return { status: 'invalid' };
        }
        if (el === null) return { status: 'missing' };
        if (rendered(el) !== true) return { status: 'hidden' };
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return { status: 'hidden' };
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(innerWidth, rect.right);
        const bottom = Math.min(innerHeight, rect.bottom);
        if (right <= left || bottom <= top) return { status: 'offscreen' };
        const x = Math.min(Math.max(Math.round((left + right) / 2), 0), Math.max(0, Math.ceil(innerWidth) - 1));
        const y = Math.min(Math.max(Math.round((top + bottom) / 2), 0), Math.max(0, Math.ceil(innerHeight) - 1));
        let description = '';
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          const kind = (el.getAttribute('type') || '').toLowerCase();
          description = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
          // A password value is never copied into a label the model gets to read.
          if (description === '' && kind !== 'password') description = el.value || '';
          if (description === '' && el.id !== '') description = '#' + el.id;
          if (description === '' && kind === 'password') description = 'password field';
        } else {
          description = el.getAttribute('aria-label') || el.textContent || '';
        }
        description = description.replace(/\\s+/g, ' ').trim();
        if (description.length > 60) description = description.slice(0, 57) + '...';
        const tag = el.tagName.toLowerCase();
        return {
          status: 'ok',
          x,
          y,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          label: description === '' ? tag : tag + ' "' + description + '"',
        };
      })()`,
      { awaitPromise: false, timeoutMs: 5000 },
    )

    if (result === null || result === undefined || result.status !== 'ok') {
      const status = result?.status ?? 'missing'
      if (status === 'invalid') {
        throw new BrowserError('invalid-selector', `${selector} is not a valid CSS selector`)
      }
      if (status === 'missing') {
        throw new BrowserError('element-not-found', `no element matched ${selector}`)
      }
      throw new BrowserError(
        'element-not-visible',
        `${selector} matched an element that ${status === 'offscreen' ? 'lies outside the viewport' : 'is not rendered'}`,
      )
    }

    this.touch()
    return {
      x: result.x,
      y: result.y,
      width: result.width,
      height: result.height,
      label: result.label,
      visible: true,
    }
  }

  /**
   * Dispatch a real mouse press and release at a viewport point.
   *
   * @param {Tab} tab - the tab to drive.
   * @param {number} x - viewport x coordinate.
   * @param {number} y - viewport y coordinate.
   * @param {{button?: string, clickCount?: number}} [options] - button (default left) and click count (default 1).
   * @returns {Promise<void>} resolves once both events were accepted.
   * @throws {BrowserError} `invalid-point` when the coordinates are not numbers, `click-failed` when Chrome rejects the events.
   */
  async clickAt(tab, x, y, options = {}) {
    const button = options.button ?? 'left'
    const clickCount = options.clickCount ?? 1
    const timeoutMs = this.config.actionTimeoutMs ?? CDP_TIMEOUT_MS
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new BrowserError('invalid-point', `click coordinates must be finite numbers, got (${x}, ${y})`)
    }
    const buttons = button === 'left' ? 1 : button === 'right' ? 2 : button === 'middle' ? 4 : 0
    const point = { x, y, button, clickCount }
    try {
      await tab.connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, buttons }, timeoutMs)
      await tab.connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, buttons: 0 }, timeoutMs)
    } catch (error) {
      throw new BrowserError('click-failed', `mouse events at (${x}, ${y}) failed: ${error.message}`)
    }
    this.touch()
  }

  /**
   * Type text into the focused element, optionally focusing a field first.
   *
   * Clearing uses the browser's own select-all editing command followed by a
   * real Backspace, rather than assigning `el.value`: the key events reach
   * `<input>`, `<textarea>`, and contenteditable alike, and they fire the
   * `input`/`beforeinput` events a framework needs to see the edit.
   *
   * The field value is read back BEFORE Enter is pressed, so a submit that
   * navigates cannot make the read race the next document.
   *
   * @param {Tab} tab - the tab to drive.
   * @param {{text: string, selector?: string, clear?: boolean, submit?: boolean}} options - what to type.
   * @returns {Promise<{fieldValue: string|null, submitted: boolean}>} the value read from the DOM, and whether Enter was pressed.
   * @throws {BrowserError} when the selector matches nothing or the field is gone by the time the click lands.
   */
  async typeText(tab, options) {
    const text = typeof options?.text === 'string' ? options.text : ''
    const selector = options?.selector
    const clear = options?.clear === true
    const submit = options?.submit === true
    const timeoutMs = this.config.actionTimeoutMs ?? CDP_TIMEOUT_MS

    if (typeof selector === 'string' && selector !== '') {
      const target = await this.locate(tab, selector)
      await this.clickAt(tab, target.x, target.y, { button: 'left', clickCount: 1 })
      // A click on a vanished element lands on the page body and typing then
      // goes nowhere, so confirm the element took focus and say so plainly.
      const state = await evaluate(
        tab.connection,
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el === null || el.isConnected !== true) return 'gone';
          return el === document.activeElement || el.contains(document.activeElement) ? 'focused' : 'unfocused';
        })()`,
        { awaitPromise: false, timeoutMs: 5000 },
      ).catch(() => 'gone')
      if (state === 'gone') {
        throw new BrowserError('element-not-found', `${selector} disappeared before it could be typed into`)
      }
      if (state !== 'focused') {
        throw new BrowserError('field-not-focused', `${selector} did not take focus; the click landed elsewhere`)
      }
    }

    if (clear === true) {
      const modifier = process.platform === 'darwin' ? 4 : 2
      await tab.connection.send(
        'Input.dispatchKeyEvent',
        {
          type: 'rawKeyDown',
          modifiers: modifier,
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
          commands: ['selectAll'],
        },
        timeoutMs,
      )
      await tab.connection.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', modifiers: modifier, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
        timeoutMs,
      )
      await tab.connection.send(
        'Input.dispatchKeyEvent',
        { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
        timeoutMs,
      )
      await tab.connection.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
        timeoutMs,
      )
    }

    if (text !== '') await tab.connection.send('Input.insertText', { text }, timeoutMs)

    const fieldValue = await evaluate(
      tab.connection,
      `(() => {
        const el = document.activeElement;
        if (el === null) return null;
        if (el.isContentEditable === true) return el.textContent;
        return typeof el.value === 'string' ? el.value : null;
      })()`,
      { awaitPromise: false, timeoutMs: 5000 },
    ).catch(() => null)

    if (submit === true) {
      await tab.connection.send(
        'Input.dispatchKeyEvent',
        { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
        timeoutMs,
      )
      await tab.connection.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
        timeoutMs,
      )
    }

    this.touch()
    return { fieldValue: fieldValue === undefined ? null : fieldValue, submitted: submit }
  }

  /**
   * Poll until every supplied condition holds, or the budget runs out.
   *
   * Used instead of a fixed delay after an action whose effect is asynchronous.
   * A timeout is a normal answer, not an error, so the caller can report what
   * the page actually showed instead of failing the turn.
   *
   * @param {Tab} tab - the tab to watch.
   * @param {{selector?: string, text?: string, urlContains?: string, timeoutMs?: number}} [options] - conditions; all supplied ones must hold.
   * @returns {Promise<{matched: boolean, condition: string, waitedMs: number, observed: string}>} the outcome and what the page showed.
   */
  async waitFor(tab, options = {}) {
    const selector = options.selector
    const text = options.text
    const urlContains = options.urlContains
    const timeoutMs = options.timeoutMs ?? this.config.waitTimeoutMs
    const start = Date.now()

    const wantsSelector = typeof selector === 'string' && selector !== ''
    const wantsText = typeof text === 'string' && text !== ''
    const wantsUrl = typeof urlContains === 'string' && urlContains !== ''
    const parts = []
    if (wantsSelector) parts.push(`selector ${selector} is visible`)
    if (wantsText) parts.push(`text contains ${JSON.stringify(text)}`)
    if (wantsUrl) parts.push(`url contains ${urlContains}`)
    const condition = parts.join(' and ')

    const selectorProbe = wantsSelector
      ? `(() => {
          let el;
          try { el = document.querySelector(${JSON.stringify(selector)}); } catch (error) { return false; }
          if (el === null) return false;
          const rect = el.getBoundingClientRect();
          return rendered(el) === true && rect.width > 0 && rect.height > 0;
        })()`
      : 'null'

    let matched = false
    let observed = ''
    for (;;) {
      const remaining = timeoutMs - (Date.now() - start)
      const state = await evaluate(
        tab.connection,
        `(() => {
          ${DOM_HELPERS}
          const body = document.body;
          return {
            url: location.href,
            text: body === null ? '' : (body.innerText || body.textContent || ''),
            selectorVisible: ${selectorProbe},
          };
        })()`,
        { awaitPromise: false, timeoutMs: Math.max(200, Math.min(5000, remaining)) },
      ).catch(() => null)

      if (state !== null && state !== undefined) {
        const results = []
        if (wantsSelector) results.push(state.selectorVisible === true)
        if (wantsText) results.push(String(state.text).includes(text))
        if (wantsUrl) results.push(String(state.url).includes(urlContains))
        matched = results.length > 0 && results.every((value) => value === true)
        // A `data:` URL runs to kilobytes; keep what the model reads readable.
        const url = String(state.url)
        const shownUrl = url.length > 300 ? url.slice(0, 297) + '...' : url
        observed = `url=${shownUrl}; text=${String(state.text).replace(/\s+/g, ' ').trim().slice(0, 200)}`
      } else {
        observed = 'the page did not answer the condition probe'
      }

      if (matched) break
      if (Date.now() - start >= timeoutMs) break
      await sleep(150)
    }

    this.touch()
    return { matched, condition, waitedMs: Date.now() - start, observed }
  }

  /**
   * Attach local files to an `<input type="file">` through the DOM domain.
   *
   * The page is asked first whether the selector names a file input, so a
   * wrong selector produces a precise message instead of a protocol error; the
   * DOM node is then resolved and described for the same check before the
   * files are set.
   *
   * @param {Tab} tab - the tab to drive.
   * @param {string} selector - CSS selector of the file input.
   * @param {string[]} files - absolute paths, as supplied by the caller.
   * @returns {Promise<void>} resolves once Chrome reported the files attached.
   * @throws {BrowserError} `element-not-found`, `invalid-selector`, `not-a-file-input`, or `upload-failed`.
   */
  async uploadFiles(tab, selector, files) {
    const timeoutMs = this.config.actionTimeoutMs ?? CDP_TIMEOUT_MS

    const kind = await evaluate(
      tab.connection,
      `(() => {
        let el;
        try { el = document.querySelector(${JSON.stringify(selector)}); } catch (error) { return 'invalid'; }
        if (el === null) return 'missing';
        return el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file' ? 'file' : 'other';
      })()`,
      { awaitPromise: false, timeoutMs: 5000 },
    )
    if (kind === 'invalid') throw new BrowserError('invalid-selector', `${selector} is not a valid CSS selector`)
    if (kind === 'missing') throw new BrowserError('element-not-found', `no element matched ${selector}`)
    if (kind !== 'file') throw new BrowserError('not-a-file-input', `${selector} is not an <input type="file">`)

    await tab.connection.send('DOM.enable', {}, timeoutMs)
    const { root } = await tab.connection.send('DOM.getDocument', {}, timeoutMs)
    const { nodeId } = await tab.connection.send('DOM.querySelector', { nodeId: root.nodeId, selector }, timeoutMs)
    if (nodeId === 0 || nodeId === undefined) {
      throw new BrowserError('element-not-found', `no element matched ${selector}`)
    }
    const { node } = await tab.connection.send('DOM.describeNode', { nodeId }, timeoutMs)
    const attributes = node?.attributes ?? []
    const typeIndex = attributes.findIndex((name) => name.toLowerCase() === 'type')
    const type = typeIndex === -1 ? '' : String(attributes[typeIndex + 1]).toLowerCase()
    if ((node?.nodeName ?? '').toUpperCase() !== 'INPUT' || type !== 'file') {
      throw new BrowserError('not-a-file-input', `${selector} is not an <input type="file">`)
    }

    try {
      await tab.connection.send('DOM.setFileInputFiles', { files, nodeId }, timeoutMs)
    } catch (error) {
      throw new BrowserError('upload-failed', `could not attach ${files.length} file(s) to ${selector}: ${error.message}`)
    }
    this.touch()
  }

  /**
   * Scroll the page by element, by position, or by a pixel delta.
   *
   * Applied in that order — selector, then position, then delta — so the result
   * is the same no matter how many of them are supplied. `target` names the
   * last instruction applied, which is the one that decided the final offset.
   *
   * @param {Tab} tab - the tab to drive.
   * @param {{selector?: string, deltaY?: number, position?: string}} [options] - what to scroll.
   * @returns {Promise<{scrollY: number, scrollHeight: number, viewportHeight: number, target: (string|number|null)}>} the resulting geometry, read back from the page.
   * @throws {BrowserError} `element-not-found` when a supplied selector matches nothing.
   */
  async scroll(tab, options = {}) {
    const selector = options.selector
    const deltaY = options.deltaY
    const position = options.position
    let target = null

    if (typeof selector === 'string' && selector !== '') {
      const found = await evaluate(
        tab.connection,
        `(() => {
          let el;
          try { el = document.querySelector(${JSON.stringify(selector)}); } catch (error) { return false; }
          if (el === null) return false;
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          return true;
        })()`,
        { awaitPromise: false, timeoutMs: 5000 },
      )
      if (found !== true) throw new BrowserError('element-not-found', `no element matched ${selector}`)
      target = selector
    }

    if (position === 'top' || position === 'bottom') {
      await evaluate(
        tab.connection,
        position === 'top' ? 'window.scrollTo(0, 0)' : 'window.scrollTo(0, document.documentElement.scrollHeight)',
        { awaitPromise: false, timeoutMs: 5000 },
      )
      target = position
    }

    if (typeof deltaY === 'number' && Number.isFinite(deltaY) && deltaY !== 0) {
      await evaluate(tab.connection, `window.scrollBy(0, ${Math.round(deltaY)})`, {
        awaitPromise: false,
        timeoutMs: 5000,
      })
      target = deltaY
    }

    await sleep(150)
    const state = await evaluate(
      tab.connection,
      `({
        scrollY: Math.round(window.scrollY),
        scrollHeight: Math.round(document.documentElement.scrollHeight),
        viewportHeight: Math.round(window.innerHeight),
      })`,
      { awaitPromise: false, timeoutMs: 5000 },
    )

    this.touch()
    return {
      scrollY: state?.scrollY ?? 0,
      scrollHeight: state?.scrollHeight ?? 0,
      viewportHeight: state?.viewportHeight ?? 0,
      target,
    }
  }

  /**
   * Let the page react to the last action, then confirm it is ready.
   *
   * The fixed delay gives asynchronous handlers (fetch barriers, animations,
   * framework re-renders) time to run; `waitForReady` then bounds the call so a
   * page that never settles cannot hold the agent turn open. This is
   * deliberately the simple recipe — a quiescence heuristic would cost more in
   * false negatives than it saves in milliseconds.
   *
   * @param {Tab} tab - the tab to wait on.
   * @param {number} [ms] - how long to let the page react before the readiness check.
   * @returns {Promise<void>} resolves once the delay and the readiness check finish.
   */
  async settle(tab, ms = 0) {
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0
    if (delay > 0) await sleep(delay)
    await this.waitForReady(tab, 2000)
    this.touch()
  }

  /** Note activity and push the idle deadline back. */
  touch() {
    this.lastUsedAt = Date.now()
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    if (this.config.idleShutdownMs <= 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.stop()
    }, this.config.idleShutdownMs)
    // An idle browser must never hold the event loop open by itself.
    this.idleTimer.unref?.()
  }

  /** Kill the browser (and any adopted one on our port) and forget all tabs. */
  stop() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    for (const tab of this.tabs.values()) tab.connection.close()
    this.tabs.clear()
    this.activeTabId = null
    this.browserConnection?.close()
    this.browserConnection = null
    if (this.process !== null) {
      const child = this.process
      this.process = null
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    this.adopted = false
  }

  /** Remove the ephemeral profile directory (used when running without persistence). */
  cleanProfile() {
    try {
      rmSync(this.profileDir, { recursive: true, force: true })
    } catch {
      /* nothing to clean */
    }
  }

  /** A compact status snapshot for the plugin's own diagnostics route. */
  status() {
    return {
      port: this.port,
      running: this.process !== null || this.adopted,
      adopted: this.adopted,
      pid: this.process?.pid ?? null,
      activeTabId: this.activeTabId,
      tabs: this.tabs.size,
      profileDir: this.profileDir,
      lastUsedAt: this.lastUsedAt,
    }
  }
}
