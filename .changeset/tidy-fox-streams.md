---
"@tom-cat/pi-browser-runtime": patch
---

Validate Firefox frame injection results before attaching tabs or executing page commands, and recheck cancellation after asynchronous resource and frame resolution. Track newly created tab identity while finishing group setup so user release stops further operations.

Enforce Firefox network capture body quotas across retained UTF-8 text and all concurrent response chunks. Release in-flight reservations on redirects, errors, eviction and capture shutdown without replaying operations or changing the response bytes delivered to the page.

Wait for Firefox main-frame navigation or same-document history/fragment events before reporting navigate/back completion. Reject unconfirmed or mismatched navigation facts instead of returning the previous page URL, with cancellation, timeout and listener cleanup preserved.
