---
'playwriter': minor
---

add managed browser ownership to the extension for Pi sessions

the extension now keeps an authoritative ownership registry in `chrome.storage.local` (with `chrome.storage.session` tracking the browser run epoch) and exposes a new managed control protocol over the existing websocket:

- `browserInventory` broadcasts after connect and on every ownership change, with logical group/tab ids kept separate from Chrome numeric ids
- `browserRequest` handles `groups.list/create/rename/close` and `tabs.list/create/close/release/resolve`
- `tabs.create` creates a blank tab in the group window, groups it immediately, persists the record, attaches the debugger, navigates, then verifies the Chrome group before returning `ready` with `targetId`/`cdpSessionId`
- popups and `target=_blank` tabs opened from a managed tab inherit its group; unrelated user popups are left untouched
- dragging a tab out of a managed group, the Chrome debugger infobar cancel, or an explicit release writes a release tombstone that reconnects never pull back
- relay reconnects and service-worker restarts restore verifiable bindings without replaying page actions; after a full Chrome restart unverifiable resources become `needs-rebind` instead of being adopted by URL/title guessing
