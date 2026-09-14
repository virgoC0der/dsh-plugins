// Mint a valid `dsh web` session cookie for the verification scripts.
//
// DSH 0.1.5 put the browser UI behind an authority-bound signed cookie: the
// server answers every unauthenticated request with
//
//   401 dsh web authentication required; reopen the URL printed by dsh web.
//
// A script that launches its own Chrome with a throwaway profile therefore
// lands on a 401 page and can verify nothing. The cookie is signed with a
// secret DSH stores in the credentials file, so a verification script can mint
// its own instead of depending on the user's browser session or on a token
// printed once at startup.
//
// The scheme, read from @deepseek-ai/dsh-client-connection (0.1.5-rc.2):
//
//   cookie name  = "dsh-auth-" + base64url(sha256(authority))
//   cookie value = "v1." + base64url(JSON payload) + "." + base64url(hmacSha256(secret, body))
//   payload      = { version: 1, authority, issuedAt, expiresAt }
//   secret       = base64url-decode(credentials.records["client-connection/browser-session"].payload.secret)
//
// This is a verification helper, not part of the plugin: the plugin's own
// client half talks to its host half same-origin and the browser attaches the
// cookie by itself.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const DSH_ROOT = process.env.DSH_ROOT ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
const CREDENTIALS = process.env.DSH_CREDENTIALS ?? join(homedir(), '.dsh/.credentials.yaml')

/** The credential record holding the browser-session signing secret. */
const AUTH_RECORD = 'client-connection/browser-session'

/** Load js-yaml through DSH's own dependency tree, as inspect-image.mjs does. */
function loadYaml() {
  const require = createRequire(join(DSH_ROOT, 'package.json'))
  return require('js-yaml')
}

/** Base64url-encode a buffer without padding. */
const base64url = (buffer) => buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

/** Read the signing secret out of the credentials file. */
export function readSecret() {
  const yaml = loadYaml()
  const document = yaml.load(readFileSync(CREDENTIALS, 'utf8'))
  const record = document?.records?.[AUTH_RECORD]
  const encoded = record?.payload?.secret
  if (typeof encoded !== 'string') {
    throw new Error(`no ${AUTH_RECORD} secret in ${CREDENTIALS}; start \`dsh web\` once to create it`)
  }
  const secret = Buffer.from(encoded.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (secret.length !== 32) throw new Error(`the stored browser-session secret is ${secret.length} bytes, expected 32`)
  return secret
}

/**
 * Mint a session cookie for one authority.
 * @param {string} authority - `host:port` exactly as the server sees it.
 * @param {object} [options] - `secret`, `maxAgeMs`.
 * @returns {{name: string, value: string, header: string}} the cookie.
 */
export function mintCookie(authority, options = {}) {
  const secret = options.secret ?? readSecret()
  const now = Date.now()
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + maxAgeMs }
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = base64url(createHmac('sha256', secret).update(body).digest())
  const name = `dsh-auth-${base64url(createHash('sha256').update(authority).digest())}`
  const value = `v1.${body}.${signature}`
  return { name, value, header: `${name}=${value}` }
}

/**
 * Verify a minted cookie the way the server does, so a script can fail loudly
 * on its own bug instead of blaming the harness.
 * @param {{name: string, value: string}} cookie - the cookie to check.
 * @param {string} authority - expected authority.
 * @returns {boolean} whether the server would accept it.
 */
export function selfCheck(cookie, authority) {
  const parts = cookie.value.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return false
  const secret = readSecret()
  const expected = createHmac('sha256', secret).update(parts[1]).digest()
  const actual = Buffer.from(parts[2].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false
  const payload = JSON.parse(Buffer.from(parts[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
  return payload.authority === authority && payload.expiresAt > Date.now()
}

/**
 * Install the cookie into a CDP page session, before any navigation.
 * @param {{send: Function}} connection - a page-level CdpConnection.
 * @param {string} authority - `host:port`.
 * @returns {Promise<void>} resolves once the cookie is set.
 */
export async function installCookie(connection, authority) {
  const cookie = mintCookie(authority)
  const [host, port] = authority.split(':')
  await connection.send('Network.setCookie', {
    name: cookie.name,
    value: cookie.value,
    domain: host,
    path: '/',
    httpOnly: true,
    secure: false,
    // A year out; the script's Chrome profile is discarded anyway.
    expires: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
    ...(port === undefined ? {} : {}),
  })
}

/** The authority string for a host and port, as `requestAuthority` builds it. */
export const authorityOf = (host, port) => `${host}:${port}`
