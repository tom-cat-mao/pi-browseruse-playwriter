# Browser Use (managed runtime) — usage discipline

You can drive the user's real Chrome (their real login sessions, cookies) through
the `browser_*` tools. These talk to a paired **managed browser runtime** over a
local HTTP contract — no new browser is launched by you, and cookies/logins are
the user's real ones. You only execute and report facts; you own every decision.

## Resource model: profiles → groups → tabs

The runtime is explicit — there is **no implicit "current page"** and no matching
by URL or title. Everything is addressed by id:

- **Profile** — an installed Chrome identity. List them with `browser_profiles`.
  A `profileId` is required to create a group; a profile must be `connected`.
- **Group** — a named tab group owned by *this* Pi session and bound to one fixed
  profile for its lifetime. Create with `browser_groups` (`action:"create"`,
  `name`, `profileId`). Same-name groups are allowed — each has its own `groupId`.
- **Tab** — created inside a group with `browser_tabs`
  (`action:"create"`, `groupId`, `url`). Use the returned `tabId` for every page
  tool. `browser_groups list` / `browser_tabs list` only ever show *this*
  session's resources.

Typical start of a task:

1. `browser_profiles` → pick a connected `profileId`.
2. `browser_groups` create with a `name` + that `profileId` → get `groupId`.
3. `browser_tabs` create with that `groupId` + a `url` → get `tabId`.
4. Drive the page with `tabId`.

## Core loop: observe → act → observe

Never chain actions blindly. For every step:

1. `browser_navigate` (`tabId`, `url`) to load. Pages redirect — check the URL.
2. `browser_snapshot` (`tabId`) to read the page as an accessibility tree.
3. Act with one tool (`browser_click`, `browser_fill`, ...).
4. `browser_snapshot` / `browser_evaluate` again to verify. If nothing changed,
   you hit the wrong element or it is still loading — re-observe, don't re-click.

## Selectors: refs over CSS

- `browser_snapshot` returns a `snapshotId` and `aria-ref=eN` refs. To click/fill
  a ref, pass the ref as `selector` **and** its `snapshotId` (the `@eN`
  shorthand also works).
- Refs are only valid against the snapshot that produced them. If the page
  changed, take a fresh `browser_snapshot` first — stale refs throw
  (`stale-snapshot`).
- Plain CSS/role selectors are matched **strictly**: an ambiguous selector is an
  error, never a silent `.first()`. When you need a specific element, use a ref.

## Reading vs seeing

- Prefer `browser_snapshot` (text, cheap, gives refs) to read state.
- `browser_evaluate` (`tabId`, `code`) runs JS in the page (`document`/`window`,
  async ok). End with `return <value>` — a bare expression returns undefined.
- `browser_screenshot` (`tabId`) returns an inline image when your model can see
  images; pass `path` to save, `fullPage` for the whole page, `labels` to overlay
  interactive markers. (There is no PDF tool.)

## Console logs and network

- `browser_logs` (`tabId`, optional `limit`) returns buffered console output —
  check it after navigate/click/submit for hydration errors and failed requests.
- `browser_network` (`tabId`, `action:"start"|"list"|"stop"`, optional url
  substring `filter`): start before the triggering action, list to inspect,
  stop to clear.

## browser_execute (escape hatch)

`browser_execute` (`tabId`, `code`, optional `timeout` ms, capped at 120s) runs a
Playwright snippet against that tab's `page` in the runtime's isolated sandbox.
Use it for iframes, custom waits, multi-step flows the typed tools don't cover.
Each call is independent: return plain data or ids to carry forward, but
`page`/locator/CDP handles cannot be reused across calls — re-acquire them each
time. Await every action to completion and leave no background timers running.
`keyboard`/`mouse`/`touchscreen` input is not supported right now.
Never call `browser.close()`/`context.close()` — close tabs with `browser_tabs`.
Code is sent as JSON: no shell quoting layer, so quotes/`$`/backticks are safe.

## Cancellation and outcomes

If a call is cancelled or times out, the result reports the runtime's `outcome`
(`not-started` vs `unknown`). `unknown` means the action may have partially
happened — re-observe with a snapshot before assuming anything; nothing is
auto-replayed.

## Session hygiene

- Identity is automatic: every call carries this Pi session's UUID. You never
  pass a session id.
- Close tabs you no longer need with `browser_tabs` (`action:"close"`), or
  `action:"release"` to relinquish this session's control of a tab when you are
  done with it so a later reconnect won't pull it back into this session (the
  runtime never re-opens tabs on its own).
- On Pi session shutdown the runtime frees this session's workers automatically;
  it does **not** delete your groups/tabs (persistent ownership) and never stops
  the shared runtime.
- `/browser-status` inspects the runtime (reachability, capabilities, connected
  profiles) without creating anything.
