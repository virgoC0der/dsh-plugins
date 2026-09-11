// Capture the real GUI as a PNG so a design can be judged by looking at it
// rather than by reasoning about CSS. Also used to check the plugin's own
// glyphs in isolation (@glyphs mode).
//
// Usage:
//   node scripts/screenshot.mjs <out.png> [panel|new|none] [url]
//   node scripts/screenshot.mjs <out.png> glyphs
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = process.argv[2] ?? '/tmp/workboard.png'
const MODE = process.argv[3] ?? 'panel'
const URL_TO_OPEN = process.argv[4] ?? 'http://127.0.0.1:3080'
const PORT = 9339
const PROFILE = join(tmpdir(), 'dsh-wb-shot-profile')
const BINARY = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)
if (!existsSync(BINARY)) {
  console.error('chrome binary not found at ' + BINARY)
  process.exit(1)
}
rmSync(PROFILE, { recursive: true, force: true })

/** In glyphs mode, render the plugin's own stylesheet + icon markup only. */
function glyphPage() {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const start = source.indexOf('var CSS = [')
  const end = source.indexOf('].join("\\n")', start)
  const parts = [...source.slice(start + 'var CSS = ['.length, end).matchAll(/"((?:[^"\\]|\\.)*)"/gu)]
    .map((match) => JSON.parse('"' + match[1] + '"'))
  // Reuse the shipped glyph builders by evaluating the bundle's own source
  // slice for them is fragile; inline the same markup the components emit.
  const icons = [
    ['GitHub', source.match(/const GITHUB_MARK = `([\s\S]*?)`/u)?.[1] ?? ''],
    ['Jira', source.match(/const JIRA_MARK = `([\s\S]*?)`/u)?.[1] ?? ''],
    ['Calendar', source.match(/const CALENDAR_MARK = `([\s\S]*?)`/u)?.[1] ?? ''],
    ['Git', source.match(/const GIT_MARK = `([\s\S]*?)`/u)?.[1] ?? ''],
    ['Board (button)', source.match(/const BOARD_MARK = `([\s\S]*?)`/u)?.[1] ?? ''],
  ]
  return `<!doctype html><html><head><meta charset="utf-8"><style>${parts.join('\n')}
    body{margin:0;padding:28px;background:#fff;font:13px/1.5 -apple-system,system-ui,sans-serif;color:#1f2329}
    .row{display:flex;align-items:center;gap:14px;padding:12px 0;border-bottom:1px solid #eceff2}
    .name{width:140px;color:#8f959e}
    .chip{display:inline-flex;align-items:center;gap:6px;font-weight:600}
    .dark{background:#1f2329;color:#fff;padding:18px;border-radius:12px;margin-top:18px}
  </style></head><body>
    <h3>Section glyphs</h3>
    ${icons.map(([name, svg]) => `<div class="row"><span class="name">${name}</span><span class="chip">${svg}</span></div>`).join('')}
    <div class="dark"><div class="row" style="border-color:#3a3f45"><span class="name" style="color:#9aa1a9">on dark</span>${icons.map(([, svg]) => `<span class="chip">${svg}</span>`).join('')}</div></div>
  </body></html>`
}

const chrome = spawn(
  BINARY,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars=false',
    '--window-size=1440,900',
    '--force-device-scale-factor=2',
    '--remote-debugging-port=' + String(PORT),
    '--user-data-dir=' + PROFILE,
    MODE === 'glyphs' ? 'about:blank' : URL_TO_OPEN,
  ],
  { stdio: 'ignore' },
)

async function pageTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:' + String(PORT) + '/json/list')
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page !== undefined) return page
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('no DevTools page target appeared')
}

function cdp(ws) {
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const settle = pending.get(message.id)
    if (settle === undefined) return
    pending.delete(message.id)
    if (message.error) settle.reject(new Error(JSON.stringify(message.error)))
    else settle.resolve(message.result)
  })
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
}

let ws
try {
  const target = await pageTarget()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const send = cdp(ws)
  await send('Runtime.enable')
  await send('Page.enable')
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return result.result.value
  }

  if (MODE === 'glyphs') {
    await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(glyphPage()) })
    await new Promise((resolve) => setTimeout(resolve, 1200))
  } else {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (await evaluate(`document.querySelector('.dswb-fab') !== null`)) break
    }
    if (MODE === 'new') {
      await evaluate(`[...document.querySelectorAll('button')].find(el => (el.getAttribute('aria-label')||'').includes('新建会话'))?.click()`)
      await new Promise((resolve) => setTimeout(resolve, 6000))
    } else if (MODE === 'panel') {
      await evaluate(`document.querySelector('.dswb-fab').click()`)
      await new Promise((resolve) => setTimeout(resolve, 6000))
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log('wrote ' + OUT)
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  chrome.kill('SIGKILL')
}
