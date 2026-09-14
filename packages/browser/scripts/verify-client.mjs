// Verify the client bundle without a browser.
//
// The client half is a browser bundle, but the part of it that can be wrong in
// a way a page load would merely hide — the module registration, the exported
// plugin shape, and which keys it claims in `tool.call.toolview` — is plain
// JavaScript. Loading the bundle against stubs catches those before a restart.
//
// What this does NOT prove: that the components render. Only a real shell can
// show that, which is what scripts/verify-gui.mjs is for.
//
// Usage: node scripts/verify-client.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const results = []
/** Record one assertion. */
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '  — ' + detail))
}

// --- a stand-in module loader and module table ------------------------------
let loaded = null
const reactStub = {
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  createElement: () => null,
}
const jsxStub = () => null
const moduleTable = {
  react: reactStub,
  'react/jsx-runtime': Object.assign(jsxStub, { jsx: jsxStub, jsxs: jsxStub, Fragment: null }),
}

globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => {
      loaded = spec
    },
  },
}

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))
await import(clientPath)
check('client.js registers itself with the module loader', loaded !== null && typeof loaded.factory === 'function',
  loaded === null ? 'nothing was loaded' : `id=${loaded.id}`)
check('the module id matches the package name', loaded?.id === 'dsh-browser', String(loaded?.id))

// --- run the factory --------------------------------------------------------
const moduleExports = loaded.factory((spec) => {
  if (moduleTable[spec] !== undefined) return moduleTable[spec]
  throw new Error(`the bundle required an unexpected module: ${spec}`)
})
check('the factory exports a cordis plugin shape',
  typeof moduleExports.apply === 'function' && Array.isArray(moduleExports.inject) && typeof moduleExports.name === 'string',
  `name=${moduleExports.name} inject=${JSON.stringify(moduleExports.inject)}`)
check('the plugin declares the slot registry as its only requirement',
  moduleExports.inject.length === 1 && moduleExports.inject[0] === 'slots', JSON.stringify(moduleExports.inject))

// --- run apply() against a stand-in slot registry ---------------------------
const registrations = []
const injected = []
const effects = []
const ctx = {
  effect: (callback, label) => {
    const dispose = callback()
    effects.push({ label, dispose })
    return dispose
  },
  slots: {
    inject: (slot, callback) => {
      injected.push(slot)
      const produced = callback()
      registrations.push(...(Array.isArray(produced) ? produced : [produced]))
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

moduleExports.apply(ctx)

check('apply() waits for the tool view slot declaration',
  injected.length === 1 && injected[0] === 'tool.call.toolview', JSON.stringify(injected))
check('apply() installs a stylesheet effect', effects.length === 1, effects[0]?.label ?? 'none')

const entries = registrations.filter((entry) => entry.options !== undefined)
const keys = entries.map((entry) => entry.options.key).sort()
const expected = [
  'browser_click', 'browser_console', 'browser_eval', 'browser_navigate', 'browser_screenshot',
  'browser_scroll', 'browser_tabs', 'browser_type', 'browser_upload', 'browser_wait_for',
]
check('apply() claims exactly this plugin\'s ten tool names',
  JSON.stringify(keys) === JSON.stringify(expected), keys.join(', '))
check('every registration targets the keyed tool view slot and passes a component',
  entries.every((entry) => entry.options.name === 'tool.call.toolview' && typeof entry.component === 'function'),
  `${entries.length} entries`)
// A key the shipped composition already occupies cannot be claimed at the same
// priority; none of these names is a shipped tool, so a collision would mean a
// name was chosen badly.
const SHIPPED = ['ask_user_question', 'bash', 'edit', 'write', 'read', 'read_image', 'grep', 'glob',
  'todo_write', 'web_search', 'web_fetch', 'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine',
  'present', 'skill']
const collisions = keys.filter((key) => SHIPPED.includes(key))
check('no key collides with a shipped tool view', collisions.length === 0, collisions.join(', ') || 'none')

// --- component behaviour on the shapes the runtime hands it -----------------
const component = entries[0]?.component
const rendered = []
const renderStub = (type, props) => {
  rendered.push({ type, props })
  return null
}
// The component uses the automatic JSX runtime, which the stub above returns
// null for; rendering is exercised here only for its side effect of not
// throwing on real block shapes.
try {
  component({ toolName: 'browser_screenshot', block: { kind: 'tool-result', callId: 'x', content: [], isError: false, meta: { id: 'a', url: '/browser/shot/a', width: 10, height: 10 } }, callId: 'x' })
  component({ toolName: 'browser_navigate', block: { callId: 'y', name: 'browser_navigate', argsRaw: '{"url":"https://example.com"}', turn: 1, step: 1, time: 0, subCalls: [] }, callId: 'y' })
  component({ toolName: 'browser_click', block: { kind: 'tool-result', callId: 'z', call: { name: 'browser_click', argsRaw: 'not json' }, content: [], isError: true, meta: null } })
  check('the card component survives settled, running, and malformed blocks', true)
} catch (error) {
  check('the card component survives settled, running, and malformed blocks', false, error.message)
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) console.log('failed: ' + failed.map((result) => result.label).join(' | '))
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1)
