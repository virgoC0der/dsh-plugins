/**
 * Screenshot storage.
 *
 * Screenshots are the plugin's main output, and they have to be reachable from
 * two very different consumers:
 *
 * - the browser, which loads them from this plugin's own same-origin route
 *   (`/browser/shot/<id>`), so the inline tool view needs no attachment
 *   plumbing and no credentials;
 * - the model, which receives the bytes through the durable attachment service
 *   as an `ImageBlock`.
 *
 * A ring buffer keeps disk use bounded: the newest `shotLimit` captures are
 * kept and older ones are deleted as new ones arrive.
 *
 * @module dsh-browser/lib/shots
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Ids appear in URLs, so they are restricted to a safe alphabet. */
const ID_PATTERN = /^[a-z0-9]{6,64}$/

/**
 * Read a PNG's intrinsic size straight from its IHDR chunk.
 *
 * The client needs width and height before the image loads (to reserve space
 * and avoid a layout jump), and this avoids taking on an image dependency for
 * two integers.
 *
 * @param {Buffer} png - encoded PNG bytes.
 * @returns {{width: number, height: number}} intrinsic size, or zeros when unreadable.
 */
export function pngSize(png) {
  const isPng = png.length > 24 && png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  if (!isPng) return { width: 0, height: 0 }
  // IHDR is required to be the first chunk: length(4) type(4) width(4) height(4).
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/** One stored capture. */
export class ShotStore {
  /**
   * @param {object} options - `dir` and `limit`.
   */
  constructor({ dir, limit }) {
    this.dir = dir
    this.limit = Math.max(1, limit)
    /** @type {Array<object>} newest last. */
    this.index = []
    this.counter = 0
    this.ready = false
  }

  /** Create the directory and seed the index from what is already on disk. */
  init() {
    if (this.ready) return
    mkdirSync(this.dir, { recursive: true })
    try {
      const files = readdirSync(this.dir).filter((name) => name.endsWith('.png'))
      const entries = files
        .map((name) => {
          const path = join(this.dir, name)
          return { id: name.slice(0, -4), bytes: statSync(path).size, at: statSync(path).mtimeMs }
        })
        .sort((a, b) => a.at - b.at)
      this.index = entries.slice(-this.limit)
      this.pruneOnDisk()
    } catch {
      this.index = []
    }
    this.ready = true
  }

  /**
   * Persist one capture.
   * @param {Buffer} png - encoded PNG.
   * @param {object} meta - page facts to record alongside it.
   * @returns {object} the stored shot record, including `id` and `url`.
   */
  save(png, meta) {
    this.init()
    const { width, height } = pngSize(png)
    const id = `${Date.now().toString(36)}${(this.counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const path = join(this.dir, `${id}.png`)
    writeFileSync(path, png)
    // Undefined metadata values are dropped rather than stored: a tool result
    // crosses a lossless-JSON boundary, and a present-but-undefined key has no
    // JSON representation there.
    const extra = {}
    for (const [key, value] of Object.entries(meta ?? {})) {
      if (value !== undefined) extra[key] = value
    }
    const shot = {
      id,
      path,
      url: `/browser/shot/${id}`,
      bytes: png.length,
      width,
      height,
      at: Date.now(),
      ...extra,
    }
    this.index.push(shot)
    if (this.index.length > this.limit) this.index.splice(0, this.index.length - this.limit)
    this.pruneOnDisk()
    return shot
  }

  /**
   * Look up one shot.
   * @param {string} id - shot id from a tool result or URL.
   * @returns {object|null} the record, or null when unknown.
   */
  get(id) {
    if (!ID_PATTERN.test(id)) return null
    this.init()
    const known = this.index.find((shot) => shot.id === id)
    const path = join(this.dir, `${id}.png`)
    if (known !== undefined) return known
    try {
      const bytes = statSync(path)
      return { id, path, url: `/browser/shot/${id}`, bytes: bytes.size, width: 0, height: 0, at: bytes.mtimeMs }
    } catch {
      return null
    }
  }

  /**
   * Read one shot's bytes.
   * @param {string} id - shot id.
   * @returns {Buffer|null} the PNG, or null when unknown.
   */
  read(id) {
    const shot = this.get(id)
    if (shot === null) return null
    try {
      return readFileSync(shot.path)
    } catch {
      return null
    }
  }

  /** The most recent shots, newest first. */
  list(limit = 20) {
    this.init()
    return [...this.index].reverse().slice(0, limit)
  }

  /** Delete files beyond the retained window. */
  pruneOnDisk() {
    const keep = new Set(this.index.map((shot) => shot.id))
    try {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.png')) continue
        const id = name.slice(0, -4)
        if (keep.has(id)) continue
        rmSync(join(this.dir, name), { force: true })
      }
    } catch {
      /* pruning is best-effort */
    }
  }
}
