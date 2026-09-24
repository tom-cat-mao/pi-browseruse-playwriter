# @tom-cat/pi-browser-use-extension

The Pi package for Pi Browser Use: `browser_*` tools that drive the **user's real
Chrome or Firefox** — their own tabs, cookies and login sessions — through a paired
**managed browser runtime** (`@tom-cat/pi-browser-runtime`). No new browser is
launched and no cloud service is involved.

The package is transport and tooling only — no agent loop, HITL, captcha or confirmation
logic: the tools report facts and the Pi LLM owns every decision. Model-side usage discipline
ships with the tool descriptions and guidelines; the on-demand
[`skills/SKILL.md`](./skills/SKILL.md) index and its topic files carry the backend detail.

## Install

No npm release yet: install from a source checkout after building the runtime.

```bash
pnpm bootstrap
pnpm --filter @tom-cat/pi-browser-runtime build
pi install ./pi
```

The browser extension is a separate install — it holds the browser connection. See the
repository [README](../README.md#install-the-chrome-extension) for the Chrome ZIP path
and the [Firefox development build](../README.md#load-the-firefox-development-extension);
a ZIP installs neither the Pi package nor the runtime.

Once installed, the package registers:

- **13 `browser_*` tools** — profiles, groups and tabs, page reading and actions,
  screenshots, network/console capture, content extraction, an execute escape hatch.
- **`/browser-status`** — an inspect-only command reporting runtime reachability,
  capabilities and connected profiles. It creates nothing.
- **A `session_shutdown` hook** — releases this Pi session's workers when the session
  ends; it never deletes groups or tabs and never stops the shared runtime.

## How the pieces fit

```
Pi session ──browser_* tools──▶ Pi package ──HTTP v1──▶ managed runtime
                                              spawned on demand   127.0.0.1:19989
                                             data in ~/.pi-browser-use ◀┈WebSocket┈
   the user's real tabs ◀── browser extension (Chrome CDP / Firefox DOM)
```

- The Pi package is the only client: it speaks the frozen HTTP v1 contract and, on first
  tool use, launches the runtime once if the loopback port is genuinely free. A slow,
  token-protected (401) or foreign listener is never launched over or replaced.
- The runtime owns the browser connection; the extension connects over a WebSocket and
  drives Chrome via CDP or Firefox via an ordinary WebExtension with a DOM backend
  ([platform differences](../docs/exec/firefox-extension-guide.md)).
- Every call carries the Pi session UUID automatically and is scoped to that session;
  the extension, not a URL or title match, is the source of truth for tab ownership.

## Tools

| Tool | One line |
|---|---|
| `browser_profiles` | read-only listing of installed profiles, connection state and backend capabilities (`profileId` comes from here) |
| `browser_groups` | list/create/rename/close this session's named groups; a group is bound to one profile for its lifetime |
| `browser_tabs` | list/create/close/release managed tabs; `discover`/`attach` takes over a tab the user already has open (in place, no reload or move), `activate` focuses one |
| `browser_navigate` | load a URL in a tab, or `action:"back"` through real browser history |
| `browser_snapshot` | read the tab as an accessibility tree with `aria-ref=eN` refs plus a `snapshotId`, optionally scoped to one matching element |
| `browser_click` | click by snapshot ref + `snapshotId`, or by a strict single-match CSS/role selector |
| `browser_fill` | replace an input/textarea/contenteditable value |
| `browser_evaluate` | run JS in the tab and return a value; isolated world on Firefox |
| `browser_execute` | escape hatch: a Playwright snippet bound to the tab's `page` in an isolated worker |
| `browser_extract` | export page content as markdown/text/html or an image manifest — windowed reads, optional full extraction and saved images written to artifacts |
| `browser_screenshot` | screenshot a tab inline, optionally saved to a path, `fullPage`, or with element labels |
| `browser_network` | capture/list/stop a tab's network responses; retained entries survive stop |
| `browser_logs` | buffered console/log output for a tab |

There is no PDF tool and no implicit current page: every page tool takes an explicit
`tabId`, and selectors match strictly — zero or multiple matches is an error, never a
silent `.first()`.

## Safety and ownership

- **Capability gating.** Extraction and image saving are served by the target tab's
  browser build: a profile that does not advertise `page.extract` (or the matching
  asset mode) is refused before anything is sent or downloaded.
- **Refs cannot drift.** A ref-based `click`/`fill` must carry the `snapshotId` it came
  from; stale refs fail, and any `evaluate`/`execute` invalidates the latest snapshot.
- **Artifacts stay in one place.** The runtime writes exported pages, images and
  screenshots, confined to its artifacts directory (`~/.pi-browser-use/artifacts` by
  default, `$PI_BROWSER_DATA_DIR/artifacts`): escaping paths are refused.
- **Ownership is explicit.** Attach adopts one tab, never the rest of its native group;
  `release` is a tombstone, so a reconnect cannot pull back a tab the user took away;
  nothing is replayed — an interrupted mutation returns `outcome: "unknown"`.

## Configuration

The Pi package reads these from the environment (a manual runtime honors the same names):

| Env | Meaning | Default |
|---|---|---|
| `PI_BROWSER_HOST` | runtime host (bare host or full `http(s)://…`) | `127.0.0.1` |
| `PI_BROWSER_PORT` | runtime port | `19989` |
| `PI_BROWSER_TOKEN` | bearer token, if the runtime requires auth | none |
| `PI_BROWSER_DATA_DIR` | runtime data dir (logs, `artifacts/`) | `~/.pi-browser-use` |
| `PI_BROWSER_RUNTIME_PATH` | runtime CLI entry to launch (`.ts` via `tsx`, otherwise `node`) | packaged `pi-browser-runtime` bin |

A `PI_BROWSER_HOST` outside loopback is a remote runtime — no local daemon is spawned, and `npx playwriter` is never used.

## Development

```bash
pnpm --filter @tom-cat/pi-browser-use-extension test        # vitest, real local HTTP server
pnpm --filter @tom-cat/pi-browser-use-extension typecheck   # tsc --noEmit
pnpm --filter @tom-cat/pi-browser-use-extension load-check  # jiti load + registration assert
```

Tests exercise the wire contract, response validation and output bounds against a real
`node:http` server; none start a browser or a real runtime.

## Read more

- [`skills/SKILL.md`](./skills/SKILL.md) — the on-demand skill index; `extract.md`,
  `firefox.md` and `tabs.md` hold the backend detail the resident prompt leaves out.
- [Repository README](../README.md) — extension install, release status, build commands.
- [Browser runtime contract](../docs/exec/browser-runtime-contract.md) — the HTTP/WS contract all three pieces implement.
- [Firefox guide](../docs/exec/firefox-extension-guide.md) — the DOM backend's supported operations and limits.
