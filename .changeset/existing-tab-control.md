---
'@tom-cat/pi-browser-runtime': minor
'@tom-cat/pi-browser-use-extension': minor
---

Continue in the tab the user is already looking at, and come back after reading a link.

**Discover and attach existing tabs in place.** `tabs.discover` lists the real tabs of every connected profile — profile, window, URL, title, whether it is the active tab of its window and whether that window has focus — and `tabs.attach` takes control of the chosen one where it is. Nothing is reloaded, moved, regrouped or reopened: scroll position, form state and the user's existing Chrome groups survive. Only the chosen tab is attached, never the rest of its Chrome group, and tabs another session controls are refused. Each attached tab gets a normal `tabId`, so every existing page tool works on it; no group has to be created first.

```jsonc
// browser_tabs action:"discover" (optionally query / windowId / profileId)
{ "candidateId": "pcdt:profile-1:epoch-a:7", "windowId": 3, "title": "Invoice draft", "active": true }
// browser_tabs action:"attach" with that candidateId -> { "tab": { "tabId": "ptab_…", "origin": "existing" } }
```

**Follow an external link and come back.** A tab opened by `target=_blank` / `window.open` records the managed tab it came from, so `browser_tabs list` with `sourceTabId` finds the real new tab instead of guessing by URL or "the last tab". A tab attached in place gets its child tabs attached in place too — same window, same groups, no shuffling. `browser_tabs action:"activate"` brings the original tab back to the front, and `browser_navigate action:"back"` uses real browser history instead of re-navigating the old URL.

All of this works with the text accessibility tree: reading, clicking, filling and going back need no screenshots.
