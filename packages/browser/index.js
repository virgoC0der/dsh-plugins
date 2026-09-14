/**
 * dsh-browser — host half.
 *
 * Gives the agent a real browser: a tool family that drives Chrome over the
 * DevTools Protocol, plus the HTTP routes the browser needs in order to show
 * what was captured.
 *
 * Two planes meet here:
 *
 * - the model plane, reached through `ctx.tools.register`, where a call returns
 *   a text report and — when the route accepts images — the screenshot itself
 *   as a durable attachment;
 * - the human plane, reached through the web server, where the same screenshot
 *   is served from this plugin's own same-origin route so the client half can
 *   render it inline without touching the attachment plumbing.
 *
 * Only Node builtins are imported. A linked plugin package resolves its imports
 * from its own real path, so `@deepseek-ai/*` is not reachable from here; DSH
 * services arrive through `ctx` instead.
 *
 * @module dsh-browser
 */
import { join } from 'node:path'

import { BrowserManager } from './lib/browser.js'
import { BrowserError, evaluate } from './lib/cdp.js'
import { STATE_DIR, resolveConfig } from './lib/config.js'
import { ShotStore } from './lib/shots.js'
import { TOOL_NAMES, createTools } from './lib/tools.js'
import { createDescriber } from './lib/vision.js'

/** Cordis plugin name. */
export const name = 'dsh-browser'

/**
 * Required services. `llm` and `attachments` are deliberately absent: the
 * browser must work in a deployment that composes neither attachment storage
 * nor an LLM service, so those are reached optionally at call time.
 */
export const inject = ['tools', 'webServer']

/** Refuse to attach a screenshot larger than this to a model request. */
const MAX_ATTACH_BYTES = 8 * 1024 * 1024

/**
 * Answer with JSON.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serialisable payload.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Send an empty response with a status. */
function sendStatus(res, status) {
  res.writeHead(status, { 'cache-control': 'no-store' })
  res.end()
}

/**
 * The plugin body.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the mounting context.
 * @param {object} [inlineConfig] - configuration from the profile patch.
 */
export function apply(ctx, inlineConfig = {}) {
  const config = resolveConfig(inlineConfig)
  const shots = new ShotStore({ dir: join(config.stateDir, 'shots'), limit: config.shotLimit })
  const manager = new BrowserManager(config)

  const log = (message) => {
    if (config.verbose) process.stderr.write(`[dsh-browser] ${message}\n`)
  }

  /** The optional vision bridge; returns null unless `vision.enabled`. */
  const describer = createDescriber({ ctx, log })

  /**
   * Ask whether the route serving this execution's model accepts image input.
   *
   * This mirrors the gate `dsh-tool-fs` uses for `read_image`: the session's
   * routed provider/model, falling back to the agent's own options, resolved
   * through the optional `llm` service. The answer decides whether attaching a
   * screenshot is useful or merely noise, so an unresolvable route is reported
   * as unknown rather than guessed.
   *
   * @param {object} exec - the tool execution context.
   * @returns {Promise<boolean|null>} capability, or null when unknowable.
   */
  async function routeAcceptsImages(exec) {
    const llm = ctx.get('llm')
    if (llm === undefined) return null
    const agent = exec?.agent
    const routed = agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? agent?.options?.provider
    const model = routed?.model ?? agent?.options?.model
    if (provider === undefined || model === undefined) return null
    try {
      const info = await llm.resolveModelInfo(provider, model, exec.signal)
      if (info?.inputModalities === undefined) return null
      return info.inputModalities.includes('image')
    } catch (error) {
      log(`could not resolve model capabilities: ${error.message}`)
      return null
    }
  }

  /**
   * Store a screenshot as a durable attachment.
   *
   * This is the shared half of both image paths: the main model receives the
   * reference when it accepts images, and the vision bridge receives the same
   * reference when it does not.
   *
   * @param {object} shot - the stored shot record.
   * @returns {Promise<{attachment?: object, reason?: string}>} the outcome.
   */
  async function saveAttachment(shot) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) return { reason: 'no attachment service is composed' }
    if (shot.bytes > MAX_ATTACH_BYTES) {
      return { reason: `the PNG is ${shot.bytes} bytes, over the ${MAX_ATTACH_BYTES}-byte attach limit` }
    }
    const png = shots.read(shot.id)
    if (png === null) return { reason: 'the screenshot is no longer on disk' }
    const attachment = await attachments.saveImage({
      data: png,
      mediaType: 'image/png',
      name: `screenshot-${shot.id}.png`,
    })
    return { attachment }
  }

  /**
   * Attach a screenshot to the model-facing content when the route accepts
   * images.
   *
   * Attaching is not merely optional: the DeepSeek adapter rejects an image sent
   * to a model that does not declare image input, which would fail the whole
   * turn. So the capability is resolved first, and a text-only route is told why
   * it received no image instead.
   *
   * @param {object} exec - the tool execution context.
   * @param {object} shot - the stored shot record.
   * @returns {Promise<{attachment?: object, reason?: string}>} the outcome.
   */
  async function attachImage(exec, shot) {
    if (config.imageToModel === 'never') return { reason: 'imageToModel is "never"' }
    const capable = await routeAcceptsImages(exec)
    if (capable === false) return { reason: 'the current model does not declare image input' }
    if (capable === null && config.imageToModel !== 'always') {
      return { reason: 'the current model route could not be resolved' }
    }
    return await saveAttachment(shot)
  }

  /**
   * Ask the vision bridge what a screenshot shows, reusing the attachment the
   * model path already created when there is one.
   *
   * @param {object} exec - the tool execution context.
   * @param {object} shot - the stored shot record.
   * @returns {Promise<string|null>} the description, or null.
   */
  async function describeShot(exec, shot) {
    if (config.vision.enabled !== true) return null
    let attachment = shot.attachment
    if (attachment === undefined) {
      const saved = await saveAttachment(shot)
      if (saved.attachment === undefined) {
        log(`vision bridge skipped: ${saved.reason}`)
        return null
      }
      attachment = saved.attachment
    }
    return await describer(exec, attachment, config)
  }

  // ---------------------------------------------------------------- HTTP routes
  //
  // `ctx.webServer.register` is path-addressed with no method field, so each
  // path is registered once and the verb is checked inside the handler. The
  // shot route is a prefix: its id lives in the remaining path segment.
  ctx.effect(() => {
    const disposers = []

    disposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: '/browser/shot',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendStatus(res, 405)
        const id = new URL(req.url ?? '/', 'http://x').pathname.slice('/browser/shot/'.length)
        if (id === '') return sendStatus(res, 400)
        const png = shots.read(id)
        if (png === null) return sendStatus(res, 404)
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': png.length,
          // Ids are unique per capture, so a shot never changes under its id.
          'cache-control': 'private, max-age=3600, immutable',
        })
        res.end(req.method === 'HEAD' ? undefined : png)
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/browser/state',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendStatus(res, 405)
        sendJson(res, 200, {
          browser: manager.status(),
          shots: shots.list(10).map((shot) => ({ id: shot.id, url: shot.url, width: shot.width, height: shot.height, at: shot.at })),
          config: {
            headless: config.headless,
            port: config.port,
            idleShutdownMs: config.idleShutdownMs,
            imageToModel: config.imageToModel,
            prewarm: config.prewarm,
            vision: config.vision.enabled ? { provider: config.vision.provider, model: config.vision.model } : { enabled: false },
          },
          // The deadline the timeout policy actually enforces per tool — read
          // back from the registry rather than recomputed, so this route reports
          // what is really armed.
          budgets: Object.fromEntries(
            TOOL_NAMES.map((toolName) => [toolName, ctx.tools.get(toolName)?.timeoutMs ?? null]),
          ),
          tools: TOOL_NAMES,
        })
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/browser/health',
      handler: (req, res) => sendJson(res, 200, { ok: true, plugin: name }),
    }))

    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-browser: routes')

  // -------------------------------------------------------------------- tools
  ctx.effect(() => {
    const definitions = createTools({
      manager,
      shots,
      config,
      evaluate: (tab, expression) => evaluate(tab.connection, expression, { timeoutMs: config.actionTimeoutMs }),
      attachImage,
      describeShot,
    })
    const disposers = definitions.map((definition) => ctx.tools.register(definition))
    log(`registered ${definitions.length} browser tools`)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-browser: tools')

  // ----------------------------------------------------------------- prewarm
  // Optional: pay the cold start at mount instead of inside the first call.
  if (config.prewarm) {
    ctx.effect(() => {
      manager
        .ensureBrowser()
        .then((status) => log(`prewarmed ${status.browser} on port ${status.port}`))
        .catch((error) => log(`prewarm failed: ${error.message}`))
      return () => {}
    }, 'dsh-browser: prewarm')
  }

  // ----------------------------------------------------------------- teardown
  // The browser outlives a plugin reload on purpose (a new instance adopts the
  // one already listening on the configured port), so teardown only releases
  // the idle timer and any child process this instance actually owns.
  ctx.effect(() => () => manager.stop(), 'dsh-browser: browser')
}

/** Re-exported for the verification scripts, which import this module directly. */
export { BrowserManager, BrowserError, ShotStore, createTools, resolveConfig, STATE_DIR }
