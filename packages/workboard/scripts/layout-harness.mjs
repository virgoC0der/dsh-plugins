// Layout harness: prove the board's scroll containers actually scroll.
//
// The homepage board only renders when the session list has settled with no
// current session, which a headless run cannot arrange reliably (the Harness
// restores the last session). So instead of driving the app, this harness
// extracts the REAL stylesheet out of client.js and mounts the REAL DOM
// structure the components emit, then measures it in a real browser over CDP.
//
// It therefore tests the actual CSS being shipped, not a copy of it.
//
// Usage: node scripts/layout-harness.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = 9334
const PROFILE = join(tmpdir(), 'dsh-wb-harness-profile')
const BINARY = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)

/** Pull the CSS array out of the shipped bundle, exactly as the plugin injects it. */
function extractCss() {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const start = source.indexOf('var CSS = [')
  const end = source.indexOf('].join("\\n")', start)
  if (start < 0 || end < 0) throw new Error('could not find the CSS array in client.js')
  const body = source.slice(start + 'var CSS = ['.length, end)
  const parts = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((match) =>
    JSON.parse('"' + match[1] + '"'),
  )
  let css = parts.join('\n')
  // HARNESS_STRETCH=1 reproduces the pre-fix behaviour (the flex default), which
  // is how the diagnosed root cause is proven rather than merely asserted.
  // The declaration must be swapped INSIDE the .dswb-hero block: appending a
  // second align-items would lose to the later declaration in the same block.
  if (process.env.HARNESS_STRETCH === '1') {
    css = css.replace(/\.dswb-hero\{[^}]*\}/u, (block) =>
      block.replace('align-items:flex-start', 'align-items:stretch'),
    )
  }
  return css
}

/** Reproduce the component tree: hero > inner > head + grid > cards > card-body > rows. */
function buildHtml(css) {
  const card = (title, rows, span2) => `
    <section class="dswb-card${span2 ? ' dswb-span2' : ''}">
      <header class="dswb-card-head"><span>${title}</span><span class="dswb-chip">${rows.length}</span><span class="dswb-chip" data-kind="ok">live</span></header>
      <div class="dswb-card-body">
        <div class="dswb-group">GROUP</div>
        <div class="dswb-rows">
          ${rows.map(() => `<div class="dswb-row"><span class="dswb-dot" data-tone="success"></span><div class="dswb-row-main"><span class="dswb-row-title">A representative row title that is long enough to occupy space</span><span class="dswb-row-sub">repo #123 · draft · 2h ago</span></div><span class="dswb-meta"><span>💬 3</span><span>✓ 1</span></span></div>`).join('')}
        </div>
      </div>
    </section>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}
    html,body{margin:0;height:100%}
    /* Stand in for the shell's frame + overlay layer, which is what the real
       board is mounted inside: position:relative + overflow:hidden. */
    .frame{position:relative;height:100%;overflow:hidden}
    .overlayLayer{position:absolute;inset:0;pointer-events:none}
    .dswb-hero-inner{pointer-events:auto}
  </style></head><body>
    <div class="frame"><div class="overlayLayer">
      <div class="dswb-hero"><div class="dswb-hero-inner">
        <header class="dswb-hero-head"><h2 class="dswb-hero-title">My work today</h2><span class="dswb-hero-sub">updated just now</span><span class="dswb-actions"><button class="dswb-iconbtn">↻</button></span></header>
        <div class="dswb-grid">
          ${card('GitHub pull requests', Array.from({ length: 14 }, () => 0), true)}
          ${card('Jira assigned to me', Array.from({ length: 12 }, () => 0), true)}
          ${card("Today's calendar", Array.from({ length: 8 }, () => 0), false)}
          ${card('Workspace git status', Array.from({ length: 6 }, () => 0), false)}
        </div>
        <div class="dswb-hero-sub">Sources: GitHub via gh · Jira REST · Google Calendar · local git</div>
      </div></div>
    </div></div>
  </body></html>`
}

const MEASURE = `(() => {
  const pick = (target) => {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (el === null || el === undefined) return null;
    const cs = getComputedStyle(el);
    return { scrollH: el.scrollHeight, clientH: el.clientHeight, overflowY: cs.overflowY, scrollable: el.scrollHeight > el.clientHeight + 1 };
  };
  const hero = document.querySelector('.dswb-hero');
  const out = {
    hero: pick('.dswb-hero'),
    heroInner: pick('.dswb-hero-inner'),
    body: pick('.dswb-body'),
    cardBodies: [...document.querySelectorAll('.dswb-card-body')].map(pick),
    rows: document.querySelectorAll('.dswb-row').length,
    viewport: { w: innerWidth, h: innerHeight },
  };
  // Drive the outer container and the first section, then read the offsets back:
  // a container that cannot scroll leaves scrollTop at 0.
  if (hero !== null) {
    hero.scrollTop = 100000;
    out.heroScrolledTo = Math.round(hero.scrollTop);
    hero.scrollTop = 0;
  }
  const firstBody = document.querySelector('.dswb-card-body');
  if (firstBody !== null) {
    firstBody.scrollTop = 100000;
    out.firstCardScrolledTo = Math.round(firstBody.scrollTop);
    firstBody.scrollTop = 0;
  }
  if (hero !== null) {
    const r = hero.getBoundingClientRect();
    out.heroBox = { top: Math.round(r.top), bottom: Math.round(r.bottom), viewportH: innerHeight };
  }
  return JSON.stringify(out, null, 1);
})()`

const css = extractCss()
const html = buildHtml(css)
rmSync(PROFILE, { recursive: true, force: true })

const chrome = spawn(
  BINARY,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    '--remote-debugging-port=' + String(PORT),
    '--user-data-dir=' + PROFILE,
    'about:blank',
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
  // Load the harness through a data: URL so no file needs writing to disk.
  await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) })
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const result = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })
  if (result.exceptionDetails) {
    console.error('evaluate failed:', JSON.stringify(result.exceptionDetails, null, 1))
  } else {
    console.log(result.result.value)
  }
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  chrome.kill('SIGKILL')
}
