/**
 * The plugin's model-facing tool family.
 *
 * Two constraints shaped this file, both verified against DSH 0.1.5-rc.2:
 *
 * 1. These definitions are hand-written rather than produced by `defineTool`
 *    from `@deepseek-ai/dsh-tools`. A linked plugin package resolves imports
 *    from its own real path and cannot reach that package, and the registry
 *    does not import it for us: `ToolRuntime.register` validates `output.schema`
 *    but NEVER a definition's arguments. So every parameter is validated here
 *    (`ToolInputError`), and `output.schema` must stay inside the enforced JSON
 *    Schema subset — hence the deliberately open object roots.
 *
 * 2. The built-in web client ignores `presentCall`/`presentResult`. A tool card
 *    is derived from the raw call arguments, the result content, the failure
 *    state, and the persisted metadata. That last one is `presentationMeta` →
 *    `ToolResultNode.meta`, which is how the client half of this plugin learns
 *    which screenshot to render, so the whole canonical value is projected as
 *    metadata and the client view reads the fields it needs.
 *
 * An attached image must sit on an ENUMERABLE field of the canonical value:
 * the registry snapshots the value (losslessly re-materialising it) before
 * `render` runs, so a non-enumerable property would simply disappear.
 *
 * @module dsh-browser/lib/tools
 */

/** Every tool name this plugin registers. */
export const TOOL_NAMES = [
  'browser_navigate',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_eval',
  'browser_console',
  'browser_tabs',
  'browser_wait_for',
  'browser_upload',
  'browser_scroll',
]

/** An argument error the model can act on. */
export class ToolInputError extends Error {
  /**
   * @param {string} tool - tool name.
   * @param {string} detail - what was wrong.
   */
  constructor(tool, detail) {
    super(`${tool}: ${detail}`)
    this.name = 'ToolInputError'
  }
}

/** Read a required non-empty string argument. */
function requireString(tool, args, key) {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolInputError(tool, `"${key}" is required and must be a non-empty string`)
  }
  return value
}

/** Read an optional string argument. */
function optionalString(tool, args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ToolInputError(tool, `"${key}" must be a string`)
  return value
}

/** Read an optional boolean argument. */
function optionalBoolean(tool, args, key, fallback) {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new ToolInputError(tool, `"${key}" must be a boolean`)
  return value
}

/** Read an optional integer argument within bounds. */
function optionalInteger(tool, args, key, fallback, min, max) {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value)) throw new ToolInputError(tool, `"${key}" must be an integer`)
  if (value < min || value > max) throw new ToolInputError(tool, `"${key}" must be between ${min} and ${max}`)
  return value
}

/** Read an optional string array argument. */
function optionalStringArray(tool, args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ToolInputError(tool, `"${key}" must be an array of strings`)
  }
  return value
}

/** One text content block. */
const text = (value) => ({ type: 'text', text: value })

/** A JSON Schema root that accepts any object (the enforced subset's open object). */
const OPEN_OBJECT = { type: 'object', additionalProperties: true }

/** Join report lines, dropping empties. */
const lines = (...parts) => parts.filter((part) => part !== undefined && part !== '').join('\n')

/** Render a value for a report line. */
const show = (value) => (typeof value === 'string' ? value : JSON.stringify(value))

/**
 * Build one tool's output contract.
 *
 * `summary` renders the model-facing text; `imageOf` optionally names the field
 * holding a durable image attachment. The attachment is only ever a reference —
 * the bytes live in the attachment service.
 *
 * @param {(value: any) => string} summary - text projection.
 * @param {(value: any) => any} [imageOf] - attachment projector.
 * @returns {object} the `output` member of a tool definition.
 */
function output(summary, imageOf) {
  return {
    schema: OPEN_OBJECT,
    render: (_args, value) => {
      const blocks = [text(summary(value))]
      if (imageOf !== undefined) {
        const attachment = imageOf(value)
        if (attachment !== undefined && attachment !== null) blocks.push({ type: 'image', attachment })
        else if (typeof value?.imageSkipped === 'string') blocks.push(text(`(image not attached: ${value.imageSkipped})`))
      }
      return blocks
    },
    presentationMeta: (_args, value) => value,
  }
}

/** The shared "where did the page end up" tail. */
function pageTail(value) {
  return lines(
    value.title === '' || value.title === undefined ? undefined : `title: ${value.title}`,
    value.url === '' || value.url === undefined ? undefined : `url: ${value.url}`,
  )
}

/** The shared screenshot line. */
function shotLine(shot) {
  return shot === null || shot === undefined
    ? undefined
    : `screenshot ${shot.url} (${shot.width}x${shot.height}, id ${shot.id})`
}

/**
 * Build the tool definitions.
 *
 * @param {object} deps - `manager`, `shots`, `config`, `evaluate`, `attachImage`.
 * @returns {Array<object>} registry-ready definitions.
 */
export function createTools(deps) {
  const { manager, shots, config, evaluate, attachImage, describeShot } = deps

  /**
   * The declared budget for one call.
   *
   * `timeoutMs` is not advisory: `dsh-tool-call-timeout-policy` arms exactly
   * this deadline (`ctx.tools.get(name, agent)?.timeoutMs`) and replaces the
   * result with a timeout error when it fires. The FIRST browser call also pays
   * for launching Chrome, which on a cold profile can take tens of seconds, so
   * every budget covers a full browser start plus the work itself — otherwise a
   * successful call is reported as a failure while the capture quietly
   * completes in the background.
   *
   * @param {number} workMs - the tool's own work budget.
   * @returns {number} the declared budget in milliseconds.
   */
  const budget = (workMs) => config.startupTimeoutMs + workMs + 15000

  /**
   * Capture and store one screenshot.
   * @param {object} tab - the tab to capture.
   * @param {object} [options] - `fullPage`, `selector`.
   * @returns {Promise<object>} the stored shot record.
   */
  async function capture(tab, options = {}) {
    const shot = await manager.capture(tab, options)
    const facts = await tab.describe()
    return shots.save(shot.png, {
      pageUrl: facts.url,
      pageTitle: facts.title,
      fullPage: shot.fullPage,
      viewport: shot.viewport,
      selector: shot.selector,
    })
  }

  /** Capture after an action, when the caller asked for it. */
  async function maybeCapture(tab, args, tool) {
    if (!optionalBoolean(tool, args, 'screenshot', false)) return null
    return await capture(tab, { fullPage: optionalBoolean(tool, args, 'full_page', false) })
  }

  /**
   * Attach a captured screenshot to this call's model-facing content when the
   * route accepts images, recording why when it does not. Never throws: a model
   * that cannot see images must still receive the textual report.
   */
  async function attach(exec, shot) {
    try {
      const result = await attachImage(exec, shot)
      if (result?.attachment !== undefined && result.attachment !== null) {
        shot.attachment = result.attachment
      } else {
        shot.imageSkipped = result?.reason ?? 'not attached by configuration'
      }
    } catch (error) {
      shot.imageSkipped = `attachment failed: ${error.message}`
    }
    return shot
  }

  return [
    {
      name: 'browser_navigate',
      description:
        'Open a URL and wait for the page to load. Returns the final URL, the document title, and load timing. Pass screenshot=true to capture the page in the same call; the screenshot is shown inline in the conversation. The browser keeps its profile and tabs between calls, so a login performed once survives later calls.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute URL to open, including the scheme.' },
          new_tab: { type: 'boolean', description: 'Open in a new tab instead of the active one.' },
          wait_until: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'none'],
            description: 'How long to wait before returning; defaults to "load".',
          },
          screenshot: { type: 'boolean', description: 'Capture the page after loading.' },
          full_page: { type: 'boolean', description: 'With screenshot=true, capture the whole scrollable page.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      output: output((value) => lines(
        `loaded ${value.url} in ${value.waitedMs}ms${value.timedOut ? ' (timed out waiting for the load event)' : ''}`,
        value.title === '' ? undefined : `title: ${value.title}`,
        `readyState: ${value.readyState}`,
        shotLine(value.shot),
      ), (value) => value.shot?.attachment),
      timeoutMs: budget(config.navigationTimeoutMs),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const tool = 'browser_navigate'
        const url = requireString(tool, args, 'url')
        const waitUntil = optionalString(tool, args, 'wait_until') ?? 'load'
        if (!['load', 'domcontentloaded', 'none'].includes(waitUntil)) {
          throw new ToolInputError(tool, '"wait_until" must be load, domcontentloaded, or none')
        }
        const tab = optionalBoolean(tool, args, 'new_tab', false)
          ? await manager.newTab('about:blank')
          : await manager.ensureTab()
        const facts = await manager.navigate(tab, url, { waitUntil, timeoutMs: config.navigationTimeoutMs })
        const shot = await maybeCapture(tab, args, tool)
        if (shot !== null) await attach(exec, shot)
        return {
          url: facts.url,
          title: facts.title,
          readyState: facts.readyState,
          waitedMs: Math.round(facts.waitedMs),
          timedOut: facts.timedOut,
          tabId: tab.targetId,
          shot,
        }
      },
    },

    {
      name: 'browser_screenshot',
      description:
        'Capture the active tab as a PNG and show it inline. Use this to see what a page actually looks like before deciding what to click. Pass a CSS selector to capture one element, or full_page=true for the whole scrollable page. The image reaches the model only when the current model accepts image input; the human always sees it in the conversation.',
      parameters: {
        type: 'object',
        properties: {
          full_page: { type: 'boolean', description: 'Capture the entire scrollable page, not just the viewport.' },
          selector: { type: 'string', description: 'Capture only the first element matching this CSS selector.' },
        },
        additionalProperties: false,
      },
      output: output((value) => lines(
        `captured ${value.width}x${value.height}${value.fullPage ? ' (full page)' : ''}${value.selector === undefined ? '' : ` of ${value.selector}`}`,
        value.pageTitle === '' || value.pageTitle === undefined ? undefined : `title: ${value.pageTitle}`,
        value.pageUrl === '' || value.pageUrl === undefined ? undefined : `url: ${value.pageUrl}`,
        `shot id: ${value.id}`,
        value.imageSkipped === undefined ? undefined : `(image not attached: ${value.imageSkipped})`,
        value.description === undefined ? undefined : `what the page shows, described by a vision model:\n${value.description}`,
      ), (value) => value.attachment),
      timeoutMs: budget(config.actionTimeoutMs + 5000),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const tool = 'browser_screenshot'
        const tab = await manager.ensureTab()
        const shot = await capture(tab, {
          fullPage: optionalBoolean(tool, args, 'full_page', false),
          selector: optionalString(tool, args, 'selector'),
        })
        const enriched = await attach(exec, shot)
        // The bridge only earns its extra model call when the model did not
        // already receive the image, unless the configuration says otherwise.
        const wantsDescription = config.vision.enabled === true
          && (enriched.attachment === undefined || config.vision.onlyWhenModelIsTextOnly !== true)
        if (wantsDescription) {
          const description = await describeShot(exec, enriched)
          if (description !== null) enriched.description = description
        }
        return enriched
      },
    },

    {
      name: 'browser_click',
      description:
        'Click an element, addressed by CSS selector. The click is a real mouse event at the element centre, so it triggers the same handlers a user would, including navigation. Returns what was clicked and where the page ended up. Pass screenshot=true to see the result.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the element to click.' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; defaults to left.' },
          click_count: { type: 'integer', description: '1 for a single click, 2 for a double click.' },
          screenshot: { type: 'boolean', description: 'Capture the page after clicking.' },
          full_page: { type: 'boolean', description: 'With screenshot=true, capture the whole page.' },
        },
        required: ['selector'],
        additionalProperties: false,
      },
      output: output((value) => lines(
        `clicked ${value.clicked}${value.label === '' ? '' : ` (${value.label})`}`,
        pageTail(value),
        shotLine(value.shot),
      ), (value) => value.shot?.attachment),
      timeoutMs: budget(config.actionTimeoutMs),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const tool = 'browser_click'
        const selector = requireString(tool, args, 'selector')
        const button = optionalString(tool, args, 'button') ?? 'left'
        if (!['left', 'right', 'middle'].includes(button)) {
          throw new ToolInputError(tool, '"button" must be left, right, or middle')
        }
        const clickCount = optionalInteger(tool, args, 'click_count', 1, 1, 3)
        const tab = await manager.ensureTab()
        const target = await manager.locate(tab, selector)
        await manager.clickAt(tab, target.x, target.y, { button, clickCount })
        await manager.settle(tab, 250)
        const facts = await tab.describe()
        const shot = await maybeCapture(tab, args, tool)
        if (shot !== null) await attach(exec, shot)
        return {
          clicked: selector,
          label: target.label,
          url: facts.url,
          title: facts.title,
          tabId: tab.targetId,
          shot,
        }
      },
    },

    {
      name: 'browser_type',
      description:
        'Type text into an input, textarea, or contenteditable element. Focuses the element first when a selector is given. Set clear=true to replace existing content, and submit=true to press Enter afterwards — useful for search boxes and forms.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to type.' },
          selector: { type: 'string', description: 'CSS selector of the field; omit to type into whatever has focus.' },
          clear: { type: 'boolean', description: 'Clear the field before typing.' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
          screenshot: { type: 'boolean', description: 'Capture the page after typing.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: output((value) => lines(
        `typed into ${value.selector ?? 'the focused element'}${value.submitted ? ' and pressed Enter' : ''}`,
        `field now contains: ${show(value.fieldValue)}`,
        pageTail(value),
        shotLine(value.shot),
      ), (value) => value.shot?.attachment),
      timeoutMs: budget(config.actionTimeoutMs),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const tool = 'browser_type'
        const value = requireString(tool, args, 'text')
        const selector = optionalString(tool, args, 'selector')
        const tab = await manager.ensureTab()
        const result = await manager.typeText(tab, {
          text: value,
          selector,
          clear: optionalBoolean(tool, args, 'clear', false),
          submit: optionalBoolean(tool, args, 'submit', false),
        })
        await manager.settle(tab, 250)
        const facts = await tab.describe()
        const shot = await maybeCapture(tab, args, tool)
        if (shot !== null) await attach(exec, shot)
        return {
          typed: value,
          selector: selector ?? null,
          fieldValue: result.fieldValue,
          submitted: result.submitted,
          url: facts.url,
          title: facts.title,
          tabId: tab.targetId,
          shot,
        }
      },
    },

    {
      name: 'browser_eval',
      description:
        'Evaluate a JavaScript expression in the page and return its value as JSON. Runs in the page context, so it can read and modify the live DOM. Use it for facts the other tools do not expose: computed styles, element counts, or the result of a fetch. The source is evaluated as an expression, not a statement block.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'A JavaScript expression, e.g. "document.querySelectorAll(\'a\').length".' },
        },
        required: ['expression'],
        additionalProperties: false,
      },
      output: output((value) => lines(
        `result (${value.resultType}):`,
        typeof value.result === 'string' ? value.result : JSON.stringify(value.result, null, 2),
      )),
      timeoutMs: budget(config.actionTimeoutMs),
      isConcurrencySafe: () => true,
      async execute(args) {
        const expression = requireString('browser_eval', args, 'expression')
        const tab = await manager.ensureTab()
        const result = await evaluate(tab, expression)
        return {
          result: result === undefined ? null : result,
          resultType: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
          url: (await tab.describe()).url,
        }
      },
    },

    {
      name: 'browser_console',
      description:
        'Read what the page logged since the last navigation: console output, uncaught exceptions, HTTP responses with status 400 or higher, and failed network requests. This is how a broken page explains itself without a screenshot. Pass clear=true to empty the buffers after reading them.',
      parameters: {
        type: 'object',
        properties: {
          clear: { type: 'boolean', description: 'Empty the buffers after reading them.' },
          limit: { type: 'integer', description: 'Maximum entries per category; defaults to 50.' },
        },
        additionalProperties: false,
      },
      output: output((value) => {
        const parts = [pageTail(value)]
        if (value.console.length === 0 && value.httpErrors.length === 0 && value.requestFailures.length === 0) {
          parts.push('nothing logged since the last navigation')
        }
        for (const entry of value.console) parts.push(`[console:${entry.type}] ${entry.text}`)
        for (const entry of value.httpErrors) parts.push(`[http ${entry.status}] ${entry.url}`)
        for (const entry of value.requestFailures) parts.push(`[request failed: ${entry.error}] ${entry.url}`)
        return lines(...parts)
      }),
      timeoutMs: budget(config.actionTimeoutMs),
      isConcurrencySafe: () => true,
      async execute(args) {
        const tool = 'browser_console'
        const limit = optionalInteger(tool, args, 'limit', 50, 1, 200)
        const tab = await manager.ensureTab()
        const drained = {
          console: tab.console.slice(-limit).map((entry) => ({ type: entry.type, text: entry.text })),
          httpErrors: tab.httpErrors.slice(-limit).map((entry) => ({ status: entry.status, url: entry.url })),
          requestFailures: tab.requestFailures.slice(-limit).map((entry) => ({ url: entry.url, error: entry.error })),
        }
        if (optionalBoolean(tool, args, 'clear', false)) tab.resetStreams()
        const facts = await tab.describe()
        return { ...drained, url: facts.url, title: facts.title }
      },
    },

    {
      name: 'browser_tabs',
      description:
        'List, open, switch, or close browser tabs. Every other tool acts on the ACTIVE tab, so switch before interacting with a page opened in the background. Closing the last remaining tab is refused.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'new', 'select', 'close'], description: 'What to do.' },
          url: { type: 'string', description: 'For action=new, the URL to open.' },
          tab_id: { type: 'string', description: 'For action=select or close, a target id from a previous list.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: output((value) => lines(
        `action: ${value.action}`,
        ...value.tabs.map((tab) => `${tab.active ? '*' : ' '} ${tab.targetId}  ${tab.title === '' ? '(untitled)' : tab.title}  ${tab.url}`),
      )),
      timeoutMs: budget(config.actionTimeoutMs),
      isConcurrencySafe: () => false,
      async execute(args) {
        const tool = 'browser_tabs'
        const action = requireString(tool, args, 'action')
        if (!['list', 'new', 'select', 'close'].includes(action)) {
          throw new ToolInputError(tool, '"action" must be list, new, select, or close')
        }
        if (action === 'new') {
          await manager.newTab(optionalString(tool, args, 'url') ?? 'about:blank')
        } else if (action === 'select' || action === 'close') {
          const tabId = requireString(tool, args, 'tab_id')
          if (action === 'select') await manager.selectTab(tabId)
          else await manager.closeTab(tabId)
        }
        return {
          action,
          activeTabId: manager.activeTabId,
          tabs: (await manager.listTabs()).slice(0, config.maxTabs),
        }
      },
    },

    {
      name: 'browser_wait_for',
      description:
        'Wait until a condition becomes true in the active tab: an element appears, the page text contains a string, or the URL contains a substring. Use this instead of a fixed delay after an action that triggers asynchronous work.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Wait until an element matching this selector exists and is visible.' },
          text: { type: 'string', description: 'Wait until the page text contains this string.' },
          url_contains: { type: 'string', description: 'Wait until the URL contains this substring.' },
          timeout_ms: { type: 'integer', description: 'Give up after this many milliseconds.' },
        },
        additionalProperties: false,
      },
      output: output((value) => lines(
        value.matched
          ? `condition met after ${value.waitedMs}ms: ${value.condition}`
          : `timed out after ${value.waitedMs}ms waiting for: ${value.condition}`,
        `observed: ${value.observed}`,
      )),
      timeoutMs: budget(config.waitTimeoutMs),
      isConcurrencySafe: () => true,
      async execute(args) {
        const tool = 'browser_wait_for'
        const selector = optionalString(tool, args, 'selector')
        const needle = optionalString(tool, args, 'text')
        const urlContains = optionalString(tool, args, 'url_contains')
        if (selector === undefined && needle === undefined && urlContains === undefined) {
          throw new ToolInputError(tool, 'provide at least one of "selector", "text", or "url_contains"')
        }
        const timeoutMs = optionalInteger(tool, args, 'timeout_ms', config.waitTimeoutMs, 100, 120000)
        const tab = await manager.ensureTab()
        return await manager.waitFor(tab, { selector, text: needle, urlContains, timeoutMs })
      },
    },

    {
      name: 'browser_upload',
      description:
        'Attach local files to a file input, as if the user had picked them in a file chooser. Paths must be absolute. The input is matched by CSS selector and must be an <input type="file">.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the file input.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files to attach.' },
        },
        required: ['selector', 'files'],
        additionalProperties: false,
      },
      output: output((value) => lines(
        `attached ${value.count} file(s) to ${value.selector}: ${value.files.join(', ')}`,
        pageTail(value),
      )),
      timeoutMs: budget(config.actionTimeoutMs),
      isConcurrencySafe: () => false,
      async execute(args) {
        const tool = 'browser_upload'
        const selector = requireString(tool, args, 'selector')
        const files = optionalStringArray(tool, args, 'files')
        if (files === undefined || files.length === 0) {
          throw new ToolInputError(tool, '"files" must list at least one absolute path')
        }
        const tab = await manager.ensureTab()
        await manager.uploadFiles(tab, selector, files)
        return { selector, files, count: files.length, url: (await tab.describe()).url }
      },
    },

    {
      name: 'browser_scroll',
      description:
        'Scroll the page, either to an element or by a pixel delta. Scrolling matters because a screenshot only shows the viewport, and lazy-loaded content may only appear once it is scrolled near.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Scroll this element into view.' },
          delta_y: { type: 'integer', description: 'Vertical pixels to scroll; positive scrolls down.' },
          position: { type: 'string', enum: ['top', 'bottom'], description: 'Jump to the top or the bottom of the page.' },
          screenshot: { type: 'boolean', description: 'Capture the page after scrolling.' },
        },
        additionalProperties: false,
      },
      output: output((value) => lines(
        `scrolled ${value.target}; scrollY=${value.scrollY} of ${value.scrollHeight} (viewport ${value.viewportHeight})`,
        shotLine(value.shot),
      ), (value) => value.shot?.attachment),
      timeoutMs: budget(config.actionTimeoutMs),
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const tool = 'browser_scroll'
        const selector = optionalString(tool, args, 'selector')
        const deltaY = optionalInteger(tool, args, 'delta_y', 0, -100000, 100000)
        const position = optionalString(tool, args, 'position')
        if (position !== undefined && !['top', 'bottom'].includes(position)) {
          throw new ToolInputError(tool, '"position" must be top or bottom')
        }
        if (selector === undefined && deltaY === 0 && position === undefined) {
          throw new ToolInputError(tool, 'provide "selector", a non-zero "delta_y", or "position"')
        }
        const tab = await manager.ensureTab()
        const state = await manager.scroll(tab, { selector, deltaY, position })
        await manager.settle(tab, 200)
        const shot = await maybeCapture(tab, args, tool)
        if (shot !== null) await attach(exec, shot)
        return { ...state, shot }
      },
    },
  ]
}
