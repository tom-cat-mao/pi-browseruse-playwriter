---
'@tom-cat/pi-browser-runtime': patch
---

Stop refusing Firefox pages whose serialized HTML is larger than 1 MB.

The Firefox DOM driver capped every JSON result it returns at 1,000,000 characters — a guard it imposed on itself, not a platform limit — so a `page.content` read of a real long-form page (`page.extract` on an English Wikipedia article, for example) failed with `The returned JSON exceeds 1 MB` before any extraction ran. The serialized-document read now has its own 6,000,000-character budget, derived from the narrowest downstream bound: 6 MiB of ASCII-dominant markup fits the 8 MiB worker-to-pool IPC frame that validates this same response, Firefox's structured-clone IPC has no documented hard message limit (community measurements put it near 30 MB), and a persisted extraction keeps its own 2 MB text budget. Evaluated values, locator reads and snapshot text keep the 1 MB guard, and a document past the new budget is refused with its own limit named.
