---
"@tom-cat/pi-browser-runtime": patch
---

Set an explicit Firefox extension-page CSP that permits only packaged scripts and omits upgrade-insecure-requests, preserving the local relay's plain WebSocket connection. Validate the policy during Firefox builds and packaging.
