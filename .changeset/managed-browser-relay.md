---
'playwriter': minor
---

Add the managed browser runtime API: `GET /browser/v1/capabilities`, `GET /browser/v1/profiles` and `POST /browser/v1/request`.

The relay now caches each extension profile's authoritative resource inventory (`browserInventory` websocket snapshots), enforces session ownership on every group/tab operation, dedupes resource requests by `requestId`, serializes page operations per profile and exposes session-scoped managed CDP connections on `/cdp` (`browserSessionId`/`browserEpoch` query) that only see their own tabs. `session.release` frees the isolated executor without deleting groups or tabs, and cancelled or timed-out actions report `outcome: unknown` instead of being replayed.

Legacy `/extension` and `/cdp` clients keep working with the existing message and connection formats.

Cancelling a request also notifies the extension for control commands that are already in flight (`request.cancel` with `sessionId` + `targetRequestId`), including timeouts and dropped HTTP clients; cancelled or timed-out work keeps its `unknown` outcome and is never replayed. Inventory snapshots that are internally inconsistent (duplicate ids, tabs pointing at missing or foreign groups, wrong profile/session owners, or `ready` resources without their Chrome/CDP identity) are rejected instead of cached. Managed CDP clients are limited to an explicit root-method allowlist scoped to their own session/target, with profile-wide and wrapper transports denied.
