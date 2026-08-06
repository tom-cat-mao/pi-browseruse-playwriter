# @tom-cat/pi-browser-use-extension

pi extension package that drives the **user's real Chrome** (their login
sessions) through the [Playwriter](https://playwriter.dev) browser extension +
relay server. No new browser, no cloud — the tools automate the tab you
already have logged in.

## Requirements

- **pi** (`@earendil-works/pi-coding-agent`)
- **Chrome** with the **Playwriter extension** installed and connected
  (relay on `127.0.0.1:19988`; check with `/browser-status`).
- Remote access: set `PLAYWRITER_HOST` and `PLAYWRITER_TOKEN` env vars
  (matches the playwriter CLI conventions).

## Install

```bash
pi install git:github.com/tom-cat-mao/pi-browseruse-playwriter
# or locally during development
pi install ./pi
# try without installing (current run only)
pi -e ./pi/extensions/index.ts
```

## Tools

| Tool | Purpose |
|---|---|
| `browser_navigate` | open a URL (reuse tab or `newTab`, optional `group_title`) |
| `browser_snapshot` | accessibility tree with `aria-ref=eN` refs |
| `browser_click` | click by ref (`aria-ref=eN` / `@eN`) or CSS |
| `browser_fill` | set input/textarea/contenteditable text (clear-and-insert) |
| `browser_evaluate` | run JS in the page (IIFE-wrapped, `RESULT:` JSON line) |
| `browser_screenshot` | labeled screenshot, inline when the model sees images |
| `browser_tabs` | list / find / close_tab / close_session |
| `browser_network` | capture & filter page responses (start/list/stop) |
| `browser_save_as_pdf` | `page.pdf` (headless/direct-CDP only) |
| `browser_execute` | escape hatch: raw Playwright snippet in the session sandbox |

Also registers the `/browser-status` command (relay version, extension
connection, bound session, capabilities).

## How it works

- First tool call probes the relay; if it is down, the extension auto-starts
  it via `playwriter session new` (falls back to
  `npx -y playwriter@latest session new`) and binds a relay session named
  `pi-<8-char-pi-session-id>`. Everything after is plain HTTP.
- Sessions are 1:1 with pi sessions; the relay session is deleted on
  `session_shutdown`. Stale sessions are recreated automatically once.
- All tool calls are serialized (browser state is global), images from
  `browser_screenshot` are inlined as base64, and capabilities are probed
  with silent degradation (stock relay lacks `/cli/capabilities` — the
  package keeps working with session-group/consent/audit features off).

## Development

```bash
pnpm --filter @tom-cat/pi-browser-use-extension test   # vitest (58 tests)
pnpm --filter @tom-cat/pi-browser-use-extension typecheck
```

Zero runtime dependencies — only global `fetch` + node built-ins; pi packages
(`@earendil-works/*`, `typebox`) are peer dependencies.

## Known limitations

- `browser_save_as_pdf` requires headless Chromium; headed extension sessions
  error (Playwright limitation).
- `browser_tabs find active:true` switches to the most recently attached tab;
  the relay does not expose the user's focused tab.
- Tab-group naming (`group_title`) takes effect when the relay supports
  session groups (capability `sessionGroups`); stock relays ignore it.
