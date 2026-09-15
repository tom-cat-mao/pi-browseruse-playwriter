---
"@tom-cat/pi-browser-runtime": patch
---

Make an explicit Firefox network capture start replace the previous capture even when it is still active, matching the documented tool contract. Release the old capture's filters and recorded-body budget before creating the new capture; stopping alone still retains records.
