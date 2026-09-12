---
'@tom-cat/pi-browser-runtime': patch
---

Keep the Firefox MV3 background page alive while a local runtime stays connected.

Firefox suspends a non-persistent background page after 30s without activity it counts, and a bare WebSocket round-trip is not counted, so replying to a relay ping did not keep the page alive. Each ping now performs one read-only `getBrowserInfo` parent call, which is one of the activities Firefox counts. Failures are contained, only the live socket answers, and no timer, permission, preference or loopback handshake/Origin/Host/CSP change is introduced. When the runtime disconnects the pings stop, the background is free to suspend again, and the existing reconnect alarm still wakes it.
