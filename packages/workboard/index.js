//#region dsh-workboard host half
/**
 * dsh-workboard host half — the data plane of the work dashboard.
 *
 * The browser cannot reach Jira/GitHub/Google/`git` directly (CORS,
 * credentials, no shell), so every source is served from here as same-origin
 * JSON under the `/workboard` route family, and the client half only fetches.
 *
 * Sources and their channels:
 *   - `git`      — local `git` invocations against the registered DSH Workspaces.
 *   - `github`   — the authenticated `gh` CLI (cross-repo PR search, then per-PR
 *                  enrichment for CI status and comment/review counts).
 *   - `jira`     — the Jira Cloud REST API (`/rest/api/3/search/jql`, falling
 *                  back to `/rest/api/3/search`), authenticated with HTTP Basic
 *                  (account email + API token) from the plugin's own config.
 *   - `calendar` — Google Calendar REST with a token this plugin owns: the
 *                  authorization-code flow is served here too, under
 *                  `/workboard/calendar/connect` and `/workboard/calendar/callback`.
 *
 * Every route isolates its own failures: one unreachable source answers a JSON
 * error for that source instead of failing the whole dashboard, and the client
 * renders an empty/connect state for it.
 *
 * @module dsh-workboard
 */
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable Cordis plugin name. */
export const name = 'dsh-workboard'

/** Required services: the HTTP carrier this plugin mounts its routes on. */
export const inject = ['webServer']

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/workboard'
/** Deadline for one shelled command. */
const COMMAND_TIMEOUT_MS = 20000
/** Deadline for one HTTP fetch. */
const FETCH_TIMEOUT_MS = 12000
/** Cap on PRs enriched per refresh, bounding `gh pr view` fan-out. */
const PR_ENRICH_LIMIT = 12
/** Concurrency for per-PR enrichment. */
const PR_ENRICH_CONCURRENCY = 4
/** Google OAuth endpoints. */
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_CALENDAR_ENDPOINT = 'https://www.googleapis.com/calendar/v3/calendars'
/** Minimum scope for an agenda read. */
const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

/** Plugin state directory (holds the OAuth token and the optional config file). */
const STATE_DIR = join(homedir(), '.dsh', 'workboard')
/** Optional config file; every value may also arrive through the environment. */
const CONFIG_PATH = join(homedir(), '.dsh', 'workboard.json')
/** Token store written by the OAuth callback, mode 600. */
const TOKEN_PATH = join(STATE_DIR, 'calendar-token.json')
/** Dashboard storage: registered Workspaces live under tables.workspaces. */
const WORKSPACE_STORE_PATH = join(homedir(), '.dsh', 'storages', 'workspace.json')
/** This package's own env file, beside index.js; holds the secrets. */
const PLUGIN_ENV_PATH = fileURLToPath(new URL('.env', import.meta.url))
/**
 * Optional extra env file, for deployments that keep integration secrets in
 * some already-managed file elsewhere. Off unless `WORKBOARD_ENV_FILE` is set,
 * so this package carries no assumption about where else you keep credentials.
 */
const EXTRA_ENV_PATH = process.env.WORKBOARD_ENV_FILE ?? null
/** Jira JQL run for the dashboard: my unresolved work, most urgent first. */
const JIRA_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY priority ASC, updated DESC'


//#region process helpers
/**
 * Run one command to completion, capturing stdout.
 * @param {string} command - executable name or absolute path.
 * @param {string[]} args - argument vector (never a shell string).
 * @param {{timeoutMs?: number, maxBuffer?: number}} [options] - execution bounds.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number|null}>}
 */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        env: process.env,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: error === null ? 0 : (typeof error.code === 'number' ? error.code : null),
        })
      },
    )
  })
}

/**
 * Resolve the `gh` executable. The Harness server may start with a PATH that
 * omits the Homebrew prefix, so well-known absolute paths are probed too.
 * @returns {Promise<string | null>} a working command, or null when absent.
 */
let ghPathPromise
function resolveGh() {
  ghPathPromise ??= (async () => {
    for (const candidate of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']) {
      const probe = await run(candidate, ['--version'], { timeoutMs: 8000 })
      if (probe.ok) return candidate
    }
    return null
  })()
  return ghPathPromise
}

/**
 * Fetch JSON with a deadline.
 * @param {string} url - absolute URL.
 * @param {{headers?: Record<string, string>, method?: string, body?: string}} [init] - request init.
 * @returns {Promise<{ok: boolean, status: number, data: any, error: string | null}>}
 */
async function fetchJson(url, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
      body: init.body,
      signal: controller.signal,
    })
    const text = await response.text()
    let data = null
    try {
      data = text === '' ? null : JSON.parse(text)
    } catch {
      return { ok: false, status: response.status, data: null, error: 'response was not JSON' }
    }
    if (!response.ok) return { ok: false, status: response.status, data, error: 'HTTP ' + String(response.status) }
    return { ok: true, status: response.status, data, error: null }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      data: null,
      error: aborted ? 'request timed out' : (error instanceof Error ? error.message : String(error)),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read and parse a JSON file, tolerating absence and corruption.
 * @param {string} path - absolute file path.
 * @returns {Promise<any | null>} parsed value, or null when unreadable.
 */
async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}
//#endregion

//#region configuration
/**
 * Read `KEY=value` pairs from a dotenv-style file, tolerating absence.
 * Used only to inherit the already-registered Google OAuth client, so the
 * client secret lives in exactly one place instead of being copied.
 * @param {string} path - absolute env file path.
 * @returns {Promise<Record<string, string>>} parsed pairs ({} when unreadable).
 */
async function readEnvFile(path) {
  try {
    const text = await readFile(path, 'utf8')
    const out = {}
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/u.exec(line)
      if (match === null) continue
      out[match[1]] = match[2].trim().replace(/^["']|["']$/gu, '')
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Effective plugin configuration. For each value: environment variable, then
 * this package's `.env`, then the optional extra env file, then
 * `~/.dsh/workboard.json`, then a built-in default.
 * @returns {Promise<{google: {clientId: string, clientSecret: string, calendarId: string, timeZone: string}, jira: {site: string, email: string, apiToken: string}}>}
 */
async function loadConfig() {
  const file = (await readJsonFile(CONFIG_PATH)) ?? {}
  const pluginEnv = await readEnvFile(PLUGIN_ENV_PATH)
  const extraEnv = EXTRA_ENV_PATH === null ? {} : await readEnvFile(EXTRA_ENV_PATH)
  const google = file.google ?? {}
  const jira = file.jira ?? {}
  return {
    google: {
      clientId:
        process.env.WORKBOARD_GOOGLE_CLIENT_ID ?? pluginEnv.GOOGLE_CLIENT_ID ?? extraEnv.GOOGLE_CLIENT_ID ?? google.clientId ?? '',
      clientSecret:
        process.env.WORKBOARD_GOOGLE_CLIENT_SECRET ?? pluginEnv.GOOGLE_CLIENT_SECRET ?? extraEnv.GOOGLE_CLIENT_SECRET ?? google.clientSecret ?? '',
      calendarId: process.env.WORKBOARD_GOOGLE_CALENDAR_ID ?? pluginEnv.GOOGLE_CALENDAR_ID ?? google.calendarId ?? 'primary',
      timeZone: process.env.WORKBOARD_TIME_ZONE ?? pluginEnv.TIME_ZONE ?? google.timeZone ?? 'UTC',
    },
    jira: {
      site: (process.env.WORKBOARD_JIRA_SITE ?? pluginEnv.JIRA_SITE ?? extraEnv.JIRA_SITE ?? jira.site ?? '')
        .replace(/\/+$/u, ''),
      email: process.env.WORKBOARD_JIRA_EMAIL ?? pluginEnv.JIRA_EMAIL ?? extraEnv.JIRA_EMAIL ?? jira.email ?? '',
      apiToken:
        process.env.WORKBOARD_JIRA_API_TOKEN ??
        pluginEnv.JIRA_API_KEY ??
        extraEnv.JIRA_API_TOKEN ??
        jira.apiToken ??
        '',
    },
  }
}

/**
 * Whether the configured Jira credentials look usable (placeholders rejected).
 * @param {{site: string, email: string, apiToken: string}} jira - Jira config.
 * @returns {boolean} true when a direct REST call can be attempted.
 */
function jiraConfigured(jira) {
  return (
    /^https?:\/\//u.test(jira.site) &&
    jira.email !== '' &&
    jira.apiToken !== '' &&
    !jira.email.startsWith('FILL_IN') &&
    !jira.apiToken.startsWith('FILL_IN')
  )
}

/** Read the stored Google token set, if the OAuth flow has completed. */
async function readToken() {
  return await readJsonFile(TOKEN_PATH)
}

/** Persist the Google token set with owner-only permissions. */
async function writeToken(tokens) {
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 })
  await chmod(TOKEN_PATH, 0o600).catch(() => {})
}
//#endregion

//#region workspaces + git
/** Read registered DSH Workspaces from the dashboard storage envelope. */
async function readWorkspaces() {
  const store = await readJsonFile(WORKSPACE_STORE_PATH)
  const table = store?.tables?.workspaces
  if (table === null || typeof table !== 'object') return []
  return Object.values(table)
    .filter((row) => row !== null && typeof row === 'object' && typeof row.path === 'string')
    .map((row) => ({ name: row.title ?? row.path.split('/').pop() ?? row.path, path: row.path }))
}

/**
 * Collect git state for one working tree. Every field is best-effort: a repo
 * without an upstream, or a directory that is not a repo at all, still answers.
 * @param {{name: string, path: string}} workspace - registered workspace.
 * @returns {Promise<object>} the dashboard's workspace row.
 */
async function gitStatusFor(workspace) {
  const row = { name: workspace.name, path: workspace.path, branch: null, dirty: 0, ahead: 0, behind: 0, stash: 0 }
  const inside = await run('git', ['-C', workspace.path, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 8000 })
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ...row, error: existsSync(workspace.path) ? 'not a git repository' : 'path does not exist' }
  }
  const [branch, status, counts, stash] = await Promise.all([
    run('git', ['-C', workspace.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 8000 }),
    run('git', ['-C', workspace.path, 'status', '--porcelain'], { timeoutMs: 12000 }),
    // `HEAD...@{upstream}` fails without an upstream; treat that as 0/0.
    run('git', ['-C', workspace.path, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { timeoutMs: 12000 }),
    run('git', ['-C', workspace.path, 'stash', 'list'], { timeoutMs: 8000 }),
  ])
  if (branch.ok) {
    const value = branch.stdout.trim()
    row.branch = value === '' ? null : (value === 'HEAD' ? '(detached)' : value)
  }
  if (status.ok) row.dirty = status.stdout.split('\n').filter((line) => line.trim() !== '').length
  if (counts.ok) {
    const parts = counts.stdout.trim().split(/\s+/u)
    if (parts.length === 2) {
      row.ahead = Number.parseInt(parts[0], 10) || 0
      row.behind = Number.parseInt(parts[1], 10) || 0
    }
  }
  if (stash.ok) row.stash = stash.stdout.split('\n').filter((line) => line.trim() !== '').length
  return row
}

/** `GET /workboard/git` — git state for every registered workspace. */
async function handleGit(res) {
  const workspaces = await readWorkspaces()
  const rows = await Promise.all(workspaces.map(gitStatusFor))
  sendJson(res, 200, { workspaces: rows, unavailable: workspaces.length === 0 ? 'no workspaces registered' : null })
}
//#endregion

//#region github
/** Map a `statusCheckRollup` entry list onto the dashboard's tri-state. */
function ciStateOf(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  const states = rollup.map((check) => String(check?.conclusion ?? check?.state ?? '').toUpperCase())
  if (states.some((state) => ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(state))) return 'failure'
  if (states.some((state) => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', 'REQUESTED'].includes(state))) return 'pending'
  if (states.some((state) => ['SUCCESS', 'NEUTRAL', 'SKIPPED', 'STALE'].includes(state))) return 'success'
  return 'none'
}

/** Run `worker` over `items` with a bounded number in flight, preserving order. */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Enrich one PR row with draft / mergeability / review / CI / comment state.
 * @param {string} gh - resolved gh command.
 * @param {any} row - a `gh search prs` row.
 * @param {'authored'|'review-requested'} role - why this PR is on the board.
 * @returns {Promise<object>} the dashboard's PR row.
 */
async function enrichPullRequest(gh, row, role) {
  const repo = row.repository?.nameWithOwner
  const base = { id: String(repo ?? '') + '#' + String(row.number), number: row.number, title: row.title, repo: repo ?? null, url: row.url ?? null, role }
  if (typeof repo !== 'string' || repo === '') return { ...base, ci: 'none' }
  const view = await run(
    gh,
    ['pr', 'view', String(row.number), '--repo', repo, '--json', 'isDraft,reviewDecision,mergeable,statusCheckRollup,comments,reviews,updatedAt,state'],
    { timeoutMs: COMMAND_TIMEOUT_MS },
  )
  if (!view.ok) return { ...base, ci: 'unknown', error: 'gh pr view failed' }
  let detail = null
  try {
    detail = JSON.parse(view.stdout)
  } catch {
    return { ...base, ci: 'unknown', error: 'gh pr view returned non-JSON' }
  }
  return {
    ...base,
    draft: detail.isDraft === true,
    state: detail.state ?? 'OPEN',
    reviewDecision: detail.reviewDecision ?? null,
    mergeable: detail.mergeable ?? null,
    ci: ciStateOf(detail.statusCheckRollup),
    comments: Array.isArray(detail.comments) ? detail.comments.length : 0,
    reviews: Array.isArray(detail.reviews) ? detail.reviews.length : 0,
    updatedAt: detail.updatedAt ?? null,
  }
}

/** `GET /workboard/github` — my open PRs plus PRs awaiting my review, enriched. */
async function handleGithub(res) {
  const gh = await resolveGh()
  if (gh === null) {
    sendJson(res, 200, { prs: [], unavailable: 'the `gh` CLI is not installed or not on PATH' })
    return
  }
  const fields = 'number,title,repository,url,isDraft,updatedAt'
  const [mine, requested] = await Promise.all([
    run(gh, ['search', 'prs', '--author=@me', '--state=open', '--limit', String(PR_ENRICH_LIMIT), '--json', fields]),
    run(gh, ['search', 'prs', '--review-requested=@me', '--state=open', '--limit', String(PR_ENRICH_LIMIT), '--json', fields]),
  ])
  const parse = (result) => {
    if (!result.ok) return { rows: [], error: result.stderr.trim().split('\n')[0] || 'gh search failed' }
    try {
      const parsed = JSON.parse(result.stdout)
      return { rows: Array.isArray(parsed) ? parsed : [], error: null }
    } catch {
      return { rows: [], error: 'gh search returned non-JSON' }
    }
  }
  const authored = parse(mine)
  const review = parse(requested)
  const seen = new Set()
  const queue = []
  for (const [source, role] of [[authored, 'authored'], [review, 'review-requested']]) {
    for (const row of source.rows) {
      const key = String(row.repository?.nameWithOwner ?? '') + '#' + String(row.number)
      if (seen.has(key)) continue
      seen.add(key)
      queue.push({ row, role })
    }
  }
  const prs = await mapPool(queue, PR_ENRICH_CONCURRENCY, (entry) => enrichPullRequest(gh, entry.row, entry.role))
  sendJson(res, 200, { prs, unavailable: authored.error ?? review.error ?? null })
}
//#endregion

//#region jira
/**
 * Resolve a Jira priority name from the API's priority object.
 * @param {any} issue - one Jira issue resource.
 * @returns {string | null} priority name, when present.
 */
function jiraPriorityOf(issue) {
  return issue?.fields?.priority?.name ?? null
}

/**
 * Run the assigned-work JQL against Jira Cloud.
 *
 * Atlassian's newer `/search/jql` endpoint replaced the legacy `/search` GET on
 * current tenants but is not universal, so the legacy path is tried as a
 * fallback; both answer the same `{ issues: [...] }` envelope.
 * @param {{site: string, email: string, apiToken: string}} jira - Jira config.
 * @returns {Promise<{issues: any[], error: string | null}>}
 */
async function jiraSearch(jira) {
  const auth = 'Basic ' + Buffer.from(jira.email + ':' + jira.apiToken).toString('base64')
  const params = new URLSearchParams({
    jql: JIRA_JQL,
    maxResults: '100',
    fields: 'summary,status,priority,issuetype,project,updated',
  })
  const headers = { authorization: auth }
  const modern = await fetchJson(jira.site + '/rest/api/3/search/jql?' + params.toString(), { headers })
  if (modern.ok) {
    return { issues: modern.data?.issues ?? [], error: null }
  }
  // A 400/410 here usually means the tenant still wants the legacy endpoint.
  const legacy = await fetchJson(jira.site + '/rest/api/3/search?' + params.toString(), { headers })
  if (legacy.ok) {
    return { issues: legacy.data?.issues ?? [], error: null }
  }
  const detail = legacy.data?.errorMessages?.join('; ') ?? modern.data?.errorMessages?.join('; ')
  const status = legacy.status !== 0 ? legacy.status : modern.status
  const hint =
    status === 401 || status === 403
      ? 'Jira rejected the credentials (HTTP ' + String(status) + '). Check jira.email and jira.apiToken in ~/.dsh/workboard.json.'
      : 'Jira search failed (' + String(detail ?? legacy.error ?? modern.error ?? 'unknown error') + ')'
  return { issues: [], error: hint }
}

/** `GET /workboard/jira` — my unresolved Jira issues, grouped by project. */
async function handleJira(res, config) {
  if (!jiraConfigured(config.jira)) {
    sendJson(res, 200, {
      projects: [],
      source: null,
      unavailable:
        'Jira credentials are not set. Fill in jira.email and jira.apiToken in ~/.dsh/workboard.json (or set WORKBOARD_JIRA_EMAIL / WORKBOARD_JIRA_API_TOKEN).',
    })
    return
  }
  const result = await jiraSearch(config.jira)
  if (result.error !== null) {
    sendJson(res, 200, { projects: [], source: 'rest', unavailable: result.error })
    return
  }
  const grouped = new Map()
  for (const issue of result.issues) {
    const project = issue.fields?.project ?? {}
    const groupKey = project.key ?? 'UNKNOWN'
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, { key: project.key ?? null, name: project.name ?? groupKey, issues: [] })
    }
    grouped.get(groupKey).issues.push({
      key: issue.key,
      summary: issue.fields?.summary ?? '',
      status: issue.fields?.status?.name ?? null,
      statusCategory: issue.fields?.status?.statusCategory?.key ?? null,
      type: issue.fields?.issuetype?.name ?? null,
      priority: jiraPriorityOf(issue),
      url: config.jira.site + '/browse/' + String(issue.key),
      updatedAt: issue.fields?.updated ?? null,
    })
  }
  sendJson(res, 200, { projects: [...grouped.values()], source: 'rest', unavailable: null })
}
//#endregion

//#region calendar (Google OAuth, owned by this plugin)
/** Build the Google consent URL for this plugin's redirect URI. */
function googleAuthUrl(config, redirectUri) {
  const query = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: 'offline',
    // prompt=consent forces a refresh token on every connect; without it a
    // second consent returns an access token that dies after an hour.
    prompt: 'consent',
    include_granted_scopes: 'true',
  })
  return GOOGLE_AUTH_ENDPOINT + '?' + query.toString()
}

/** The redirect URI this plugin serves, derived from the request origin. */
function redirectUriFor(origin) {
  return origin + ROUTE_PREFIX + '/calendar/callback'
}

/** Exchange an authorization code for tokens. */
async function exchangeCode(config, code, redirectUri) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    code,
    redirect_uri: redirectUri,
  })
  return await fetchJson(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
}

/**
 * Produce a live access token, refreshing when the stored one is near expiry.
 * Google refresh tokens do not rotate, so the stored refresh token is kept.
 * @returns {Promise<{token: string | null, error: string | null}>}
 */
async function accessToken(config) {
  const stored = await readToken()
  if (stored === null || typeof stored.refresh_token !== 'string') {
    return { token: null, error: 'calendar is not connected yet' }
  }
  const expiresAt = typeof stored.expires_at === 'number' ? stored.expires_at : 0
  if (typeof stored.access_token === 'string' && Date.now() < expiresAt - 60000) {
    return { token: stored.access_token, error: null }
  }
  if (config.google.clientId === '' || config.google.clientSecret === '') {
    return { token: null, error: 'Google client credentials are not configured' }
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    refresh_token: stored.refresh_token,
  })
  const refreshed = await fetchJson(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!refreshed.ok || typeof refreshed.data?.access_token !== 'string') {
    return { token: null, error: 'token refresh failed: ' + String(refreshed.data?.error_description ?? refreshed.error ?? 'unknown error') }
  }
  await writeToken({
    ...stored,
    access_token: refreshed.data.access_token,
    expires_at: Date.now() + (Number(refreshed.data.expires_in) || 3600) * 1000,
  })
  return { token: refreshed.data.access_token, error: null }
}

/**
 * Resolve the local day window for "now" in the configured time zone.
 * @param {string} timeZone - IANA zone name.
 * @returns {{start: Date, end: Date, date: string}} bounds plus the local date.
 */
function dayWindow(timeZone) {
  const now = new Date()
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  // The zone's offset on this date, so the bounds are unambiguous instants.
  const zoneClock = new Date(now.toLocaleString('en-US', { timeZone }))
  const utcClock = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }))
  const offsetMinutes = Math.round((zoneClock.getTime() - utcClock.getTime()) / 60000)
  const [year, month, day] = date.split('-').map(Number)
  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMinutes * 60000)
  const end = new Date(Date.UTC(year, month - 1, day, 23, 59, 59) - offsetMinutes * 60000)
  return { start, end, date }
}

/** `GET /workboard/calendar` — today's events. */
async function handleCalendar(res, config) {
  const window = dayWindow(config.google.timeZone)
  const { token, error } = await accessToken(config)
  if (token === null) {
    sendJson(res, 200, {
      date: window.date,
      events: [],
      connected: (await readToken()) !== null,
      connectUrl: ROUTE_PREFIX + '/calendar/connect',
      unavailable: error,
    })
    return
  }
  const url = new URL(GOOGLE_CALENDAR_ENDPOINT + '/' + encodeURIComponent(config.google.calendarId) + '/events')
  url.searchParams.set('timeMin', window.start.toISOString())
  url.searchParams.set('timeMax', window.end.toISOString())
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('maxResults', '50')
  const result = await fetchJson(url.toString(), { headers: { authorization: 'Bearer ' + token } })
  if (!result.ok) {
    sendJson(res, 200, {
      date: window.date,
      events: [],
      connected: true,
      connectUrl: ROUTE_PREFIX + '/calendar/connect',
      unavailable: 'Calendar API: ' + String(result.error ?? 'unknown error'),
    })
    return
  }
  const events = (result.data?.items ?? []).map((event) => ({
    id: event.id,
    title: event.summary ?? '(no title)',
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    allDay: typeof event.start?.date === 'string',
    location: event.location ?? null,
    meetingUrl:
      event.hangoutLink ??
      event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video')?.uri ??
      null,
  }))
  sendJson(res, 200, { date: window.date, events, connected: true, connectUrl: null, unavailable: null })
}

/** `GET /workboard/calendar/connect` — start the consent flow. */
async function handleCalendarConnect(res, config, origin) {
  if (config.google.clientId === '') {
    sendHtml(
      res,
      400,
      'Google client credentials are not configured',
      'Set <code>WORKBOARD_GOOGLE_CLIENT_ID</code> and <code>WORKBOARD_GOOGLE_CLIENT_SECRET</code>, or write them into <code>~/.dsh/workboard.json</code>.',
    )
    return
  }
  res.writeHead(302, { location: googleAuthUrl(config, redirectUriFor(origin)), 'cache-control': 'no-store' })
  res.end()
}

/** `GET /workboard/calendar/callback` — finish the consent flow and store tokens. */
async function handleCalendarCallback(res, config, origin, code, oauthError) {
  if (typeof oauthError === 'string' && oauthError !== '') {
    sendHtml(res, 400, 'Google refused the authorization', 'Error: <code>' + escapeHtml(oauthError) + '</code>')
    return
  }
  if (typeof code !== 'string' || code === '') {
    sendHtml(res, 400, 'Missing authorization code', 'Google did not return a <code>code</code> parameter.')
    return
  }
  const redirectUri = redirectUriFor(origin)
  const exchanged = await exchangeCode(config, code, redirectUri)
  if (!exchanged.ok || typeof exchanged.data?.access_token !== 'string') {
    const reason = String(exchanged.data?.error_description ?? exchanged.data?.error ?? exchanged.error ?? 'unknown error')
    const detail = reason.includes('redirect_uri_mismatch')
      ? 'This redirect URI is not registered on the Google OAuth client. Add <code>' + escapeHtml(redirectUri) + '</code> to its Authorized redirect URIs, then retry.'
      : 'Google said: <code>' + escapeHtml(reason) + '</code>'
    sendHtml(res, 400, 'Token exchange failed', detail)
    return
  }
  const previous = (await readToken()) ?? {}
  await writeToken({
    access_token: exchanged.data.access_token,
    // A refresh token only arrives on the first consent; keep the old one otherwise.
    refresh_token: exchanged.data.refresh_token ?? previous.refresh_token ?? null,
    scope: exchanged.data.scope ?? GOOGLE_CALENDAR_SCOPE,
    expires_at: Date.now() + (Number(exchanged.data.expires_in) || 3600) * 1000,
    obtained_at: new Date().toISOString(),
  })
  sendHtml(res, 200, 'Google Calendar connected', "The workboard can now read today's agenda. You can close this tab.")
}
//#endregion

//#region HTTP plumbing
/** Escape text for HTML interpolation. */
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/gu,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  )
}

/** Send one JSON response. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Send one small HTML page (the OAuth endpoints are visited by a browser). */
function sendHtml(res, status, title, detail) {
  const payload =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' +
    escapeHtml(title) +
    '</title><style>body{font:14px/1.6 -apple-system,system-ui,sans-serif;max-width:44rem;margin:12vh auto;padding:0 1.5rem;color:#1f2329}' +
    'code{background:rgba(31,35,41,.06);padding:.1rem .3rem;border-radius:4px}</style></head><body><h1>' +
    escapeHtml(title) +
    '</h1><p>' +
    detail +
    '</p></body></html>'
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

/**
 * Route one request under {@link ROUTE_PREFIX}.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {import('node:http').ServerResponse} res - response to own.
 * @param {object} config - resolved plugin configuration.
 */
async function dispatch(req, res, config) {
  const origin = 'http://' + (req.headers.host ?? '127.0.0.1:3080')
  const url = new URL(req.url ?? '/', origin)
  const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/'
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed', allow: 'GET' })
    return
  }
  switch (sub) {
    case '/git':
      await handleGit(res)
      return
    case '/github':
      await handleGithub(res)
      return
    case '/jira':
      await handleJira(res, config)
      return
    case '/calendar':
      await handleCalendar(res, config)
      return
    case '/calendar/connect':
      await handleCalendarConnect(res, config, origin)
      return
    case '/calendar/callback':
      await handleCalendarCallback(res, config, origin, url.searchParams.get('code'), url.searchParams.get('error'))
      return
    case '/health': {
      const gh = await resolveGh()
      const token = await readToken()
      sendJson(res, 200, {
        sources: {
          git: { available: true, detail: 'local git' },
          github: { available: gh !== null, detail: gh ?? 'gh CLI not found' },
          jira: {
            available: jiraConfigured(config.jira),
            detail: jiraConfigured(config.jira) ? config.jira.site : 'credentials not configured',
          },
          calendar: {
            available: token !== null && config.google.clientId !== '',
            detail: token === null ? 'not connected' : 'connected',
          },
        },
      })
      return
    }
    default:
      sendJson(res, 404, {
        error: 'unknown workboard route',
        path: sub,
        routes: ['/git', '/github', '/jira', '/calendar', '/calendar/connect', '/calendar/callback', '/health'],
      })
  }
}
//#endregion

/**
 * Mount the workboard data plane.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context carrying `webServer`.
 */
export function apply(ctx) {
  ctx.effect(
    () => {
      const dispose = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          // Configuration is read per request: editing ~/.dsh/workboard.json or
          // completing the OAuth flow takes effect without a server restart.
          loadConfig()
            .then((config) => dispatch(req, res, config))
            .catch((error) => {
              sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
            })
        },
      })
      return () => {
        dispose()
      }
    },
    'dsh-workboard: data plane routes',
  )
}
//#endregion
