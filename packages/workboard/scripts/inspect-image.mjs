// Inspect a source image the way a text-only reviewer has to: metadata, the
// content bounding box, the palette, and an ASCII rendering of the shape.
//
// Usage: node scripts/inspect-image.mjs <path> [asciiWidth]
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const DSH = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
const require = createRequire(join(DSH, 'package.json'))
const sharp = require('sharp')

const SOURCE = process.argv[2]
const COLS = Number(process.argv[3] ?? 56)
if (SOURCE === undefined) {
  console.error('usage: node scripts/inspect-image.mjs <path> [asciiWidth]')
  process.exit(1)
}

const meta = await sharp(SOURCE).metadata()
console.log('size        : ' + String(meta.width) + ' x ' + String(meta.height))
console.log('format      : ' + String(meta.format) + ', alpha: ' + String(meta.hasAlpha) + ', space: ' + String(meta.space))

// Content bounding box: trim removes a uniform border, and for an alpha image
// that means the transparent margin.
try {
  const trimmed = await sharp(SOURCE).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true })
  console.log(
    'content box : ' + String(trimmed.info.width) + ' x ' + String(trimmed.info.height)
    + ' at left=' + String(trimmed.info.trimOffsetLeft ?? '?') + ' top=' + String(trimmed.info.trimOffsetTop ?? '?'),
  )
} catch (error) {
  console.log('content box : trim failed (' + error.message + ')')
}

// Palette: quantize to a small grid and count the winners, ignoring near-transparent pixels.
const SAMPLE = 256
const { data, info } = await sharp(SOURCE)
  .resize(SAMPLE, SAMPLE, { fit: 'inside' })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true })
const counts = new Map()
let opaque = 0
let translucent = 0
let transparent = 0
for (let i = 0; i < data.length; i += 4) {
  const a = data[i + 3]
  if (a < 8) { transparent += 1; continue }
  if (a < 248) translucent += 1
  opaque += 1
  const key = [data[i], data[i + 1], data[i + 2]].map((v) => Math.round(v / 16) * 16).join(',')
  counts.set(key, (counts.get(key) ?? 0) + 1)
}
const total = opaque + translucent + transparent
console.log('pixels      : opaque ' + String(Math.round((opaque / total) * 100)) + '%'
  + ', soft-edge ' + String((Math.round((translucent / total) * 1000) / 10)) + '%'
  + ', transparent ' + String(Math.round((transparent / total) * 100)) + '%')
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
console.log('top colours : ' + top.map(([k, n]) => 'rgb(' + k + ') ' + String(Math.round((n / opaque) * 100)) + '%').join('  '))

// ASCII: composite over white, then map darkness to characters.
const ascii = await sharp(SOURCE)
  .flatten({ background: '#ffffff' })
  .resize(COLS, Math.max(1, Math.round((COLS * info.height) / info.width / 2)), { fit: 'fill' })
  .greyscale()
  .raw()
  .toBuffer({ resolveWithObject: true })
console.log('\nASCII (' + String(ascii.info.width) + 'x' + String(ascii.info.height) + '), dark = ink:')
console.log('+' + '-'.repeat(ascii.info.width) + '+')
for (let y = 0; y < ascii.info.height; y += 1) {
  let line = ''
  for (let x = 0; x < ascii.info.width; x += 1) {
    const v = ascii.data[y * ascii.info.width + x] / 255
    const d = 1 - v
    line += d > 0.85 ? '#' : d > 0.5 ? '+' : d > 0.2 ? '.' : ' '
  }
  console.log('|' + line + '|')
}
console.log('+' + '-'.repeat(ascii.info.width) + '+')

// Bytes matter for a bundled asset.
console.log('\nfile size   : ' + String(Math.round(readFileSync(SOURCE).length / 1024)) + ' KB')
