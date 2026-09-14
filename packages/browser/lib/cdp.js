/**
 * Chrome DevTools Protocol transport.
 *
 * The connection shape is the one already proven in this repository (see
 * `packages/workboard/scripts/measure-panel.mjs` and `scripts/cdp-smoke.mjs`):
 * page commands go to a page target's OWN `webSocketDebuggerUrl` and carry no
 * `sessionId`; a second, browser-level connection is used only for target (tab)
 * management. Flat sessions attached to the browser endpoint were tried first
 * and `Page.enable` never answered — do not go back to that shape.
 *
 * Only Node builtins are used: `fetch` and the global `WebSocket` are both in
 * Node 22+, and nothing here imports a DSH package, because a linked plugin
 * package resolves its imports from its own real path.
 *
 * @module dsh-browser/lib/cdp
 */

/** A failure raised by this plugin, carrying a stable machine-readable code. */
export class BrowserError extends Error {
  /**
   * @param {string} code - stable identifier, e.g. `browser-not-running`.
   * @param {string} message - human- and model-readable explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
  }
}

/** Protocol calls are bounded; a hung tab must not hang the agent turn. */
export const CDP_TIMEOUT_MS = 30000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One CDP connection. Commands are sent without a `sessionId`.
 *
 * `send()` registers its pending entry BEFORE writing to the socket, so a
 * response that arrives while the write is still settling cannot be dropped.
 */
export class CdpConnection {
  /** @param {WebSocket} socket - an already-open DevTools websocket. */
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.closed = false
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (entry === undefined) return
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.reject(new BrowserError('cdp-error', `${entry.method}: ${message.error.message}`))
        else entry.resolve(message.result)
        return
      }
      for (const listener of this.listeners) {
        try {
          listener(message)
        } catch {
          /* a listener must never break the transport */
        }
      }
    })
    socket.addEventListener('close', () => {
      this.closed = true
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        this.pending.delete(id)
        entry.reject(new BrowserError('cdp-closed', `${entry.method}: the DevTools connection closed`))
      }
    })
  }

  /**
   * Open a connection to a DevTools websocket URL.
   * @param {string} url - `webSocketDebuggerUrl` of a browser or page target.
   * @returns {Promise<CdpConnection>} the connected transport.
   */
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = () => { cleanup(); reject(new BrowserError('cdp-connect', `could not open ${url}`)) }
      const cleanup = () => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
      }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
    })
    return new CdpConnection(socket)
  }

  /**
   * Send one protocol command.
   * @param {string} method - CDP method name.
   * @param {object} [params] - protocol parameters.
   * @param {number} [timeoutMs] - per-call budget.
   * @returns {Promise<any>} the command result.
   */
  send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new BrowserError('cdp-closed', `${method}: connection closed`))
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new BrowserError('cdp-timeout', `${method}: no reply within ${timeoutMs}ms`))
        }
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, method, timer })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new BrowserError('cdp-send', `${method}: ${error.message}`))
      }
    })
  }

  /**
   * Subscribe to protocol events.
   * @param {(message: {method: string, params: any}) => void} fn - event listener.
   * @returns {() => void} unsubscribe.
   */
  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * Wait for the next occurrence of one protocol event.
   * @param {string} method - event name, e.g. `Page.loadEventFired`.
   * @param {number} [deadlineMs] - how long to wait.
   * @returns {Promise<any>} the event params.
   */
  once(method, deadlineMs = CDP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new BrowserError('cdp-timeout', `event ${method} did not arrive within ${deadlineMs}ms`))
      }, deadlineMs)
      const off = this.on((message) => {
        if (message.method !== method) return
        clearTimeout(timer)
        off()
        resolve(message.params)
      })
    })
  }

  /** Close the transport; pending calls reject. */
  close() {
    this.closed = true
    try {
      this.socket.close()
    } catch {
      /* already gone */
    }
  }
}

/**
 * Poll `/json/version` until Chrome answers.
 * @param {number} port - the DevTools port.
 * @param {number} [deadlineMs] - how long to wait for startup.
 * @returns {Promise<{webSocketDebuggerUrl: string, Browser: string}>} version info.
 */
export async function waitForDevTools(port, deadlineMs = 20000) {
  const start = Date.now()
  let lastError = 'no response'
  while (Date.now() - start < deadlineMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error.message
    }
    await sleep(120)
  }
  throw new BrowserError('devtools-unreachable', `Chrome DevTools on port ${port} never answered (${lastError})`)
}

/**
 * List every DevTools target Chrome currently exposes.
 * @param {number} port - the DevTools port.
 * @returns {Promise<Array<{id: string, type: string, url: string, title: string, webSocketDebuggerUrl?: string}>>} targets.
 */
export async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) throw new BrowserError('targets-unavailable', `GET /json/list returned HTTP ${response.status}`)
  return await response.json()
}

/**
 * Wait for a target matching a predicate.
 * @param {number} port - the DevTools port.
 * @param {(target: any) => boolean} predicate - selection rule.
 * @param {number} [deadlineMs] - how long to wait.
 * @returns {Promise<any>} the matching target.
 */
export async function findTarget(port, predicate, deadlineMs = 10000) {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    try {
      const match = (await listTargets(port)).find(predicate)
      if (match !== undefined) return match
    } catch {
      /* still starting */
    }
    await sleep(120)
  }
  throw new BrowserError('target-not-found', 'no DevTools target matched')
}

/**
 * Connect to a page target by id.
 * @param {number} port - the DevTools port.
 * @param {string} targetId - the target to attach to.
 * @returns {Promise<{connection: CdpConnection, target: any}>} the page session.
 */
export async function attachToPage(port, targetId) {
  const target = await findTarget(port, (t) => t.id === targetId && t.type === 'page' && t.webSocketDebuggerUrl)
  const connection = await CdpConnection.connect(target.webSocketDebuggerUrl)
  return { connection, target }
}

/**
 * Evaluate an expression in the page and return its value.
 *
 * `Runtime.evaluate` reports page exceptions in `exceptionDetails` rather than
 * as a protocol error, so they are converted here — a tool must never report a
 * thrown script as a successful evaluation.
 *
 * @param {CdpConnection} connection - the page session.
 * @param {string} expression - JavaScript source, evaluated as an expression.
 * @param {object} [options] - `awaitPromise` (default true), `timeoutMs`.
 * @returns {Promise<any>} the JSON value of the result.
 */
export async function evaluate(connection, expression, options = {}) {
  const result = await connection.send(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise ?? true,
      userGesture: true,
    },
    options.timeoutMs ?? CDP_TIMEOUT_MS,
  )
  if (result.exceptionDetails !== undefined) {
    const details = result.exceptionDetails
    const text = details.exception?.description ?? details.text ?? 'unknown page exception'
    throw new BrowserError('page-exception', text.split('\n')[0])
  }
  return result.result?.value
}

/**
 * Capture the page as PNG bytes.
 * @param {CdpConnection} connection - the page session.
 * @param {object} [options] - `fullPage`, `clip`, `timeoutMs`.
 * @returns {Promise<Buffer>} the encoded PNG.
 */
export async function capturePng(connection, options = {}) {
  const params = { format: 'png', captureBeyondViewport: options.fullPage === true }
  if (options.clip !== undefined) {
    params.clip = { ...options.clip, scale: options.clip.scale ?? 1 }
    params.captureBeyondViewport = true
  }
  const result = await connection.send('Page.captureScreenshot', params, options.timeoutMs ?? CDP_TIMEOUT_MS)
  return Buffer.from(result.data, 'base64')
}

/**
 * The page's layout metrics, used to size full-page captures.
 * @param {CdpConnection} connection - the page session.
 * @returns {Promise<{cssWidth: number, cssHeight: number, viewportWidth: number, viewportHeight: number}>} metrics.
 */
export async function layoutMetrics(connection) {
  const metrics = await connection.send('Page.getLayoutMetrics')
  const css = metrics.cssContentSize ?? metrics.contentSize ?? { width: 0, height: 0 }
  const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? { clientWidth: 0, clientHeight: 0 }
  return {
    cssWidth: Math.round(css.width ?? 0),
    cssHeight: Math.round(css.height ?? 0),
    viewportWidth: Math.round(viewport.clientWidth ?? 0),
    viewportHeight: Math.round(viewport.clientHeight ?? 0),
  }
}
