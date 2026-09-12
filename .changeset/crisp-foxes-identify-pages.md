---
'@tom-cat/pi-browser-runtime': patch
---

Harden Firefox DOM identity generation by deriving ids from `crypto.getRandomValues` instead of the secure-context-gated `crypto.randomUUID`.

`createFirefoxDomDriver` created the document id, snapshot ids and prepared-action ids with `view.crypto.randomUUID()` read from the page window. `randomUUID()` is `[SecureContext]` (unlike `getRandomValues()`), and Gecko exposes `[SecureContext]` members only when the caller realm or the object's realm is a secure context (`dom/bindings/DOMJSClass.h`). Extension content scripts run in an expanded-principal sandbox that Gecko does not flag as a secure context, so on a plain `http:` page — a supported class, because `firefoxPageSupported` accepts `http:` — neither side may be secure and the member may be absent, which would make driver creation throw inside `scripting.executeScript` and leave every DOM tool unusable for that tab. Identities now come from `view.crypto.getRandomValues`, which is available in insecure contexts, and are still random v4 UUIDs with the same `firefox:<document>:<snapshot>` shape. This is a code-risk fix pending a real non-trustworthy-HTTP baseline; it is harmless if the member turns out to be exposed. No permission, CSP, protocol, ownership or cancellation semantics change.
