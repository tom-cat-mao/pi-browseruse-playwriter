---
'@tom-cat/pi-browser-runtime': patch
---

Publish released managed resources in the extension inventory so `tabs.release` tombstones stay visible to the runtime.

After releasing a tab, `tabs.list` keeps returning it with `state: released` and page operations on it fail with `resource-released` instead of `resource-not-found`. Released groups are published together with their tabs so the inventory stays internally consistent (the runtime rejects tabs that reference unknown groups). Tombstones only record state and never re-authorize work: released records keep no `targetId`/`cdpSessionId` and stay hidden from the active session lookups.
