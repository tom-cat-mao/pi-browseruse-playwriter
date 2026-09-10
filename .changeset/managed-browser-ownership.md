---
'@tom-cat/pi-browser-runtime': minor
---

add managed browser ownership to the extension for Pi sessions

the extension now keeps an authoritative ownership registry in `chrome.storage.local` (with `chrome.storage.session` tracking the browser run epoch) and exposes a new managed control protocol over the existing websocket:

- `browserInventory` broadcasts after connect and on every ownership change, with logical group/tab ids kept separate from Chrome numeric ids
- `browserRequest` handles `groups.list/create/rename/close` and `tabs.list/create/close/release/resolve`
- `tabs.create` creates a blank tab in the group window, groups it immediately, persists the record, attaches the debugger, navigates, then verifies the Chrome group before returning `ready` with `targetId`/`cdpSessionId`
- popups and `target=_blank` tabs opened from a managed tab inherit its group; unrelated user popups are left untouched
- dragging a tab out of a managed group, the Chrome debugger infobar cancel, or an explicit release writes a release tombstone that reconnects never pull back
- relay reconnects and service-worker restarts restore verifiable bindings without replaying page actions; after a full Chrome restart (or lost `storage.session`) unverifiable resources become `needs-rebind` instead of being adopted by reused numeric Chrome ids
- persisted create dedup ledger: retrying the same sessionId + requestId + payload returns the original group/tab across reconnects and service-worker restarts, and reusing a requestId with a different payload is rejected
- creates write a preallocated logical id and a `pending` ledger entry before any Chrome side effect; an interrupted attempt is only resumed by re-attaching a verifiably owned tab (navigation is never replayed) and otherwise answers `outcome-unknown`
- per-group serialized mutations, so concurrent first tab creates cannot materialize two Chrome groups for one logical group
- `request.cancel` stops future steps of a same-session request (never queued behind group locks); a dropped websocket invalidates its generation, cancels its control requests and drops their responses instead of answering on a newer socket
- ownership is never touched through stale numeric ids: chrome-id lookups are pinned to the current browser epoch, failed creates only remove tabs that are still provably ours, and a browser-wide debugger cancel stops automation without dissolving logical groups
- storage failures surface as `internal-error` (no inventory advertised, records never overwritten, failed write queues recover with a fresh authoritative read); manual Chrome group renames/window moves are synced by Chrome group id, never by title
- debugger listeners stay registered for the worker lifetime so user actions (infobar cancel, tab moves) are recorded even while the relay is offline; reconnects reconcile with a revision fence so a snapshot taken while observing Chrome cannot release newer records
