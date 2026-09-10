---
'@tom-cat/pi-browser-runtime': patch
---

Fix managed executor request lifetimes and invalidation ordering. Timed-out or
cancelled actions now report unknown outcomes after their worker control
connection is stopped, raw execution timers and CDP listeners cannot outlive
their request lease, and replacement workers wait for the previous worker to
finish shutting down.
