---
name: browser-use
description: Drive the user's real Chrome or Firefox tabs through the browser_* tools and paired runtime; read the indexed topic files for extraction assets, Firefox, and tab detail.
---

# Browser Use — backend detail

The operating discipline is resident elsewhere and is not repeated here: profiles → groups → tabs
with explicit ids, the observe → act → observe loop, refs with their snapshotId, discover/attach,
release/close, and cancellation outcomes each live in that tool's own description, while the
`browser_*` guidelines carry only cross-tool orchestration. This skill carries only backend detail
those two do not, so read the topic file you need — on demand, not up front.

The `browser_*` tools are dormant by default — they enter the prompt only after a browser task
starts and the model calls the parameter-less `browser` gateway tool, which activates the whole
fleet. A user who sets `PI_BROWSER_TOOLS=always` keeps every tool resident instead.

Keep the loop in mind anyway: snapshot to read, one acting tool, then a fresh snapshot to
verify — pages redirect and change, so never chain actions blindly. The loop is not a rule to
snapshot first: a control you can name can be acted on directly with a strict selector.

## Topic files

| File | Read it when |
| --- | --- |
| `extract.md` | Calling `browser_extract`: formats and windowing, `path` exports under the runtime artifacts dir, the `images` modes and their manifests, and the capability gate that can refuse the call before it runs. |
| `firefox.md` | A Firefox (webextension) profile is in play, or `browser_execute`/`browser_evaluate` behavior differs there: wait micro-semantics, refs, isolated-world evaluate, DOM-only input, bounded timeouts. |
| `tabs.md` | Discovering/attaching the user's already-open tabs, finding a tab a link opened (`sourceTabId`), returning with `activate`, or choosing between `release` and `close`. |

## Getting-started page

Each browser build bundles a local getting-started page covering the source install, the paired
runtime, and the profiles → discover/attach → snapshot → release flow. Point the user there instead
of inventing setup steps:

- Chrome: extension options, or the icon's context menu.
- Firefox 139+: add-on options, or the popup's Help link.
- A Chrome development build uses its pre-existing idle-icon and install paths.

The page never connects to the runtime or starts anything itself.
