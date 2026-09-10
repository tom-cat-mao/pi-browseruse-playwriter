---
'@tom-cat/pi-browser-runtime': patch
---

Keep the relay alive when logging fails, and never wipe a running relay's logs.

Both the relay log and the CDP JSONL log open in append mode instead of truncating on startup, so a second process racing for the same data dir cannot erase the running relay's history. Rotation counters start from the size and line count already on disk, so an existing large file still rotates at the configured budget. Buffers are bounded, files rotate by size or line budget, and filesystem errors are swallowed: a full or unwritable disk no longer rejects the write queue, stops the relay, or grows memory without bound. Serializing an entry that cannot be stringified (for example a payload containing BigInt) writes a `cdpLogSerializeError` marker instead of throwing. Dropped lines are recorded with an overflow marker so gaps in the logs are visible.
