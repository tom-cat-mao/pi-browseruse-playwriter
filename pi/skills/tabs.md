# browser_tabs — discovering, attaching, and letting go

Read me when you work with the user's already-open tabs (`discover`/`attach`), when a link opened a
new tab (`sourceTabId`/`activate`), or when deciding between `release` and `close`. Every action
takes explicit ids; there is no implicit current tab.

## list / create

- `list` returns this session's tabs, optionally filtered by `groupId` or by `sourceTabId`.
- `create` needs a `groupId` and a `url` and opens a new tab inside that group.

## discover

- Lists the real tabs already open in the connected browser profiles with their window, title, URL
  and active state — use it when the user points you at a page they are already looking at, then
  pick the entry by title/URL/window.
- Ordering: active tabs first, then tabs in focused windows.
- It is paged, and one page is never every open tab: the response reports
  `total`/`returned`/`nextOffset`/`truncated`. Page size defaults to 20; when `truncated=true`, call
  discover again with `offset=nextOffset` until it is not.
- Filters: `profileId`, `windowId`, `query` (title/URL substring), and `includeManaged=false` to
  hide tabs already under this session's control.
- `offset`/`limit` are Pi-side pagination only: the runtime request carries just the filters.

## attach

- Needs a `candidateId` from discover and takes control of that tab where it is: no reload, no move,
  no regrouping, scroll and form state kept.
- It returns a normal `tabId`, after which the usual page tools apply.

## sourceTabId, activate, and back

- After a link opens a new tab, find it with `list sourceTabId=<the tab you clicked in>` — never by
  URL, and never as "the last tab".
- `activate` makes a tab the active tab of its window again, e.g. to return to the original tab; it
  does not navigate.
- Contrast with `browser_navigate action:"back"`, which follows the tab's real browser history in
  that same tab: it does not reopen or re-navigate the old URL, and a site may not restore its own
  scroll/form state — re-snapshot after it.

## release vs close

- `release` relinquishes this session's control of a tab: it is a tombstone, so a later reconnect
  will not pull the tab back into this session.
- `close` actually closes the tab — use it only for tabs you no longer need.
- Tabs are never closed via `browser.close()`/`context.close()` inside `browser_execute`.

## Refs across these calls

- Any `browser_evaluate`/`browser_execute` conservatively invalidates refs, even a read-only one:
  re-snapshot before the next ref-based action. (The full discipline lives in the tool guidelines.)
