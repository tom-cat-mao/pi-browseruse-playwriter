---
'@tom-cat/pi-browser-runtime': patch
---

Stop clients from killing a running relay based on a version string.

The client now probes the port before acting: HTTP 401 is reported as an authentication error instead of "server down", an HTTP listener without `/version` is treated as a foreign process, and a relay with an older version is used instead of being replaced. Use `playwriter serve restart` when you explicitly want to replace it. The managed runtime uses capability negotiation instead of version comparison, so a Pi client only talks to a runtime that advertises the managed browser API.
