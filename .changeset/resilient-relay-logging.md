---
'@tom-cat/pi-browser-runtime': patch
---

Keep the relay alive when logging fails, and never wipe a running relay's logs.

Both the relay log and the CDP JSONL log now open in append mode instead of truncating on startup, so a second process racing for the same data dir cannot erase the running relay's history. Buffers are bounded, files rotate by size or line budget, and filesystem errors are swallowed: a full or unwritable disk no longer rejects the write queue, stops the relay, or grows memory without bound. Dropped lines are recorded with an overflow marker so gaps in the logs are visible.
