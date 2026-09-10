---
'@tom-cat/pi-browser-runtime': patch
---

Include stable snapshot reference metadata in managed snapshot results so
callers can select an `aria-ref` using the returned short ref, role, and name
without inferring refs from rendered CSS locators.
