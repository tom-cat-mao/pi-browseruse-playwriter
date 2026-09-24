---
"@tom-cat/pi-browser-use-extension": minor
---

`browser_snapshot` takes an optional `interactiveOnly` that narrows the tree to the actionable controls, for when targets are all that is needed instead of the readable page text.

`browser_click` and `browser_fill` now document that their `selector` is a plain Playwright selector (CSS, `text=`, `role=`) that needs no snapshot, and the cross-tool guidelines tell the model to act directly on a control it can name by visible text, role, or label rather than snapshotting first. Snapshot→ref remains the path for unknown pages, content reads, and strict selectors that error. Activating the `browser` gateway now also pre-warms the runtime in the background, so the first browser tool call of a session no longer pays the cold start.
