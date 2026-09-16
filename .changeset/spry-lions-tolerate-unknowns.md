---
'@tom-cat/pi-browser-use-extension': patch
---

Parse browser capabilities forward-compatibly so a peer that ships later than this client can no longer break the connection.

`capabilities.supportedOperations` is still shape-checked (a bounded array of bounded strings) and the page operations this client knows are kept for gating, but an operation it does not know yet — the upcoming `page.extract`, a control operation, or anything a future extension advertises — is ignored instead of failing the whole exchange with a protocol error. The new optional `capabilities.features` matrix is shape-checked (an object of bounded string arrays) and preserved verbatim, including feature names this client does not understand. Unknown keys in capabilities and in result payloads were already tolerated and stay tolerated.
