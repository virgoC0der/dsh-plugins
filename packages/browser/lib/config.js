/**
 * Plugin configuration.
 *
 * Precedence, highest first: the `config` object a profile patch passes to the
 * plugin, environment variables, the plugin's own `config.json`, then the
 * defaults below. Workboard established this shape in this repository, and it
 * keeps the host half free of DSH package imports (a linked plugin resolves its
 * imports from its own real path, so `@deepseek-ai/schemastery` is not
 * reachable and config validation is done by hand).
 *
 * @module dsh-browser/lib/config
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The plugin's state directory, following workboard's `~/.dsh/<plugin>` convention. */
export const STATE_DIR = process.env.BROWSER_PLUGIN_STATE_DIR ?? join(homedir(), '.dsh/browser')

/** Default configuration. Every value is overridable. */
export const DEFAULTS = {
  /** Run Chrome without a visible window. Set false to watch the automation. */
  headless: true,
  /** DevTools port. A browser already listening here is adopted, not duplicated. */
  port: 9333,
  /** Explicit browser path; discovery runs when empty. */
  browserPath: '',
  windowWidth: 1440,
  windowHeight: 900,
  /** Extra Chrome flags, e.g. `['--no-sandbox']` inside a restricted container. */
  chromeFlags: [],
  /** Reclaim the browser after this long without a call. 0 disables reclamation. */
  idleShutdownMs: 10 * 60 * 1000,
  /** Per-navigation budget. */
  navigationTimeoutMs: 20000,
  /** Per-call budget for evaluations and interactions. */
  actionTimeoutMs: 15000,
  /** Browser startup budget. */
  startupTimeoutMs: 20000,
  /**
   * Per-capture budget. A sleeping display makes this expire on macOS — see
   * `wakeDisplay` — and a capture that cannot be answered should fail fast
   * rather than hold an agent turn.
   */
  captureTimeoutMs: 15000,
  /**
   * On macOS, wake the display before taking a screenshot.
   *
   * `Page.captureScreenshot` is answered by the browser's compositor, and a
   * sleeping display stops it producing frames: the request never returns, on
   * every launch-flag combination. An agent left running unattended would lose
   * every screenshot, so the display is woken for the capture only (`caffeinate
   * -u -t <seconds>`, which expires by itself).
   */
  wakeDisplay: process.platform === 'darwin',
  /** How long one wait_for call may block. */
  waitTimeoutMs: 30000,
  /** Screenshots retained on disk (a ring buffer; oldest are removed). */
  shotLimit: 60,
  /**
   * Start the browser when the plugin mounts, so the first tool call does not
   * pay for a cold Chrome start. Off by default: a session that never browses
   * should not cost a browser process.
   */
  prewarm: false,
  /** Tabs a single call may report. */
  maxTabs: 40,
  /** Attach the screenshot to the tool result for an image-capable model. */
  imageToModel: 'auto', // 'auto' | 'always' | 'never'
  /** Vision bridge: describe the screenshot with a separate vision model. */
  vision: {
    enabled: false,
    provider: '',
    model: '',
    /** Skip the bridge when an inline image already reached the model. */
    onlyWhenModelIsTextOnly: true,
    timeoutMs: 60000,
  },
  verbose: false,
}

/** Read a boolean from an environment variable. */
function envBool(value, fallback) {
  if (value === undefined) return fallback
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes'
}

/** Read a number from an environment variable. */
function envNumber(value, fallback) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Read a comma-separated list from an environment variable. */
function envList(value, fallback) {
  if (value === undefined || value.trim() === '') return fallback
  return value.split(',').map((item) => item.trim()).filter((item) => item !== '')
}

/**
 * Load the plugin's `config.json`, if present.
 * @returns {object} the parsed file, or an empty object.
 */
export function loadConfigFile() {
  const path = join(STATE_DIR, 'config.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    // A malformed file must not take the whole plugin down; defaults are usable.
    process.stderr.write(`[dsh-browser] ignoring unreadable ${path}: ${error.message}\n`)
    return {}
  }
}

/**
 * Resolve the effective configuration.
 * @param {object} [inline] - config passed by the profile patch.
 * @returns {object} resolved configuration with every default filled in.
 */
export function resolveConfig(inline = {}) {
  const file = loadConfigFile()
  const pick = (key, envName, coerce) => {
    if (inline[key] !== undefined) return inline[key]
    if (file[key] !== undefined) return file[key]
    return coerce(process.env[envName])
  }

  return {
    ...DEFAULTS,
    headless: pick('headless', 'BROWSER_PLUGIN_HEADLESS', (v) => envBool(v, DEFAULTS.headless)),
    port: pick('port', 'BROWSER_PLUGIN_PORT', (v) => envNumber(v, DEFAULTS.port)),
    browserPath: pick('browserPath', 'BROWSER_PLUGIN_CHROME', (v) => v ?? DEFAULTS.browserPath),
    windowWidth: pick('windowWidth', 'BROWSER_PLUGIN_WINDOW_WIDTH', (v) => envNumber(v, DEFAULTS.windowWidth)),
    windowHeight: pick('windowHeight', 'BROWSER_PLUGIN_WINDOW_HEIGHT', (v) => envNumber(v, DEFAULTS.windowHeight)),
    chromeFlags: pick('chromeFlags', 'BROWSER_PLUGIN_CHROME_FLAGS', (v) => envList(v, DEFAULTS.chromeFlags)),
    idleShutdownMs: pick('idleShutdownMs', 'BROWSER_PLUGIN_IDLE_MS', (v) => envNumber(v, DEFAULTS.idleShutdownMs)),
    navigationTimeoutMs: pick('navigationTimeoutMs', 'BROWSER_PLUGIN_NAV_TIMEOUT_MS', (v) =>
      envNumber(v, DEFAULTS.navigationTimeoutMs)),
    actionTimeoutMs: pick('actionTimeoutMs', 'BROWSER_PLUGIN_ACTION_TIMEOUT_MS', (v) =>
      envNumber(v, DEFAULTS.actionTimeoutMs)),
    startupTimeoutMs: pick('startupTimeoutMs', 'BROWSER_PLUGIN_STARTUP_TIMEOUT_MS', (v) =>
      envNumber(v, DEFAULTS.startupTimeoutMs)),
    captureTimeoutMs: pick('captureTimeoutMs', 'BROWSER_PLUGIN_CAPTURE_TIMEOUT_MS', (v) =>
      envNumber(v, DEFAULTS.captureTimeoutMs)),
    wakeDisplay: pick('wakeDisplay', 'BROWSER_PLUGIN_WAKE_DISPLAY', (v) => envBool(v, DEFAULTS.wakeDisplay)),
    waitTimeoutMs: pick('waitTimeoutMs', 'BROWSER_PLUGIN_WAIT_TIMEOUT_MS', (v) => envNumber(v, DEFAULTS.waitTimeoutMs)),
    shotLimit: pick('shotLimit', 'BROWSER_PLUGIN_SHOT_LIMIT', (v) => envNumber(v, DEFAULTS.shotLimit)),
    prewarm: pick('prewarm', 'BROWSER_PLUGIN_PREWARM', (v) => envBool(v, DEFAULTS.prewarm)),
    maxTabs: pick('maxTabs', 'BROWSER_PLUGIN_MAX_TABS', (v) => envNumber(v, DEFAULTS.maxTabs)),
    imageToModel: pick('imageToModel', 'BROWSER_PLUGIN_IMAGE_TO_MODEL', (v) => v ?? DEFAULTS.imageToModel),
    vision: { ...DEFAULTS.vision, ...(inline.vision ?? {}), ...(file.vision ?? {}) },
    verbose: pick('verbose', 'BROWSER_PLUGIN_VERBOSE', (v) => envBool(v, DEFAULTS.verbose)),
    // Overridable so a verification script can keep the browser profile, the
    // captured PNGs, and the config file inside its own temporary directory
    // instead of the user's home.
    stateDir: pick('stateDir', 'BROWSER_PLUGIN_STATE_DIR', (v) => v ?? STATE_DIR),
  }
}
