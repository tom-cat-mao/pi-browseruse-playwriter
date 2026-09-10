---
'@tom-cat/pi-browser-runtime': minor
---

Ship the relay under the `@tom-cat/pi-browser-runtime` name with a second executable, `pi-browser-runtime`, that runs the managed browser runtime on its own port and data directory.

```bash
pi-browser-runtime
# listening on 127.0.0.1:19989, logs in ~/.pi-browser-use
```

Configuration comes from the environment:

- `PI_BROWSER_HOST` (default `127.0.0.1`)
- `PI_BROWSER_PORT` (default `19989`)
- `PI_BROWSER_TOKEN` (optional, required for non-loopback binds)
- `PI_BROWSER_DATA_DIR` (default `~/.pi-browser-use`)

The runtime runs next to the legacy playwriter relay on `19988`: it has its own logs and never stops a process it does not own. The legacy `playwriter` executable, WebSocket protocol and extension imports stay unchanged, and the Pi package now depends on this runtime.
