---
'@tom-cat/pi-browser-runtime': patch
---

Fix a managed CDP visibility race where tabs attached before the authoritative inventory update were not announced to their owning client.
