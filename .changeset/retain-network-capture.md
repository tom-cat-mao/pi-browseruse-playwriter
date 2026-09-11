---
'@tom-cat/pi-browser-runtime': patch
---

Retain bounded page network metadata in the long-lived runtime when an executor worker is cancelled, times out, or is replaced. Network list and stop now report whether a capture is active, stopped, interrupted, or was never started, while preserving their existing value shapes.

Failed replacement starts preserve the previous evidence, and stop fences out older queued or in-flight starts without waiting behind page operations.

Queue wait time now consumes the original browser request deadline, and executor workers receive only the remaining timeout budget.
