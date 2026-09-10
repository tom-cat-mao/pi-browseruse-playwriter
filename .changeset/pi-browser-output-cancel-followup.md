---
'@tom-cat/pi-browser-use-extension': patch
---

Harden the managed browser tools' output bounding and cancellation edges.

- Output budgets are now measured in UTF-8 bytes (not characters), so multibyte content such as thousands of Chinese group names or long URLs is capped at its true size and truncation markers are counted against the budget. Byte-truncation snaps to a code-point boundary so an emoji is never split into a replacement character, and a truncation marker is only appended when it fits within the remaining budget.
- Large listings (groups/tabs/profiles) are truncated item-by-item into valid, parseable JSON with a `${key}Truncated` count instead of emitting the full giant array or slicing the JSON into an invalid string. Room for every list's key and count marker is reserved up front so a combined profiles+groups+tabs listing stays within budget. Free-form display fields (group name, tab url/title, profile label) are individually clamped, so a single resource with a huge title/url can never overflow the block or drop its `tabId`/`groupId`/`snapshotId`. An oversize evaluate `value` is emitted as an explicitly-truncated string sized from its real header/footer byte cost.
- `ensureRuntime(signal)` removes its abort listener once the launch race settles, so a caller cancelling during a shared launch no longer leaks a listener on the long-lived signal.
- Clarified `browser_tabs` release, `browser_execute`, and the skill docs: release relinquishes this session's control (the runtime never re-opens tabs on its own); `browser_execute` calls are independent (no reusing page/locator/CDP handles across calls), must await all actions and leave no background timers, and keyboard/mouse/touchscreen input is unsupported for now.
