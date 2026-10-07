# dsh-workboard

A DSH client plugin that puts **my work today** on the Harness Web homepage:
GitHub pull requests with CI and discussion state, Jira issues assigned to me
grouped by project, today's Google Calendar agenda, and the git state of every
registered Workspace — in one board.

- **Host half** (`index.js`) — the data plane. It registers a `/workboard` route
  family on the Harness web server and does all the I/O: `git` invocations, the
  `gh` CLI, the Jira REST API, and Google Calendar. The browser cannot reach any
  of these directly (CORS, credentials, no shell), so the client only fetches
  same-origin JSON.
- **Client half** (`client.js`) — a classic DSH client bundle registered through
  `window.__ModuleLoader__.load`. It renders a large board on the **no-session
  homepage** and a compact panel plus a floating button everywhere else.

## Surfaces

| Surface | When it shows | What it is |
| --- | --- | --- |
| Home board | No session selected, **or a just-opened blank conversation** | One contained panel: composer width, aligned to the composer's left edge, starting below it |
| Floating panel | Any screen, on demand | The same deck as independently scrolling cards; `Esc` closes |
| Round button | Always | A 44 px circle drawing an inline board glyph; red with a corner badge when something needs attention |

The board registers into the additive `shell.overlay` list slot, so it never
replaces a shipped surface. That layer is click-through, so the board, the panel,
and the button each opt back into pointer events in their own CSS.

### Why the home board is not an overlay

An earlier version drew the board as a full-viewport layer. On a new conversation
that covered the whole Harness UI and left it unusable, and it read as an overlay
bolted on top rather than part of the page.

The current design is a single surface measured against the composer:

- **Same width, same left edge, starting below it.** Aligning to the composer's
  `x` matters: the composer is centred inside the centre column, which begins
  after the sidebar, so viewport centring lands half a sidebar off.
- **Height capped to the space below the composer**, with the deck scrolling
  inside. Measured footprint is ~18% of a 1440×900 viewport.
- **The sidebar, the composer, and the area below the board all stay
  hit-testable** — asserted in `scripts/verify-ui.mjs`, not assumed.

The deck uses flat sections divided by hairlines in the board (so it reads as one
page block) and bordered, independently scrolling cards in the floating panel.
Both shells share one header builder and one fold control, so they cannot drift.

### Brand artwork

`assets/workboard-logo.png` is the package's brand illustration. It is served by
the host half at `GET /workboard/icon` rather than inlined into the client
bundle, so the asset stays replaceable and the bundle stays small.

**It is deliberately not used for the button.** The artwork carries its identity
in fine strokes and small details, which is exactly what is lost at the button's
21 px glyph size: rendered at 21 px it is illegible, and it only reads from about
40 px upward. The button therefore keeps the vector mark, which is legible at
21 px by construction, and the artwork appears at 42 px in the board header where
it can actually be seen. `scripts/inspect-image.mjs` renders any candidate asset
at its real display size as ASCII, which is how that threshold was established.

If the asset is missing, `BrandLogo` falls back to the vector mark and answers
404, so a package without artwork still renders a complete header.

### Section marks

Each section leads with an inline SVG mark. An out-of-tree plugin can only
`require` the shell's baseline words, so there is no icon package to import and
the marks are authored inline:

| Section | Mark | Provenance |
| --- | --- | --- |
| GitHub pull requests | octocat | The official GitHub mark |
| Jira assigned to me | Atlassian diamond | The official Jira mark, in Atlassian's three blues |
| Today's calendar | calendar page | Purpose-drawn in Google's four colours; **not** the official Google logo |
| Workspace git status | `git-branch` | Official Octicons path, matching the shell's own icon style |

`scripts/glyph-preview.mjs` rasterises each mark to ASCII art via a canvas
read-back, so the shapes can be reviewed without opening an image.

### Where the board appears

Both "home" screens are keyed on the session list's **settled** phase
(`state.phase === 'ready'`), which matters because "nothing is on screen" is also
the pre-pull state:

- **No conversation on screen** — the New Session view.
- **A conversation with no turns yet** — New Session *opens a real (blank)
  session* rather than clearing the selection, so this arm is what makes the
  board appear on a new conversation.

Which conversation is on screen follows the shell's own rule rather than a field
of its own: `retainedBy.mainView > 0`, the same test the shell's document title
uses to pick the session it names. The list snapshot does not carry a `current`
id — 0.2.x publishes `ids` and `byId` only — so a plugin that tests
`current === undefined` reads *every* screen as the new-session screen and leaves
the board up over an open conversation. `mainViewSession()` still honours a
`current` when one is present, so both snapshot shapes work.

### Composer-aware placement

The shell's class names are content-hashed, so the composer is located
structurally: the composer's editable element — a `textarea` where the shell uses
one, otherwise its `contenteditable` — walked up to the nearest ancestor that
actually paints a surface (non-transparent background plus rounded corners).

Two placements derive from that measurement, re-taken on resize and on a slow
tick because the composer moves between the centred (blank session) and bottom
(active session) layouts with no event this plugin can subscribe to:

- **The round button** steps up to sit above the composer card when a
  bottom-right position would intersect it — which happens at medium window
  widths, where the centre column narrows and the card's right edge reaches the
  button. The panel tracks the same offset.
- **The board's top padding** clears the composer, so a new conversation's input
  stays visible and typeable underneath. Verified by hit-testing the composer's
  centre after the board renders.

### Pulling a row into the composer

Clicking a row's title on the home board **adds that item to the composer draft
as context**, under one heading, so the conversation starts grounded in the work
it is about:

```text
Context from my workboard:
- PR acme/storefront#412 — fix: cache the catalogue listing — https://github.com/acme/storefront/pull/412
- JIRA SHOP-128 [In Progress] — Align the checkout retry policy — https://acme.atlassian.net/browse/SHOP-128
```

Details that matter:

- **Idempotent.** Adding the same row twice appends nothing and the row says
  `already added`, so a double click cannot corrupt the draft.
- **Honest feedback.** Each row reports `✓ added`, `already added`, or
  `no composer` — the last one when there is genuinely no composer to write to,
  or when the write did not survive in the field it was sent to.
- **The source link survives.** The row keeps a small `↗` for opening the PR or
  issue, so pulling something in never costs the reader the ability to go look
  at it.
- All four sections participate (PRs, Jira, meetings, workspaces).

#### Why this writes through the DOM

There is no public API for it. `InputActions.setDraft` is composed only into the
conversation package's own components — no slot registrant receives it — and
`ctx.conversation` is scope-addressed, so a root-scoped plugin cannot reach a
session's input facade. `ctx.inputTriggers` *can* insert a proper atomic
reference, but only through a per-session controller resolved from a
session-scope `ctx`, which a root-scoped board does not have.

So `writeDraft` drives the field the way a keystroke does, and the two editable
shapes need different commands:

- A **`textarea`** takes the native prototype value setter and a real `input`
  event; a plain `.value =` assignment would be swallowed by React's
  controlled-component value tracking.
- The composer current shells ship is a **Lexical `contenteditable`**
  (`data-lexical-editor`), where assigning `textContent` is worse than useless:
  Lexical renders from its own model, so the text appears and is wiped by the
  next reconciliation. `execCommand('insertText')` over a select-all fires the
  real `beforeinput`/`input` pair the editor commits from — but the two steps
  **cannot share a task**. Lexical adopts a DOM selection into its own model on a
  later frame, and a command issued in the same task types into a stale (or
  absent) selection and silently does nothing. `writeDraft` therefore selects,
  yields a frame, inserts, yields again, and **reads the draft back**: the
  outcome a row shows is what the field actually holds, not what the command
  claimed. Line breaks are compared whitespace-insensitively because a rich-text
  composer stores them as paragraphs and reads back without the separators.

The verification does not trust the plugin's own view of this either: it clicks a
real row and then asserts the composer **enables its send button**, which only
happens once the input machine actually holds the text. If a future shell exposes
a draft API, this bridge is the single function to replace.

### Folding

Every section header carries a chevron that folds the section; folding is shared
between the board and the panel, and a folded section keeps its header and count
badge so the deck still reads as a summary.

## Data plane routes

All are `GET`, same-origin, JSON, and answer with an `unavailable` message
instead of failing when a source cannot be read.

| Route | Source | Notes |
| --- | --- | --- |
| `/workboard/github` | `gh` CLI | Cross-repo search for my open PRs plus review requests, then per-PR enrichment (`gh pr view`) for draft, review decision, mergeability, CI rollup, comment and review counts |
| `/workboard/jira` | Jira REST v3 | JQL `assignee = currentUser() AND statusCategory != Done`, grouped by project |
| `/workboard/calendar` | Google Calendar REST | Today's events in the configured time zone |
| `/workboard/calendar/connect` | — | Starts the Google consent flow (302) |
| `/workboard/calendar/callback` | — | Exchanges the code and stores the refresh token (mode 600) |
| `/workboard/git` | local `git` | Branch, dirty count, ahead/behind, stash count for every registered Workspace |
| `/workboard/health` | — | Which sources are configured and reachable |

## Configuration

Read per request, so editing a file takes effect without a server restart.

Resolution order per value:

1. an environment variable (`WORKBOARD_*`)
2. this package's `.env` (beside `index.js`, git-ignored — copy `.env.example`)
3. `$WORKBOARD_ENV_FILE`, when you point it at an env file you already manage
4. `~/.dsh/workboard.json`
5. a built-in default

```jsonc
// ~/.dsh/workboard.json — the non-secret half
{
  "jira":   { "site": "https://your-org.atlassian.net", "email": "you@example.com" },
  "google": { "calendarId": "primary", "timeZone": "Europe/Berlin" }
}
```

```sh
# ./.env — secrets only (git-ignored)
JIRA_API_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

| Variable | Purpose |
| --- | --- |
| `JIRA_API_KEY` | Atlassian API token, sent as HTTP Basic together with the Jira email |
| `JIRA_EMAIL`, `JIRA_SITE` | Jira account email and site origin |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client for the calendar flow |
| `GOOGLE_CALENDAR_ID`, `TIME_ZONE` | Calendar to read and the zone its day window is computed in |
| `WORKBOARD_ENV_FILE` | Path to an extra env file to read (lowest-precedence file source) |
| `WORKBOARD_JIRA_*`, `WORKBOARD_GOOGLE_*`, `WORKBOARD_TIME_ZONE` | Environment overrides for all of the above |

Nothing in this package assumes where else you keep credentials: the only paths
it reads are its own `.env` and `~/.dsh/workboard.json`, both overridable.

### GitHub

Nothing to configure. The plugin resolves `gh` from `PATH` (then from
`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`) and uses whichever account
`gh auth login` established.

### Jira

Create an API token at
<https://id.atlassian.com/manage-profile/security/api-tokens>, then set
`JIRA_API_KEY` in `.env` and `jira.email` + `jira.site` in
`~/.dsh/workboard.json`. The token is sent as HTTP Basic (`email:token`), never
logged, and never returned by any route.

The search tries `/rest/api/3/search/jql` first and falls back to the legacy
`/rest/api/3/search`, because tenants differ in which one they still accept.

### Google Calendar (one manual consent step)

The plugin owns its own OAuth flow and token store; it does not reuse another
tool's stored token.

1. Give it Google OAuth client credentials (`clientId` + `clientSecret`), either
   under `google` in `~/.dsh/workboard.json`, or through the
   `WORKBOARD_GOOGLE_CLIENT_ID` / `WORKBOARD_GOOGLE_CLIENT_SECRET` variables.
2. **Register the redirect URI** on that OAuth client in the Google Cloud
   Console (APIs & Services → Credentials → your OAuth client → Authorized
   redirect URIs):

   ```
   http://127.0.0.1:3080/workboard/calendar/callback
   ```

   It must match exactly, including scheme, host, and port. Without it Google
   answers `redirect_uri_mismatch`, and the callback page says exactly that.
3. Open <http://127.0.0.1:3080/workboard/calendar/connect> and approve. The
   refresh token is written to `~/.dsh/calendar-token.json` (mode 600).
   `access_type=offline` and `prompt=consent` are both set so a refresh token is
   actually issued, and Google's non-rotating refresh token is reused on refresh.

The calendar card shows a **Connect Google Calendar →** link while it is not
connected yet, and only while the OAuth client credentials above are present:
without them the consent flow has nowhere to send the browser, so the card names
what is missing instead of offering a link that can only answer 400.

All-day entries (holidays, "Office", birthdays) are filtered out of the card —
only timed meetings are actionable on a work board. The filter lives in the
client, so `/workboard/calendar` stays a faithful read of the calendar and the
raw events remain available to any other consumer.

## Running the checks

```sh
node --check index.js && node --check client.js   # syntax
node scripts/probe-routes.mjs                     # exercise every route
```

`scripts/probe-routes.mjs` imports `index.js` directly and serves it on an
ephemeral loopback port, which is how the data plane is validated **without
restarting the Harness**. Route registration happens at boot, so an `index.js`
change only reaches the live GUI after a restart; `client.js` changes are picked
up by the client-plugin HMR receiver.

`scripts/restart-and-verify.sh` restarts the Web server in place and logs the
result of every route to `/tmp/workboard-restart.log`.

### Layout verification

Scrolling behaviour is measured, not assumed — a browser binary is already in the
Playwright cache, and Node speaks CDP through its global `WebSocket`, so no
dependency needs installing:

```sh
node scripts/verify-ui.mjs        # drives the REAL GUI: button geometry, overlap, folding, new-conversation board
node scripts/verify-context.mjs   # clicks real board rows, reads the composer's own value back
node scripts/glyph-preview.mjs    # rasterises every inline mark to ASCII art
node scripts/verify-logo.mjs      # brand artwork in the header, plus the vector fallback
node scripts/inspect-image.mjs <path>   # any candidate asset: size, palette, bbox, ASCII at real size
node scripts/measure-panel.mjs    # drives the REAL GUI: opens the panel, measures it
node scripts/layout-harness.mjs   # extracts the REAL CSS from client.js, mounts the real DOM shape, measures it
node scripts/probe-fab.mjs        # the button's box against the composer's box
HARNESS_STRETCH=1 node scripts/layout-harness.mjs   # counterfactual for the flex default
```

`verify-ui.mjs` is the end-to-end one: it clicks the real controls and asserts
the outcome. Note that it must yield a frame after each click — React batches
state updates, so reading the DOM synchronously after `.click()` always sees the
pre-click tree and reports working features as broken.

`measure-panel.mjs` connects to the running Harness, clicks the floating button,
and reports each container's `scrollHeight` / `clientHeight` plus how far it
actually moved when driven. `layout-harness.mjs` exists because the homepage
board only renders while the session list has settled with no current session,
which a headless run cannot arrange (the Harness restores the last session);
it therefore mounts the same markup and the same stylesheet instead.

## Scrolling model

Two nested levels, deliberately:

- **Overall** — the panel's `.dswb-body` and the home board's `.dswb-board-body`
  each scroll the whole deck.
- **Per section** — `.dswb-card-body` caps at `min(46vh, 440px)` and scrolls
  inside the card, so one long list cannot stretch the board.

Two declarations are load-bearing and easy to break by "tidying up":

- `.dswb-card { flex: none }` — without it a card is a shrinking flex item of
  the fixed-height `.dswb-body`, and the deck collapses into ~70px strips
  instead of the body scrolling.
- The home board's height comes from its inline `maxHeight` (computed as the
  space below the composer); adding an explicit CSS height instead would
  over-constrain the box and can push its bottom, scrollbar included, past the
  visual viewport.

`.dswb-card-body` deliberately does **not** set `overscroll-behavior: contain`:
when a section reaches its end the wheel should continue into the panel's scroll
rather than feeling stuck. The board body does set it, because the board is a
bounded surface and chaining its scroll into the page behind it would be wrong.

## Caveats

- Only `https?://` URLs are rendered as links.
- The GitHub search is capped at 12 PRs per refresh with 4 concurrent
  `gh pr view` calls, bounding latency on a large account.
- Jira statuses are the REST API's raw `status.name`, not a normalized
  workflow state.
- Slack unread messages are **not** implemented: reading unread requires a Slack
  user or bot token, which this plugin does not have. A webhook cannot read.
- The homepage board waits for the session list's settled phase (`phase ===
  'ready'`) before showing. Keying only on "no session on screen" made it flash
  on every page load and vanish once the last session resolved.
- The composer lookup depends on the shell's editable element — a `textarea` or a
  `contenteditable` — and a painted, rounded ancestor as its card. If a future
  shell changes either, the button silently falls back to a fixed bottom-right
  position and the board to its default padding — degraded, never broken.
- Adding context to a rich-text composer is a two-frame bridge, and the plugin
  reports `no composer` rather than claiming success when the editor does not
  take the write. A future shell that exposes a draft API removes the bridge and
  this caveat together.

## License

MIT — see the repository's [LICENSE](../../LICENSE).
