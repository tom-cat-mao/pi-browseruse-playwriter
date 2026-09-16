---
"@tom-cat/pi-browser-runtime": patch
---

Validate Firefox frame injection results before attaching tabs or executing page commands, and recheck cancellation after asynchronous resource and frame resolution. Track newly created tab identity while finishing group setup so user release stops further operations.

Enforce Firefox network capture body quotas across retained UTF-8 text and all concurrent response chunks. Release in-flight reservations on redirects, errors, eviction and capture shutdown without replaying operations or changing the response bytes delivered to the page.

Wait for Firefox main-frame navigation or same-document history/fragment events before reporting navigate/back completion. Reject unconfirmed or mismatched navigation facts instead of returning the previous page URL, with cancellation, timeout and listener cleanup preserved.

Continue observing Firefox main-frame navigation chains after a document commits, ignore superseded document abort/completion events, and track history/fragment URL changes during loading without reporting early completion. Converge the inner navigation wait on interruption.
