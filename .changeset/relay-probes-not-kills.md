---
'@tom-cat/pi-browser-runtime': patch
---

Stop clients from killing a running relay based on a version string, and stop the runtime from treating a busy port as a successful start.

Ports are probed with explicit states instead of an optimistic "running" flag:

- `ready`: a valid `/version` payload and every required managed capability is `true`
- `incompatible`: the managed protocol answers but a required capability is `false` (reported with the missing names)
- `occupied`: HTTP answers but the payload is not a relay version (or is invalid JSON)
- `unauthorized`: HTTP 401/403 from a token-protected listener
- `unreachable`: nothing is listening

Reachable is not the same as usable: `managedGroups: false` or `persistentOwnership: false` no longer counts as an available runtime. `pi-browser-runtime` exits successfully on `EADDRINUSE` only when another instance is fully capable; anything else exits with an error and a reason. `ensureManagedRuntime` refuses to use or replace incompatible and unsupported listeners, probes the requested host, never auto-starts remote hosts, and deduplicates in-flight probes per host/port/token. Full URLs are used as-is for probes (no default port injected into https tunnels) and bare IPv6 hosts are bracketed.
