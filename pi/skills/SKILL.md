---
name: browser-use
description: Drive the user's real Chrome or Firefox tabs through the browser_* tools and the paired managed runtime — joining a tab the user already has open, reading or extracting page content, and exporting it. Use when driving the user's real browser tabs, extracting full-page content, or when a browser_* tool needs backend-specific detail such as Firefox execute waits, snapshot refs, or capability limits.
---

# Browser Use — backend detail

The operating discipline (profiles → groups → tabs with explicit ids, discover/attach,
the observe → act → observe loop, refs with their snapshotId, release/close, cancellation
outcomes) is resident in the `browser_*` guidelines in the system prompt, and each tool's
own behavior is in its description. This file only carries backend detail that those two do
not, so read it on demand.

Keep the loop in mind anyway: snapshot to read, one acting tool, then a fresh snapshot to
verify — pages redirect and change, so never chain actions blindly.

## Getting-started page

Each browser build bundles a local getting-started page covering the source install, the
paired runtime, and the profiles → discover/attach → snapshot → release flow. Point the user
there instead of inventing setup steps:

- Chrome: extension options, or the icon's context menu.
- Firefox 139+: add-on options, or the popup's Help link.
- A Chrome development build uses its pre-existing idle-icon and install paths.

The page never connects to the runtime or starts anything itself.

## Firefox execute micro-semantics

`browser_execute` on Firefox runs `dom-compatible` Playwright code in the runtime sandbox:

- Wait timeout: default 5000 ms; explicit timeouts and `page.setDefaultTimeout` accept
  1–5000 ms, and every wait is also bounded by the execute call's remaining deadline.
- `page.waitForURL` takes a URL string with optional `*`/`**` wildcards, never a regular
  expression. With `waitUntil` it waits for the URL and then the load state, applying the
  wait limit to each phase.
- `page.waitForLoadState` supports `load` and `domcontentloaded`; `commit` adds no wait and
  `networkidle` is unsupported.
- `page.waitForSelector` returns a locator, or `null` for `hidden`/`detached` — never an
  ElementHandle.
- `page.waitForFunction` uses evaluate, requires the optional Firefox page-JavaScript
  capability, and returns the first truthy plain JSON value rather than a JSHandle.
- Refs must carry their snapshotId: `page.locator(ref, { snapshotId })`, or call `snapshot`
  in the current execute and use `refToLocator({ page, ref })` — which returns `null` when
  the ref is absent. Preserve the returned selector's snapshot suffix: bare refs are never
  attached to the latest snapshot automatically.
- DOM input cannot create trusted native browser input, so a site may reject an action whose
  element was found. Re-observe the outcome instead of repeating it or widening permissions.
- Logs and network capture start when the tab is instrumented or capture is explicitly
  started; earlier activity is not reconstructed. Read the capture metadata and limitation
  messages before reading an empty result as "nothing happened".
