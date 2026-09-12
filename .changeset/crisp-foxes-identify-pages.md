---
'@tom-cat/pi-browser-runtime': patch
---

Fix Firefox DOM tools failing to initialize on plain HTTP pages because the injected driver derived its identities from `crypto.randomUUID`, which Firefox exposes only in secure contexts.

`createFirefoxDomDriver` created the document id, snapshot ids and prepared-action ids with `view.crypto.randomUUID()` read from the page window. On `http:` pages — a supported class, because `firefoxPageSupported` accepts `http:` — that member does not exist, so driver creation threw inside `scripting.executeScript`, `globalThis.__piFirefoxDom` stayed undefined, and attach plus every DOM tool failed for that tab. Identities now come from `view.crypto.getRandomValues`, which is available in insecure contexts, and are still random v4 UUIDs with the same `firefox:<document>:<snapshot>` shape. No permission, CSP, protocol, ownership or cancellation semantics change.
