# DSH Plugins

A collection of plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH). Each plugin lives in its own package under `packages/` and is installed
into a DSH profile independently.

| Package | What it adds |
| --- | --- |
| [`packages/workboard`](packages/workboard) | A work dashboard in the Harness Web GUI: GitHub pull requests with CI and discussion state, Jira issues assigned to you grouped by project, today's Google Calendar agenda, and the git state of every registered workspace — plus click-to-add-context into the composer |
| [`packages/browser`](packages/browser) | A real browser for the agent: CDP-driven tools that navigate, click, type, read the console and network, manage tabs, wait, upload, and scroll — with screenshots rendered inline in the conversation and, when the model accepts images, delivered to the model itself |

## How a plugin is put together

A DSH plugin is a package with up to two halves:

- A **host half** (the package's main entry) runs inside the Harness server
  process. It can register HTTP routes on the Harness web server, shell out, and
  read local files — everything a browser cannot do.
- A **client half** (the `./client` export) is a browser bundle registered
  through `window.__ModuleLoader__.load`. It renders React components into the
  shell's slot system and talks to its own host half over same-origin `fetch`.

The split is why a plugin can show local data (git, CLI tools, filesystem) in the
browser without exposing credentials to it. `packages/workboard` is a worked
example of the whole shape: a `/workboard` route family on the host side and a
slot registration on the client side.

The package manifest declares which half is which:

```json
{
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-layout"]
    }
  }
}
```

## Installing a plugin into a profile

DSH profiles live under `$DSH_HOME/profiles/<name>` (by default `~/.dsh/profiles`).
A profile is a package that depends on the plugins it uses and a
`cordis.patch.yml` that lists them.

1. Add the package as a dependency of the profile. A local checkout installs by
   link, which is what makes development against it practical:

   ```jsonc
   // ~/.dsh/profiles/web/package.json
   {
     "dependencies": {
       "dsh-workboard": "link:/absolute/path/to/dsh-plugins/packages/workboard"
     }
   }
   ```

   ```sh
   cd ~/.dsh/profiles/web && pnpm install
   ```

2. Add it to the profile's patch layer:

   ```yaml
   # ~/.dsh/profiles/web/cordis.patch.yml
   - insert:
       - id: dsh-workboard
         name: dsh-workboard
   ```

3. Restart the Harness web server. Route registration and the boot graph are
   computed at startup, so a new host half needs a restart; after that a browser
   refresh is enough for client-half changes.

Each package's own README covers its configuration, its routes, and how to verify
it.

## Repository layout

| Path | Purpose |
| --- | --- |
| `packages/<name>/` | One plugin per directory: host entry, client bundle, README |
| `packages/<name>/scripts/` | Per-plugin verification tools |

## Development

There is no root build step: each plugin ships its host entry and client bundle
as plain ESM, so the repository is consumed directly through the profile link
above. Type-checking, linting, and bundling are each plugin's own concern.

Verification here is expected to be empirical rather than assumed. The workboard
plugin carries scripts that drive the real GUI in a real browser over the Chrome
DevTools Protocol, using a browser binary its dependencies already put on disk
and Node's global `WebSocket` — so nothing extra has to be installed:

```sh
cd packages/workboard
node scripts/probe-routes.mjs      # every host route, without restarting the Harness
node scripts/verify-ui.mjs         # geometry, overlap, folding, placement — in the running GUI
```

## License

MIT — see [LICENSE](LICENSE).
