/**
 * dsh-browser — client half.
 *
 * Renders this plugin's own tool calls inside the conversation through the
 * keyed `tool.call.toolview` slot: one card per browser tool, with the captured
 * screenshot inline for the calls that took one.
 *
 * Three facts about DSH 0.1.5 shape this file, all verified against the
 * installed packages rather than assumed:
 *
 * 1. The slot is declared by `dsh-client-ui-tool`'s `tool-call` chat node, not
 *    by the shell, so registration must ride `ctx.slots.inject` and wait for
 *    that declaration. Registering into an undeclared slot throws.
 * 2. Dispatch is `{ entryKey: <wire tool name> }`, and a key the shipped
 *    composition already occupies cannot simply be taken over: registering the
 *    same key at the same priority (0) throws at load. Every key registered
 *    here is this plugin's own tool name, so each lands in an empty cell.
 * 3. The built-in web client ignores a tool's `presentCall`/`presentResult`.
 *    The card is derived from the raw arguments, the result content, the
 *    failure state, and `ToolResultNode.meta` — which is exactly where this
 *    plugin's `presentationMeta` lands, so the shot id is read from there and
 *    the image is loaded from the plugin's own same-origin route.
 *
 * Screenshots are served by the host half at `/browser/shot/<id>`; using that
 * route instead of resolving the durable attachment keeps the view working
 * when the current model is text-only and no attachment was ever created.
 */
window.__ModuleLoader__.load({
  id: 'dsh-browser',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var jsxRuntime = require('react/jsx-runtime')
    var jsx = jsxRuntime.jsx
    var jsxs = jsxRuntime.jsxs
    var Fragment = jsxRuntime.Fragment

    //#region styles
    /**
     * Card styles. Every selector is prefixed `dshb-` so nothing leaks into the
     * shell, and the palette follows the harness theme variables when they
     * exist so the card reads correctly on light and dark backgrounds.
     */
    var CSS = [
      '.dshb-card{border:1px solid var(--dsh-border-weak,#e5e7eb);border-radius:10px;background:var(--dsh-surface,#fff);overflow:hidden;font-size:13px;line-height:1.5}',
      '.dshb-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsh-border-weak,#eef0f3)}',
      '.dshb-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#22c55e}',
      '.dshb-dot[data-state="running"]{background:#f59e0b}',
      '.dshb-dot[data-state="error"]{background:#ef4444}',
      '.dshb-name{font-weight:600;letter-spacing:-0.01em}',
      '.dshb-target{color:var(--dsh-text-weak,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.dshb-body{padding:10px 12px;white-space:pre-wrap;word-break:break-word;font-family:var(--dsh-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsh-text-weak,#4b5563)}',
      '.dshb-shot{display:block;border-top:1px solid var(--dsh-border-weak,#eef0f3);background:#0f1115}',
      '.dshb-shot img{display:block;width:100%;height:auto;max-height:520px;object-fit:contain;object-position:top left;cursor:zoom-in}',
      '.dshb-shot-foot{display:flex;align-items:center;gap:10px;padding:6px 12px;border-top:1px solid var(--dsh-border-weak,#eef0f3);font-size:11px;color:var(--dsh-text-weak,#6b7280)}',
      '.dshb-shot-foot a{color:inherit}',
      '.dshb-fail{color:#b91c1c}',
      '.dshb-empty{padding:10px 12px;color:var(--dsh-text-weak,#6b7280)}',
    ].join('\n')
    //#endregion

    //#region data
    /** Human labels per wire tool name. */
    var LABELS = {
      browser_navigate: 'Navigate',
      browser_screenshot: 'Screenshot',
      browser_click: 'Click',
      browser_type: 'Type',
      browser_eval: 'Evaluate',
      browser_console: 'Console',
      browser_tabs: 'Tabs',
      browser_wait_for: 'Wait',
      browser_upload: 'Upload',
      browser_scroll: 'Scroll',
    }

    /** Tools whose result may carry a screenshot. */
    var TOOLS = Object.keys(LABELS)

    /** Whether a block is the settled result of a call. */
    function isSettled(block) {
      return block !== null && typeof block === 'object' && block.kind === 'tool-result'
    }

    /**
     * The raw JSON arguments of a call, in either the running or settled form.
     *
     * A settled node's `call` head is documented as `null` when log-window
     * truncation left it outside the window, but a missing field has been seen
     * too, so both are treated as absent — a card must render rather than throw.
     */
    function argsOf(block) {
      var settled = isSettled(block)
      var head = settled ? block.call : undefined
      var raw = settled
        ? (head === null || head === undefined ? null : head.argsRaw)
        : block.argsRaw
      if (typeof raw !== 'string' || raw === '') return {}
      try {
        var parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch (error) {
        return {}
      }
    }

    /** The text projection of a settled result. */
    function textOf(block) {
      if (!isSettled(block) || !Array.isArray(block.content)) return null
      var parts = []
      for (var index = 0; index < block.content.length; index += 1) {
        var item = block.content[index]
        if (item !== null && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
          parts.push(item.text)
        }
      }
      return parts.length === 0 ? null : parts.join('\n')
    }

    /**
     * The screenshot this call produced, read from the persisted presentation
     * metadata. `presentationMeta` projects the tool's canonical value, so the
     * shot is either the value itself (screenshot) or its `shot` field.
     */
    function shotOf(block) {
      if (!isSettled(block)) return null
      var meta = block.meta
      if (meta === null || typeof meta !== 'object') return null
      var candidate = typeof meta.id === 'string' && typeof meta.url === 'string' ? meta : meta.shot
      if (candidate === null || typeof candidate !== 'object') return null
      if (typeof candidate.id !== 'string' || typeof candidate.url !== 'string') return null
      return candidate
    }

    /** What the card header shows beside the tool label. */
    function targetOf(toolName, args) {
      if (typeof args.url === 'string') return args.url
      if (typeof args.selector === 'string') return args.selector
      if (typeof args.expression === 'string') return args.expression.slice(0, 80)
      if (typeof args.text === 'string') return JSON.stringify(args.text).slice(0, 60)
      if (typeof args.action === 'string') return args.action
      return ''
    }
    //#endregion

    //#region components
    /**
     * The screenshot, loaded lazily from this plugin's own route. The captured
     * state is shown while the bytes arrive so a slow read never looks empty.
     */
    function Shot(props) {
      var state = React.useState('loading')
      var status = state[0]
      var setStatus = state[1]
      var shot = props.shot
      return jsxs('div', {
        className: 'dshb-shot',
        children: [
          jsx('img', {
            src: shot.url,
            alt: 'Screenshot of ' + String(shot.pageUrl === undefined ? '' : shot.pageUrl),
            loading: 'lazy',
            onClick: function () { window.open(shot.url, '_blank', 'noopener') },
            onLoad: function () { setStatus('ready') },
            onError: function () { setStatus('failed') },
          }),
          jsxs('div', {
            className: 'dshb-shot-foot',
            children: [
              jsx('span', { children: status === 'failed' ? 'preview unavailable' : String(shot.width) + '×' + String(shot.height) }),
              shot.fullPage === true ? jsx('span', { children: 'full page' }) : null,
              typeof shot.pageUrl === 'string' && shot.pageUrl !== '' ? jsx('span', { className: 'dshb-target', children: shot.pageUrl }) : null,
              jsx('a', { href: shot.url, target: '_blank', rel: 'noreferrer', children: 'open original' }),
            ],
          }),
        ],
      })
    }

    /**
     * One browser tool call. The settled form shows the model-facing text (so
     * the human reads exactly what the model read) plus the screenshot when one
     * was taken; the running form shows what the call is about to do.
     */
    function BrowserCall(props) {
      var toolName = props.toolName
      var block = props.block
      var settled = isSettled(block)
      var failed = settled && block.isError === true
      var args = argsOf(block)
      var shot = shotOf(block)
      var body = textOf(block)
      var target = targetOf(toolName, args)
      return jsxs('div', {
        className: 'dshb-card',
        children: [
          jsxs('div', {
            className: 'dshb-head',
            children: [
              jsx('span', {
                className: 'dshb-dot',
                'data-state': failed ? 'error' : settled ? 'ok' : 'running',
              }),
              jsx('span', { className: 'dshb-name', children: LABELS[toolName] === undefined ? toolName : LABELS[toolName] }),
              target === '' ? null : jsx('span', { className: 'dshb-target', title: target, children: target }),
            ],
          }),
          body === null
            ? jsx('div', { className: 'dshb-empty', children: settled ? 'no text reported' : 'running…' })
            : jsx('div', { className: 'dshb-body' + (failed ? ' dshb-fail' : ''), children: body }),
          shot === null ? null : jsx(Shot, { shot: shot }),
        ],
      })
    }
    //#endregion

    //#region plugin
    /** Stable plugin name. */
    var name = 'dsh-browser'

    /** Required client service: the slot registry. */
    var inject = ['slots']

    /**
     * Register this plugin's tool views into the keyed Tool view slot.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(function () {
        if (typeof document === 'undefined') return undefined
        var tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-browser'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return function () { tag.remove() }
      }, 'dsh-browser: styles')

      // The slot belongs to ui-tool's chat-node entry, so the registration waits
      // for that declaration instead of racing it.
      ctx.slots.inject('tool.call.toolview', function () {
        return TOOLS.map(function (key) {
          return ctx.slots.register({ name: 'tool.call.toolview', key: key }, BrowserCall)
        })
      })
    }
    //#endregion

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
