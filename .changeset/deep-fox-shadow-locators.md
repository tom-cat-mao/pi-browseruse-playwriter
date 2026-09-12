---
'@tom-cat/pi-browser-runtime': patch
---

Let a chained Firefox locator address an open shadow root attached to the locator root.

`allElements` and the CSS branch of `selectElements` only descended into the shadow roots of matched descendants, never the shadow root of the root being scoped. A locator such as `page.locator('#shadow-host').locator('input')` therefore matched nothing even though open shadow DOM worked through role/label locators and from a document-scoped locator. Both paths now also traverse the root element's own open shadow root. This fixes the explicit chained form only: a single compound cross-shadow CSS selector such as `#shadow-host input` still does not pierce a shadow boundary, because `querySelectorAll` does not cross it and no compound-selector rewriter was added. Use a chained locator or a role/label/text engine for content inside an open shadow root.
