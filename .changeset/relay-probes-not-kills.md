---
'@tom-cat/pi-browser-runtime': patch
---

Stop clients from killing a running relay based on a version string, and stop the runtime from pretending a busy port is a successful start.

Ports are now probed with explicit states instead of an optimistic "running" flag:

- `ready`: a valid `/version` payload (only this counts as a relay)
- `occupied`: HTTP answers but the payload is not a relay version (or is invalid JSON)
- `unauthorized`: HTTP 401/403 from a token-protected listener
- `unreachable`: nothing is listening

`pi-browser-runtime` exits successfully on `EADDRINUSE` only when another instance answers the managed capabilities endpoint. A legacy relay, a foreign process, or a token-protected listener makes it exit with an error rather than reporting a false start. `ensureManagedRuntime` treats capabilities as the only ready signal, and remote hosts are probed but never auto-started.
