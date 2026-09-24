# Firefox (webextension) backend detail

Read me when the profile in play is Firefox, or when `browser_execute`/`browser_evaluate` behaves
differently than you expect: DOM-only input, isolated-world evaluate, bounded waits, and APIs that
fail explicitly instead of degrading.

## browser_evaluate on Firefox

- It runs in an isolated world: this needs Firefox 153+ and the add-on's optional page-JavaScript
  permission.
- The DOM is available; the page's own script globals may not be.
- End the code with `return <value>` — a bare expression returns undefined. Only the JSON-serializable
  result value comes back.

## browser_execute on Firefox

- It runs `dom-compatible` Playwright code in the runtime sandbox: other APIs are limited to that
  documented subset and fail explicitly when unsupported.
- The optional `timeout` is capped by the runtime at 120000 ms. Wait timeout: default 5000 ms;
  explicit timeouts and `page.setDefaultTimeout` accept 1–5000 ms, and every wait is also bounded by
  the execute call's remaining deadline.
- Input is DOM-only: `page.keyboard.press`/`page.keyboard.type` act on the focused element, and
  Chrome's raw keyboard/mouse/touchscreen objects are not available here either. DOM input cannot
  create trusted native browser input, so a site may reject an action whose element was found —
  re-observe the outcome instead of repeating it or widening permissions.

### Firefox execute micro-semantics

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
- Logs and network capture start when the tab is instrumented or capture is explicitly
  started; earlier activity is not reconstructed. Read the capture metadata and limitation
  messages before reading an empty result as "nothing happened".
