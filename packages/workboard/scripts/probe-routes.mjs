// Standalone harness: mount the host half against a fake webServer and exercise
// every route over a real loopback HTTP server, so the plugin can be validated
// without restarting the Harness itself.
import { createServer } from 'node:http'

const handlers = new Map()
const fakeCtx = {
  webServer: {
    register({ kind, path, handler }) {
      handlers.set(kind + ' ' + path, handler)
      return () => handlers.delete(kind + ' ' + path)
    },
  },
  effect(fn) {
    fn()
  },
}

const plugin = await import('../index.js')
plugin.apply(fakeCtx)

const prefix = handlers.get('prefix /workboard')
if (prefix === undefined) {
  console.error('FAIL: no /workboard prefix route registered')
  process.exit(1)
}

const server = createServer((req, res) => prefix(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const routes = ['/workboard/health', '/workboard/git', '/workboard/github', '/workboard/jira', '/workboard/calendar']
for (const route of routes) {
  const started = Date.now()
  try {
    const response = await fetch('http://127.0.0.1:' + String(port) + route)
    const text = await response.text()
    const elapsed = Date.now() - started
    let summary
    try {
      const data = JSON.parse(text)
      if (route.endsWith('git')) summary = `${data.workspaces?.length ?? 0} workspaces: ` + (data.workspaces ?? []).map((w) => `${w.name}[${w.branch ?? w.error} d${w.dirty} a${w.ahead} b${w.behind} s${w.stash}]`).join(' ')
      else if (route.endsWith('github')) summary = `${data.prs?.length ?? 0} PRs: ` + (data.prs ?? []).map((p) => `#${p.number}(${p.role},ci=${p.ci},c=${p.comments},r=${p.reviews})`).join(' ') + (data.unavailable ? ' UNAVAILABLE=' + data.unavailable : '')
      else if (route.endsWith('jira')) summary = (data.projects ?? []).map((p) => `${p.key ?? p.name}: ${p.issues.length} issues [${p.issues.map((i) => i.key + '/' + (i.status ?? '?')).join(', ')}]`).join(' | ') + (data.unavailable ? ' UNAVAILABLE=' + data.unavailable : '')
      else if (route.endsWith('calendar')) summary = `${data.events?.length ?? 0} events connected=${data.connected} ` + (data.unavailable ?? '') + ' ' + (data.events ?? []).map((e) => e.title).join(', ')
      else summary = JSON.stringify(data.sources)
    } catch {
      summary = text.slice(0, 200)
    }
    console.log(`\n[${response.status}] ${route} (${elapsed}ms)\n  ${summary}`)
  } catch (error) {
    console.log(`\n[ERR] ${route}: ${error.message}`)
  }
}

server.close()
