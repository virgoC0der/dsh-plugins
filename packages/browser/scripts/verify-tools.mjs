// Verify the host half — the tool layer and the CDP layer under it — without
// DSH in the loop.
//
// The plugin's host half imports nothing but Node builtins, so it can be driven
// directly: a stand-in cordis context registers the tools, a stand-in execution
// context pretends to be a model route, and every tool is then asked to do real
// work against a real local page in a real Chrome. Assertions read the page
// back rather than trusting that a CDP call which did not throw actually
// worked.
//
// Two things this proves that a unit test could not: that each tool's canonical
// value survives `output.render`, and that the capability-aware image
// attachment produces the ImageBlock the model needs — and stays silent when
// the route is text-only.
//
// Usage: node scripts/verify-tools.mjs
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resolveConfig, STATE_DIR } from '../index.js'
import { BrowserError } from '../lib/cdp.js'
import { ToolInputError } from '../lib/tools.js'

const results = []
/** Record one assertion. */
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '  — ' + detail))
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Browser verification</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif}#tall{height:3000px}
#late{display:none}</style></head><body>
<h1 id="heading">verification page</h1>
<input id="field" type="text" placeholder="type here">
<textarea id="area"></textarea>
<button id="go">go</button>
<div id="out">idle</div>
<input id="file" type="file">
<div id="late">appeared late</div>
<div id="tall"></div>
<script>
  console.log('page script ran');
  document.getElementById('go').addEventListener('click', () => {
    document.getElementById('out').textContent = 'clicked';
    console.log('button clicked');
  });
  document.getElementById('field').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { document.getElementById('out').textContent = 'submitted'; }
  });
  setTimeout(() => { document.getElementById('late').style.display = 'block'; }, 600);
  fetch('/missing-resource').catch(() => {});
</script></body></html>`

/** A tiny origin to drive the browser against, with one deliberate 404. */
function startServer() {
  const server = createServer((req, res) => {
    if (req.url === '/missing-resource') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** A stand-in cordis context: enough surface for `apply` to run for real. */
function fakeContext(services) {
  const registered = []
  const disposers = []
  return {
    registered,
    disposers,
    get: (serviceName) => services[serviceName],
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    webServer: { register: (route) => { registered.push(route); return () => {} } },
  }
}

/** A stand-in execution context for one route: image-capable or text-only. */
function fakeExec({ provider = 'test', model = 'vision', imageInput = true } = {}) {
  return {
    agent: {
      session: { requestHeader: () => ({ config: { provider, model } }) },
      options: { provider, model },
    },
    signal: undefined,
    imageInput,
  }
}

const workdir = mkdtempSync(join(tmpdir(), 'dsh-browser-verify-'))
const { server, port } = await startServer()
const origin = `http://127.0.0.1:${port}/`

const config = resolveConfig({
  headless: true,
  // The shell running this script is sandboxed; see scripts/cdp-smoke.mjs.
  chromeFlags: ['--no-sandbox', '--disable-crashpad', '--disable-dev-shm-usage'],
  windowWidth: 1000,
  windowHeight: 800,
  idleShutdownMs: 0,
  navigationTimeoutMs: 15000,
  actionTimeoutMs: 10000,
  waitTimeoutMs: 8000,
  stateDir: workdir,
})

const saved = []
const attachments = {
  saveImage: async (input) => {
    saved.push(input)
    return { attachmentId: `attachment-${saved.length}`, mediaType: input.mediaType, bytes: input.data.length, width: 1000, height: 800, name: input.name }
  },
}
const llm = {
  resolveModelInfo: async (provider, model) => ({
    provider,
    id: model,
    inputModalities: model === 'text-only' ? ['text'] : ['text', 'image'],
  }),
}

const ctx = fakeContext({ attachments, llm })
try {
  apply(ctx, config)
} catch (error) {
  console.error('apply() threw: ' + error.message)
  process.exit(1)
}

const tools = new Map(ctx.registered.filter((entry) => typeof entry.execute === 'function').map((entry) => [entry.name, entry]))
const routes = ctx.registered.filter((entry) => typeof entry.handler === 'function')

check('apply() registered every tool', tools.size === 10, `${tools.size} tools`)
check('apply() registered the shot and state routes', routes.length === 3,
  routes.map((route) => `${route.kind}:${route.path}`).join(', '))

/** Call one tool and return its canonical value. */
async function call(name, args, exec = fakeExec()) {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no such tool: ${name}`)
  return await tool.execute(args, exec)
}

/** Render a tool's value the way the registry will, and return the blocks. */
function render(name, args, value) {
  return tools.get(name).output.render(args, value)
}

const blocksOf = (name, args, value) => render(name, args, value)
const textOf = (blocks) => blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
const imageOf = (blocks) => blocks.find((block) => block.type === 'image')

try {
  // ---------------------------------------------------------------- navigate
  const navigated = await call('browser_navigate', { url: origin })
  check('browser_navigate loads the page', navigated.title === 'Browser verification' && navigated.readyState === 'complete',
    `title=${JSON.stringify(navigated.title)} readyState=${navigated.readyState}`)
  const navigateText = textOf(blocksOf('browser_navigate', { url: origin }, navigated))
  check('browser_navigate renders a readable report', navigateText.includes('loaded ' + origin), JSON.stringify(navigateText.split('\n')[0]))

  // -------------------------------------------------------------------- eval
  // The page has exactly two <input> elements (one text field, one file
  // picker); the <textarea> is not one of them.
  const evaluated = await call('browser_eval', { expression: 'document.querySelectorAll("input").length' })
  check('browser_eval returns a JSON value', evaluated.result === 2 && evaluated.resultType === 'number',
    `result=${JSON.stringify(evaluated.result)} type=${evaluated.resultType}`)

  // ------------------------------------------------------------------- click
  await call('browser_click', { selector: '#go' })
  const afterClick = await call('browser_eval', { expression: 'document.getElementById("out").textContent' })
  check('browser_click drives a real click', afterClick.result === 'clicked', `out=${JSON.stringify(afterClick.result)}`)

  // -------------------------------------------------------------------- type
  const typed = await call('browser_type', { selector: '#field', text: 'hello world' })
  check('browser_type writes the field', typed.fieldValue === 'hello world', `fieldValue=${JSON.stringify(typed.fieldValue)}`)
  const submitted = await call('browser_type', { selector: '#field', text: 'again', clear: true, submit: true })
  const afterSubmit = await call('browser_eval', { expression: 'document.getElementById("out").textContent' })
  check('browser_type clear+submit replaces the value and presses Enter',
    submitted.fieldValue === 'again' && afterSubmit.result === 'submitted',
    `fieldValue=${JSON.stringify(submitted.fieldValue)} out=${JSON.stringify(afterSubmit.result)}`)

  // --------------------------------------------------------------- wait_for
  // Reload first: the page reveals #late 600ms after load, so waiting must
  // actually wait rather than find an element that appeared during earlier
  // checks.
  const beforeWait = Date.now()
  await call('browser_navigate', { url: origin })
  const waited = await call('browser_wait_for', { selector: '#late', timeout_ms: 5000 })
  const waitElapsed = Date.now() - beforeWait
  check('browser_wait_for sees a delayed element', waited.matched === true && waitElapsed > 400,
    `matched=${waited.matched} elapsed=${waitElapsed}ms reported=${waited.waitedMs}ms`)
  const waitedTooLong = await call('browser_wait_for', { text: 'this string never appears', timeout_ms: 700 })
  check('browser_wait_for times out without throwing', waitedTooLong.matched === false, `waitedMs=${waitedTooLong.waitedMs}`)

  // ------------------------------------------------------------------ scroll
  const scrolled = await call('browser_scroll', { delta_y: 500 })
  check('browser_scroll moves the page', scrolled.scrollY >= 400, `scrollY=${scrolled.scrollY}`)
  const bottom = await call('browser_scroll', { position: 'bottom' })
  check('browser_scroll reaches the bottom', bottom.scrollY + bottom.viewportHeight >= bottom.scrollHeight - 5,
    `scrollY=${bottom.scrollY} viewport=${bottom.viewportHeight} height=${bottom.scrollHeight}`)

  // ----------------------------------------------------------------- upload
  const uploadPath = join(workdir, 'upload-me.txt')
  writeFileSync(uploadPath, 'uploaded by the verification script\n')
  const uploaded = await call('browser_upload', { selector: '#file', files: [uploadPath] })
  const fileFacts = await call('browser_eval', {
    expression: 'JSON.stringify({count: document.getElementById("file").files.length, name: document.getElementById("file").files[0]?.name})',
  })
  check('browser_upload attaches a real file', uploaded.count === 1 && fileFacts.result.includes('upload-me.txt'), fileFacts.result)

  // ---------------------------------------------------------------- console
  const consoleDrain = await call('browser_console', {})
  const sawLog = consoleDrain.console.some((entry) => entry.text.includes('page script ran'))
  const saw404 = consoleDrain.httpErrors.some((entry) => entry.status === 404)
  check('browser_console reports console output and HTTP failures', sawLog && saw404,
    `console=${consoleDrain.console.length} httpErrors=${consoleDrain.httpErrors.length}`)

  // ------------------------------------------------------------------ tabs
  const before = await call('browser_tabs', { action: 'list' })
  const opened = await call('browser_tabs', { action: 'new', url: origin })
  check('browser_tabs opens and activates a tab',
    opened.tabs.length === before.tabs.length + 1 && opened.activeTabId !== null,
    `${before.tabs.length} → ${opened.tabs.length} tabs, active=${opened.activeTabId}`)
  const listed = await call('browser_tabs', { action: 'list' })
  const other = listed.tabs.find((tab) => tab.active !== true)
  await call('browser_tabs', { action: 'select', tab_id: other.targetId })
  const selected = await call('browser_tabs', { action: 'list' })
  check('browser_tabs switches the active tab', selected.tabs.find((tab) => tab.active).targetId === other.targetId)

  // -------------------------------------------------------------- screenshot
  const shot = await call('browser_screenshot', {}, fakeExec({ model: 'vision' }))
  const onDisk = readFileSync(shot.path)
  const isPng = onDisk.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  check('browser_screenshot stores a real PNG', isPng && shot.bytes > 1000 && shot.width > 0,
    `${shot.width}x${shot.height}, ${shot.bytes} bytes`)
  check('browser_screenshot exposes its route', shot.url === `/browser/shot/${shot.id}` && existsSync(shot.path), shot.url)
  const shotBlocks = blocksOf('browser_screenshot', {}, shot)
  const attached = imageOf(shotBlocks)
  check('an image-capable route receives an ImageBlock',
    attached !== undefined && attached.attachment.mediaType === 'image/png',
    attached === undefined ? 'no image block' : `attachment=${attached.attachment.attachmentId} bytes=${attached.attachment.bytes}`)

  // A text-only route must NOT receive an image block — the DeepSeek adapter
  // rejects images for such a model, so this is a correctness requirement.
  saved.length = 0
  const textOnlyShot = await call('browser_screenshot', {}, fakeExec({ model: 'text-only' }))
  const textOnlyBlocks = blocksOf('browser_screenshot', {}, textOnlyShot)
  check('a text-only route receives text and no image',
    imageOf(textOnlyBlocks) === undefined && textOf(textOnlyBlocks).includes('image not attached'),
    `saved=${saved.length} note=${JSON.stringify(textOf(textOnlyBlocks).split('\n').pop())}`)

  // ------------------------------------------------------- presentation meta
  const meta = tools.get('browser_screenshot').output.presentationMeta({}, textOnlyShot)
  check('presentationMeta carries the shot id for the client view',
    meta !== null && typeof meta.id === 'string' && typeof meta.url === 'string',
    `id=${meta?.id} url=${meta?.url}`)

  // ------------------------------------------------------ argument rejection
  const rejected = []
  for (const [name, args] of [
    ['browser_navigate', {}],
    ['browser_click', {}],
    ['browser_type', {}],
    ['browser_eval', {}],
    ['browser_tabs', { action: 'explode' }],
    ['browser_wait_for', {}],
    ['browser_upload', { selector: '#file', files: [] }],
    ['browser_scroll', {}],
  ]) {
    try {
      await call(name, args)
      rejected.push(`${name}: accepted`)
    } catch (error) {
      if (!(error instanceof ToolInputError)) rejected.push(`${name}: ${error.name}`)
    }
  }
  check('invalid arguments are rejected with ToolInputError', rejected.length === 0, rejected.join('; '))

  // A missing element must fail loudly and precisely.
  let locateError = null
  try {
    await call('browser_click', { selector: '#does-not-exist' })
  } catch (error) {
    locateError = error
  }
  check('clicking a missing element fails with a clear error',
    locateError instanceof BrowserError && ['element-not-found', 'element-not-visible'].includes(locateError.code),
    locateError === null ? 'no error thrown' : `${locateError.code}: ${locateError.message}`)

  // ------------------------------------------------- rendering every result
  const renderFailures = []
  for (const [name, tool] of tools) {
    const args = { url: origin, selector: '#go', text: 'x', expression: '1', action: 'list', files: [uploadPath], delta_y: 10 }
    try {
      const value = { id: 'x', url: '/browser/shot/x', width: 1, height: 1, console: [], httpErrors: [], requestFailures: [], tabs: [], files: [], count: 0, result: 1, resultType: 'number', shot: null }
      const blocks = tool.output.render(args, value)
      if (!Array.isArray(blocks) || blocks.length === 0 || blocks[0].type !== 'text') {
        renderFailures.push(`${name}: ${JSON.stringify(blocks).slice(0, 60)}`)
      }
      if (tool.output.schema === undefined) renderFailures.push(`${name}: no output.schema`)
    } catch (error) {
      renderFailures.push(`${name}: threw ${error.message}`)
    }
  }
  check('every tool renders text and declares an output schema', renderFailures.length === 0, renderFailures.join('; '))
} catch (error) {
  // An abort is a failure: without this, a run that stopped halfway would
  // report every recorded check green and still exit 0.
  check('the verification run completed without aborting', false, error.message)
  console.error('\nVERIFICATION ABORTED: ' + (error.stack ?? error.message))
} finally {
  server.close()
  // Release the browser before deleting its profile: Chrome keeps writing to
  // its user-data directory until it has actually exited.
  for (const dispose of ctx.disposers ?? []) {
    try {
      dispose()
    } catch {
      /* teardown is best-effort */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
  rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) console.log('failed: ' + failed.map((result) => result.label).join(' | '))
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1)
