---
'playwriter': patch
---

Fix the in-page toolbar **Record Skill** button staying on Record after a click.

The click was starting a recording, but the button only flipped to **Stop recording** when the relay went from zero recordings to one. If another recording was already active, the button did not change, extra clicks started more recordings, and fetch errors were swallowed with no toast.

The button now shows **Starting…** while the recorder attaches, then **Stop recording**. A failed start shows an error toast and returns the button to Record. Extra clicks no longer start more recordings.
