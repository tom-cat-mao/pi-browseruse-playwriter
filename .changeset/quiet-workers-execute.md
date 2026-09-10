---
'playwriter': minor
---

Add an isolated managed executor pool for Pi browser sessions. Managed page
operations run in killable per-session/profile workers, use explicit CDP
target IDs, return structured snapshots/results/logs/artifacts/images, and
report cancelled or timed-out actions without replaying them.
