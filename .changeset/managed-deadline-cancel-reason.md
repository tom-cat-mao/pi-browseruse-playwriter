---
'@tom-cat/pi-browser-runtime': patch
---

Report a managed executor deadline as `timeout`, not `cancelled`.

- The relay now aborts its pending controller with an internal typed cancellation reason and passes the same reason to `ManagedExecutorPool.cancel()`, so both the signal listener and an explicit cancel keep the first abort reason instead of always classifying the stop as a user cancel.
- A relay deadline that terminates an active worker returns `code=timeout` with `outcome=unknown`; an explicit user/client cancel stays `cancelled`, and a request stopped before dispatch stays `not-started`. Worker termination, capture retention and no-replay semantics are unchanged.
