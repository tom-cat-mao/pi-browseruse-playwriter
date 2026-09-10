---
'@tom-cat/pi-browser-runtime': patch
---

Keep the relay alive when logging fails.

Both the relay log and the CDP JSONL log now use bounded in-memory buffers, rotate by size or line budget, and swallow filesystem errors: a full or unwritable disk no longer rejects the write queue, stops the relay, or grows memory without bound. Dropped lines are recorded with an overflow marker so gaps in the logs are visible.
