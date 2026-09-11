// Rasterise the plugin's inline SVG marks to ASCII so their shape can be
// reviewed without an image-capable viewer: the browser draws each mark on a
// canvas, reads the pixels back, and this prints a luminance grid.
//
// Usage: node scripts/glyph-preview.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = 9340
const PROFILE = join(tmpdir(), 'dsh-wb-glyph-profile')
const BINARY = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)

/** Pull the authored mark constants straight out of the shipped bundle. */
function marks() {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const out = []
  for (const name of ['GITHUB_MARK', 'JIRA_MARK', 'CALENDAR_MARK', 'GIT_MARK', 'BOARD_MARK']) {
    const match = new RegExp('var ' + name + " = '([^']*)'", 'u').exec(source)
    if (match === null) throw new Error('missing ' + name)
    out.push({ name, svg: match[1] })
  }
  return out
}

const PAINT = `(async (svgs) => {
  const art = [];
  for (const item of svgs) {
    // currentColor has no CSS context inside an <img>, so it resolves to black,
    // which is exactly the ink we want to see. xmlns is required for a standalone
    // SVG document even though inline HTML SVG does not need it.
    const standalone = item.svg.includes('xmlns=')
      ? item.svg
      : item.svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(standalone);
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    const size = 72;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    // Sample into a character grid: 2 vertical pixels per row keeps the aspect.
    const cols = 60, rows = 26;
    const lines = [];
    let ink = 0;
    for (let r = 0; r < rows; r += 1) {
      let line = '';
      for (let c = 0; c < cols; c += 1) {
        const x = Math.min(size - 1, Math.round((c + 0.5) * size / cols));
        const y = Math.min(size - 1, Math.round((r + 0.5) * size / rows));
        const i = (y * size + x) * 4;
        const a = data[i + 3] / 255;
        const lum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
        const darkness = (1 - lum) * a;
        if (darkness > 0.12) ink += 1;
        line += darkness > 0.62 ? '#' : darkness > 0.3 ? '+' : darkness > 0.12 ? '.' : ' ';
      }
      lines.push(line.replace(/\\s+$/u, ''));
    }
    art.push({ name: item.name, lines, inkPixels: ink });
  }
  return JSON.stringify(art);
})`

const chrome = spawn(
  BINARY,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
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
  const result = await send('Runtime.evaluate', {
    expression: PAINT + '(' + JSON.stringify(marks()) + ')',
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) {
    console.error('render failed:', JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails))
    process.exit(1)
  }
  for (const glyph of JSON.parse(result.result.value)) {
    const filled = glyph.lines.filter((line) => line.trim() !== '').length
    console.log('\n' + glyph.name + '  (rows with ink: ' + String(filled) + '/' + String(glyph.lines.length) + ', ink cells: ' + String(glyph.inkPixels) + ')')
    console.log('+' + '-'.repeat(60) + '+')
    for (const line of glyph.lines) console.log('|' + line.padEnd(60, ' ') + '|')
    console.log('+' + '-'.repeat(60) + '+')
  }
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  chrome.kill('SIGKILL')
}
