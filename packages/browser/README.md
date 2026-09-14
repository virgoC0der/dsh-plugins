# dsh-browser

A real browser for the DeepSeek Harness. The agent gets a tool family that
drives Chrome over the DevTools Protocol, and the screenshots it takes are
rendered inline in the conversation.

Nothing is installed to make this work: the transport is Node's global
`fetch` + `WebSocket`, and the browser is one already on disk (the Playwright
cache this repository's other scripts use, or a system Chrome/Chromium/Edge).

## What it adds

| Tool | What it does |
| --- | --- |
| `browser_navigate` | Open a URL, wait for the load event, optionally screenshot |
| `browser_screenshot` | Capture the viewport, one element, or the full page |
| `browser_click` | Real mouse event at an element's centre |
| `browser_type` | Focus, clear, type, and optionally submit |
| `browser_eval` | Evaluate a JavaScript expression and return JSON |
| `browser_console` | Console output, uncaught exceptions, HTTP ≥400, failed requests |
| `browser_tabs` | List, open, switch, close tabs |
| `browser_wait_for` | Wait for an element, page text, or URL substring |
| `browser_upload` | Attach local files to a file input |
| `browser_scroll` | Scroll to an element, by a delta, or to top/bottom |

The browser is started lazily on the first call and reclaimed after an idle
period. It is **adopted rather than restarted** when one is already listening
on the configured port, so a plugin reload keeps the tabs — and any login
performed in them.

## How a screenshot reaches the model, and the human

These are two different paths, and the plugin keeps them separate on purpose:

- **The human** sees it because the client half renders the image from this
  plugin's own same-origin route, `/browser/shot/<id>`. That always works.
- **The model** receives it as a durable `ImageBlock` attachment, and only when
  the route serving that call actually declares image input. The capability is
  resolved the same way `read_image` resolves it (`exec.agent` →
  session route → `llm.resolveModelInfo(...).inputModalities`), because the
  DeepSeek adapter rejects images for a model that does not declare them. When
  the route is text-only, the call still returns its full textual report and
  says why the image was not attached.

There is an optional **vision bridge** (`vision.enabled`) for text-only routes:
a separate vision-capable model describes the screenshot and the description is
returned as text. It is off by default and unnecessary when the model sees
images natively.

## Configuration

Resolved highest-first: the profile patch's `config`, environment variables, then
`~/.dsh/browser/config.json`. Defaults:

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `headless` | `BROWSER_PLUGIN_HEADLESS` | `true` | Run without a visible window |
| `port` | `BROWSER_PLUGIN_PORT` | `9333` | DevTools port; a browser here is adopted |
| `browserPath` | `BROWSER_PLUGIN_CHROME` | discovered | Explicit browser executable |
| `windowWidth` / `windowHeight` | `BROWSER_PLUGIN_WINDOW_*` | `1440` / `900` | Viewport for captures |
| `chromeFlags` | `BROWSER_PLUGIN_CHROME_FLAGS` | `[]` | Extra flags, e.g. `--no-sandbox` in a container |
| `idleShutdownMs` | `BROWSER_PLUGIN_IDLE_MS` | `600000` | Reclaim the browser after this long idle; `0` disables |
| `prewarm` | `BROWSER_PLUGIN_PREWARM` | `false` | Start the browser at mount, so the first call needs no cold start |
| `navigationTimeoutMs` | `BROWSER_PLUGIN_NAV_TIMEOUT_MS` | `20000` | Per-navigation budget |
| `actionTimeoutMs` | `BROWSER_PLUGIN_ACTION_TIMEOUT_MS` | `15000` | Per-call budget |
| `captureTimeoutMs` | `BROWSER_PLUGIN_CAPTURE_TIMEOUT_MS` | `15000` | Per-capture budget |
| `waitTimeoutMs` | `BROWSER_PLUGIN_WAIT_TIMEOUT_MS` | `30000` | Ceiling for `browser_wait_for` |
| `wakeDisplay` | `BROWSER_PLUGIN_WAKE_DISPLAY` | `true` on macOS | Wake the display for the duration of a capture |
| `shotLimit` | `BROWSER_PLUGIN_SHOT_LIMIT` | `60` | Screenshots kept on disk (ring buffer) |
| `imageToModel` | `BROWSER_PLUGIN_IMAGE_TO_MODEL` | `auto` | `auto` (only when the route accepts images), `always`, `never` |
| `verbose` | `BROWSER_PLUGIN_VERBOSE` | `false` | Log lifecycle lines to stderr |

State lives in `~/.dsh/browser/`: `profile/` (the browser profile),
`shots/` (captured PNGs), `config.json`.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /browser/shot/<id>` | One captured PNG (immutable, `private` cache) |
| `GET /browser/state` | Browser status, recent shots, effective config, tool names |
| `GET /browser/health` | Liveness probe |

`ctx.webServer.register` is path-addressed with no method field, so each path is
registered once and the verb is checked inside the handler.

## Installing into a profile

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-browser": "link:/absolute/path/to/dsh-plugins/packages/browser"
  }
}
```

```sh
cd ~/.dsh/profiles/web && pnpm install
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: dsh-browser
      name: dsh-browser
```

Restart `dsh web`: route registration and the tool registry are built at
startup. After that a browser refresh is enough for client-half changes.

## Two constraints worth knowing

Both were found by measurement, not by reading code:

**The first call pays for a cold Chrome start.** Launching a browser with a fresh
profile takes far longer than a navigation, and a tool's `timeoutMs` is *not*
advisory — `@deepseek-ai/dsh-tool-call-timeout-policy` arms exactly that deadline
(`ctx.tools.get(name, agent)?.timeoutMs`) and replaces the result with a timeout
error when it fires. A declared budget that only covered the work therefore
reported a *successful* call as `tool call timed out after 30000ms`, while the
capture quietly completed in the background and the screenshot was stored. Every
tool's budget now covers a full browser start plus its own work, and
`prewarm: true` moves that cost to plugin mount instead.

**A sleeping display blocks screenshots on macOS.** `Page.captureScreenshot` is
answered by the browser's compositor, and a sleeping display stops it producing
frames: the request never returns — on every launch-flag combination tried,
including `--headless=old`, `--disable-gpu`, `--in-process-gpu`, and software GL.
The identical capture succeeds in about two seconds once the display is awake. An
agent left running unattended would lose every screenshot, so `wakeDisplay`
(macOS only) wakes the display for the capture itself with
`caffeinate -u -t <seconds>`, which expires on its own. A capture that still
cannot be answered fails with `screenshot-timeout` and says why, rather than
holding the turn for its whole budget.

## Verification

Every claim above is checkable in this repository, and the scripts assume
nothing they have not read back from the page.

```sh
cd packages/browser

node scripts/cdp-smoke.mjs       # the CDP layer: launch, tabs, click, PNG bytes
node scripts/verify-tools.mjs    # the tool layer: every tool against a real local page
node scripts/verify-client.mjs   # the client bundle: registration and payload shapes
node scripts/verify-gui.mjs      # the running Harness GUI, in a real browser
```

- `cdp-smoke.mjs` launches Chrome, drives it, and asserts on what came back:
  a real click is confirmed by the page's own console handler, and a capture is
  confirmed by the PNG signature and byte count. An abort counts as a failure —
  a run that stops halfway must never report success.
- `verify-tools.mjs` imports the host half directly — it needs no DSH — and
  runs every tool against a local page it serves. It checks argument rejection,
  `output.render` for each tool, and that an image-capable route receives an
  `ImageBlock` while a text-only route receives text and no image.
- `verify-client.mjs` loads the browser bundle against stubs and runs `apply()`
  for real, so a registration mistake or a crash on a real block shape is caught
  before a restart rather than after one. It does not prove the components
  render — only the GUI check does that.
- `verify-gui.mjs` drives the real GUI. DSH 0.1.5 put the web server behind an
  authority-bound signed cookie, so this script mints one itself
  (`scripts/lib/dsh-auth.mjs`, from the secret DSH stores in
  `~/.dsh/.credentials.yaml`) and reads the rendered DOM.

The scripts that launch Chrome from a sandboxed shell pass
`--no-sandbox --disable-crashpad --disable-dev-shm-usage`. Those flags exist
because a sandbox inside a sandbox cannot initialise Chrome's own sandbox; they
are **not** runtime defaults, and the plugin launches Chrome normally.

## Design notes

- **The host half imports only Node builtins.** A plugin installed by link
  resolves its imports from its own real path, so `@deepseek-ai/*` is not
  reachable from this package. DSH services arrive through `ctx`, which is also
  why tool definitions are written by hand.
- **Tool arguments are validated here.** `ToolRuntime.register` validates a
  definition's `output.schema` but never its arguments — only `defineTool`
  wraps argument checking, and `defineTool` is not importable for the reason
  above. Every parameter is checked explicitly (`ToolInputError`).
- **The client card is derived from the block, not from presenters.** The
  built-in web client ignores `presentCall`/`presentResult`; it renders from the
  raw arguments, the result content, the failure state, and
  `ToolResultNode.meta` — which is where this plugin's `presentationMeta` lands.
- **An attached image must be an enumerable field of the canonical value.** The
  registry snapshots the value before `render` runs, so a non-enumerable
  property would vanish.
- **The connection shape is the one that already worked here.** Page commands go
  to a page target's own `webSocketDebuggerUrl` with no `sessionId`; a separate
  browser-level connection is used only for tab management. Flat sessions on the
  browser endpoint were tried first and `Page.enable` never answered.

## License

MIT — see [LICENSE](../../LICENSE).
