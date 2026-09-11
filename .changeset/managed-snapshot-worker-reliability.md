---
'@tom-cat/pi-browser-runtime': patch
---

Make managed snapshots and page actions fail fast and report truthfully.

- **Bounded snapshot scope selectors.** A `locator` scope that matches no elements or more than one now returns a clear, short error (e.g. "matched no elements" / "matched N elements; pass a selector that resolves to exactly one element") instead of auto-waiting up to the navigation timeout until the request is aborted and the worker dies. `count()` does not auto-wait and the scope-marking `evaluate` carries a native 5s timeout, with no uncancelled races left holding the scope attribute.
- **Refs match the visible snapshot window.** Returned refs are now restricted to the same `search`/`offset`/`limit` window as the rendered text, preserving each element's `shortRef` identity. A search with no matches returns empty refs instead of hundreds of refs for lines the caller never sees.
- **Native `<details>`/`<summary>` get a valid selector.** Chrome exposes these as the `disclosuretriangle` AX role, which is not a Playwright ARIA role. They now resolve to a DOM-backed selector (stable id/testid, else `summary` with a document-order `>> nth=`) so the locator identifies the exact node; `role=disclosuretriangle` is never emitted. Native selects are unaffected.
- **Clearer stale-ref explanations.** Snapshot-ref errors now say whether no snapshot is current (a prior navigate/click/fill/evaluate/execute invalidated it), the snapshot was replaced, or the ref was filtered out by the search/offset/limit window — and how to recover.
- **Click reports an observation, not a settled navigation.** The click result URL is the tab state observed immediately after the click, never a promise that a triggered navigation has finished; no sleeps or auto-goto.
- **`full` snapshot flag is coherent.** `full: true` forces the complete readable tree (labels, contexts, text) even when a caller would narrow to interactive-only, and stays subject to the same line/character caps and windowing.
- **Observed page context on results.** Page operations attach a `pageInfo { tabId, url, title? }` built from data already known (cached `page.url()` and any title the operation already computed), with no added unbounded `page.title()` query.
