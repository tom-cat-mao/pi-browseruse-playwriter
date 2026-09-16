# Changelog

## 0.6.0

### Minor Changes

- 859910d: Add a managed browser protocol for Pi sessions with explicitly named groups, profile-bound resources, and tab-scoped operations. Separate persistent resource ownership from transient browser connections and execution sessions.
- 61456ba: Continue in the tab the user is already looking at, and come back after reading a link.

  **Discover and attach existing tabs in place.** `tabs.discover` lists the real tabs of every connected profile — profile, window, URL, title, whether it is the active tab of its window and whether that window has focus — and `tabs.attach` takes control of the chosen one where it is. Nothing is reloaded, moved, regrouped or reopened: scroll position, form state and the user's existing Chrome groups survive. Only the chosen tab is attached, never the rest of its Chrome group, and tabs another session controls are refused. Each attached tab gets a normal `tabId`, so every existing page tool works on it; no group has to be created first.

  ```jsonc
  // browser_tabs action:"discover" (optionally query / windowId / profileId)
  { "candidateId": "pcdt:profile-1:epoch-a:7", "windowId": 3, "title": "Invoice draft", "active": true }
  // browser_tabs action:"attach" with that candidateId -> { "tab": { "tabId": "ptab_…", "origin": "existing" } }
  ```

  **Follow an external link and come back.** A tab opened by `target=_blank` / `window.open` records the managed tab it came from, so `browser_tabs list` with `sourceTabId` finds the real new tab instead of guessing by URL or "the last tab". A tab attached in place keeps its child tabs where Chrome put them — same window, same groups, no popup relocation — while task groups keep their existing "popup joins the group" behaviour. `browser_tabs action:"activate"` brings the original tab back to the front, and `browser_navigate action:"back"` uses real browser history instead of re-navigating the old URL; when the browser reports no navigation response (same-document/SPA history entries) the result says so instead of claiming nothing happened.

  All of this works with the text accessibility tree: reading, clicking, filling and going back need no screenshots.

- 7d0f92b: Build the fork extension identity by default, in every mode.

  `pnpm build` (extension and repo root) builds the fork dev extension: stable ID `eeklahpecooapnailfaebkjjembkjhhg` and managed runtime port `19989`. This also applies to packaged and `PRODUCTION=true` builds, so the bundled extension inside the runtime package always has its own identity and port. A real store listing would need a store key in `extension/vite.config.mts`; there is no store publish flow in this repo.
  - Legacy and test flows are explicit opt-ins: `pnpm --filter mcp-extension build:legacy`, `reload:legacy`.
  - The package installs only the `pi-browser-runtime` bin. The legacy CLI stays available as `pnpm cli:legacy` and is never installed as a `playwriter` bin, so it cannot shadow an upstream global install.
  - `reload:fork` / `reload:legacy` only build and print the `chrome://extensions` URL; they no longer launch Chrome.
  - Root `pnpm reload` and `pnpm release` refuse to run (the old flows restarted port `19988` and targeted the upstream store listing).
  - The distribution smoke check now verifies the packaged extension carries the fork ID and port `19989`.

- 20c5fb5: add managed browser ownership to the extension for Pi sessions

  the extension now keeps an authoritative ownership registry in `chrome.storage.local` (with `chrome.storage.session` tracking the browser run epoch) and exposes a new managed control protocol over the existing websocket:
  - `browserInventory` broadcasts after connect and on every ownership change, with logical group/tab ids kept separate from Chrome numeric ids
  - `browserRequest` handles `groups.list/create/rename/close` and `tabs.list/create/close/release/resolve`
  - `tabs.create` creates a blank tab in the group window, groups it immediately, persists the record, attaches the debugger, navigates, then verifies the Chrome group before returning `ready` with `targetId`/`cdpSessionId`
  - popups and `target=_blank` tabs opened from a managed tab inherit its group; unrelated user popups are left untouched
  - dragging a tab out of a managed group, the Chrome debugger infobar cancel, or an explicit release writes a release tombstone that reconnects never pull back
  - relay reconnects and service-worker restarts restore verifiable bindings without replaying page actions; after a full Chrome restart (or lost `storage.session`) unverifiable resources become `needs-rebind` instead of being adopted by reused numeric Chrome ids
  - persisted create dedup ledger: retrying the same sessionId + requestId + payload returns the original group/tab across reconnects and service-worker restarts, and reusing a requestId with a different payload is rejected
  - creates write a preallocated logical id and a `pending` ledger entry before any Chrome side effect; an interrupted attempt is only resumed by re-attaching a verifiably owned tab (navigation is never replayed) and otherwise answers `outcome-unknown`
  - per-group serialized mutations, so concurrent first tab creates cannot materialize two Chrome groups for one logical group
  - `request.cancel` stops future steps of a same-session request (never queued behind group locks); a dropped websocket invalidates its generation, cancels its control requests and drops their responses instead of answering on a newer socket
  - ownership is never touched through stale numeric ids: chrome-id lookups are pinned to the current browser epoch, failed creates only remove tabs that are still provably ours, and a browser-wide debugger cancel stops automation without dissolving logical groups
  - storage failures surface as `internal-error` (no inventory advertised, records never overwritten, failed write queues recover with a fresh authoritative read); manual Chrome group renames/window moves are synced by Chrome group id, never by title
  - debugger listeners stay registered for the worker lifetime so user actions (infobar cancel, tab moves) are recorded even while the relay is offline; reconnects reconcile with a revision fence so a snapshot taken while observing Chrome cannot release newer records

- 7fb8eaa: Add the managed browser runtime API: `GET /browser/v1/capabilities`, `GET /browser/v1/profiles` and `POST /browser/v1/request`.

  The relay now caches each extension profile's authoritative resource inventory (`browserInventory` websocket snapshots), enforces session ownership on every group/tab operation, dedupes resource requests by `requestId`, serializes page operations per profile and exposes session-scoped managed CDP connections on `/cdp` (`browserSessionId`/`browserEpoch` query) that only see their own tabs. `session.release` frees the isolated executor without deleting groups or tabs, and cancelled or timed-out actions report `outcome: unknown` instead of being replayed.

  Legacy `/extension` and `/cdp` clients keep working with the existing message and connection formats.

  Cancelling a request also notifies the extension for control commands that are already in flight (`request.cancel` with `sessionId` + `targetRequestId`), including timeouts and dropped HTTP clients; cancelled or timed-out work keeps its `unknown` outcome and is never replayed. Inventory snapshots that are internally inconsistent (duplicate ids, tabs pointing at missing or foreign groups, wrong profile/session owners, or `ready` resources without their Chrome/CDP identity) are rejected instead of cached. Managed CDP clients are limited to an explicit root-method allowlist scoped to their own session/target, with profile-wide and wrapper transports denied.

- 1107228: Ship the relay under the `@tom-cat/pi-browser-runtime` name with a second executable, `pi-browser-runtime`, that runs the managed browser runtime on its own port and data directory.

  ```bash
  pi-browser-runtime
  # listening on 127.0.0.1:19989, logs in ~/.pi-browser-use
  ```

  Configuration comes from the environment:
  - `PI_BROWSER_HOST` (default `127.0.0.1`)
  - `PI_BROWSER_PORT` (default `19989`)
  - `PI_BROWSER_TOKEN` (optional, required for non-loopback binds)
  - `PI_BROWSER_DATA_DIR` (default `~/.pi-browser-use`)

  The package installs only the `pi-browser-runtime` executable; the legacy CLI is available as the explicit `pnpm cli:legacy` script so it cannot shadow an upstream `playwriter` global install.

  Invalid values for `PI_BROWSER_PORT` (zero, negative, above 65535, or not an integer) now fail the start with a clear error instead of silently falling back to the default; an unset port still means `19989`. `SIGINT`/`SIGTERM` shutdown flushes both log files.

  The runtime runs next to the legacy playwriter relay on `19988`: it has its own logs and never stops a process it does not own. The legacy `playwriter` executable, WebSocket protocol and extension imports stay unchanged, and the Pi package now depends on this runtime.

- c80390f: Add a local Firefox WebExtension backend for existing tabs, with explicit resource ownership, DOM-based page tools, and an isolated JavaScript executor for common page and locator operations. Preserve the Chrome CDP backend and advertise Firefox input, snapshot, and script-permission differences per profile.
- 2e0e8d4: Add a local, versioned Chrome extension ZIP and SHA256 package for Pi Browser
  Use releases and manual installation instructions. Pushing an
  `extension@<version>` tag automatically builds and publishes the ZIP and
  checksum to GitHub Releases; manual workflow runs default to Draft releases.
- f37b70b: Add an isolated managed executor pool for Pi browser sessions. Managed page
  operations run in killable per-session/profile workers, use explicit CDP
  target IDs, return structured snapshots/results/logs/artifacts/images, and
  report cancelled or timed-out actions without replaying them.

### Patch Changes

- f963175: Fix the Firefox `browser_snapshot` and role-locator failure `'getComputedStyle' called on an object that does not implement interface Window`.

  `ariaVisible` passed no computed-style implementation to `isInaccessible`, so dom-accessibility-api extracted `element.ownerDocument.defaultView.getComputedStyle` and called it as a bare function. Firefox's WebIDL method rejects an undefined `this`; JSDOM does not catch it because its `getComputedStyle` ignores `this`, and the Chrome backend does not use this DOM driver. The call now supplies a helper that reads the view from the element's own document and invokes `view.getComputedStyle(element)` as a method, so the subtree path uses the same implementation and each same-origin iframe document resolves its own view. `computeAccessibleName` keeps its existing bound call, hidden-node filtering is unchanged, and no permission, CSP, protocol, ownership or cancellation semantics change.

- 300fc74: Stop the Firefox page console bridge from breaking pages that call `console.log`.

  The bridge replaced the page console method with an exported wrapper that forwarded to the page function through `original.apply(pageView.console, args)`. `original.apply` is the page realm's `Function.prototype.apply`, so it read `.length` and the indices of `args`, a rest array created in the extension content-script realm; the page has no access to that sandbox object and threw `Permission denied to access property "length"`, which propagated back into the page's own `console.log` call (the recorder had already stored the line, so the log looked captured). Forwarding now uses the content-script realm's `Reflect.apply(original, pageView.console, args)`, which extracts the arguments in the realm that owns them and still calls the page function with the same `this`. The original console call is not wrapped in a catch, so its errors keep propagating and are not silently hidden, and no object is cloned into the page.

- 102c4c9: Harden Firefox DOM identity generation by deriving ids from `crypto.getRandomValues` instead of the secure-context-gated `crypto.randomUUID`.

  `createFirefoxDomDriver` created the document id, snapshot ids and prepared-action ids with `view.crypto.randomUUID()` read from the page window. `randomUUID()` is `[SecureContext]` (unlike `getRandomValues()`), and Gecko exposes `[SecureContext]` members only when the caller realm or the object's realm is a secure context (`dom/bindings/DOMJSClass.h`). Extension content scripts run in an expanded-principal sandbox that Gecko does not flag as a secure context, so on a plain `http:` page — a supported class, because `firefoxPageSupported` accepts `http:` — neither side is secure. An independent baseline confirmed the failure on a non-trustworthy origin: `http://localtest.me:<loopback fixture port>` reports `isSecureContext=false` and `crypto.randomUUID=undefined` in the page itself, and snapshot/locator fail to enter the driver there (`content script returned invalid result`), while the same fixture works on `127.0.0.1`. The exact content-script stack was not captured, so the link from the missing member to the driver failure is a high-confidence root cause rather than a stepped trace. Identities now come from `view.crypto.getRandomValues`, which is available in insecure contexts, and are still random v4 UUIDs with the same `firefox:<document>:<snapshot>` shape; the fix is pending real verification with the new build, and is harmless if the member turns out to be exposed. No permission, CSP, protocol, ownership or cancellation semantics change.

- 534080b: Let a chained Firefox locator address an open shadow root attached to the locator root.

  `allElements` and the CSS branch of `selectElements` only descended into the shadow roots of matched descendants, never the shadow root of the root being scoped. A locator such as `page.locator('#shadow-host').locator('input')` therefore matched nothing even though open shadow DOM worked through role/label locators and from a document-scoped locator. Both paths now also traverse the root element's own open shadow root. This fixes the explicit chained form only: a single compound cross-shadow CSS selector such as `#shadow-host input` still does not pierce a shadow boundary, because `querySelectorAll` does not cross it and no compound-selector rewriter was added. Use a chained locator or a role/label/text engine for content inside an open shadow root.

- a6cc285: Fix a managed CDP visibility race where tabs attached before the authoritative inventory update were not announced to their owning client.
- 25d7a33: sync discovered tab ordering and page metadata in the extension
  - `tabs.discover` now lists the active tab of every window first, with the focused window only ordering ties. The bug report had the active page at the end of 145 candidates, beyond the model-visible budget; the stable window/index tie-break keeps the listing deterministic for pagination.
  - `chrome.tabs.onUpdated` url/title updates are merged into the authoritative managed inventory and published as one coalesced `browserInventory` message per burst, so `tabs.list` stops returning stale url/title. The coalescing interval is fixed (later updates join it instead of moving the deadline), so continuous title changes cannot starve the publish, and no disk write is added per title change.
  - coalesced publishes are fenced by the connection generation: a disconnect/reconnect drops the pending snapshot instead of racing the restore that publishes freshly observed Chrome state. Released tombstones and browser epochs are respected, and the refresh only touches display metadata - owner, group/session binding and debugger attachment stay unchanged.

- ec3e1ca: Fix recorder writing the same click 3 times.

  Each Playwright CDP client used to inject its own document click listener. Two sessions, or a leftover enable from a previous recording, turned one user click into two or three `action` events.

  The injected recorder is now one instance per document. `enableRecorder()` also attaches its server listener once, even when called concurrently.

  ```bash
  playwriter recorder events -r 66 --type action | jq -r '[.id, .t, .code] | @tsv'
  ```

- fee60a9: Fix the in-page toolbar **Record Skill** button staying on Record after a click.

  The click was starting a recording, but the button only flipped to **Stop recording** when the relay went from zero recordings to one. If another recording was already active, the button did not change, extra clicks started more recordings, and fetch errors were swallowed with no toast.

  The button now shows **Starting…** while the recorder attaches, then **Stop recording**. A failed start shows an error toast and returns the button to Record. Extra clicks no longer start more recordings.

- b53637a: Accept the fork extension identity (`eeklahpecooapnailfaebkjjembkjhhg`) in the relay CORS, `/cdp` and `/extension` origin allowlists, next to the legacy Chrome Web Store and dev extension ids from `ALLOWED_EXTENSION_IDS`.
- 64214b3: Make an explicit Firefox network capture start replace the previous capture even when it is still active, matching the documented tool contract. Release the old capture's filters and recorded-body budget before creating the new capture; stopping alone still retains records.
- 0e4867a: Fix managed executor request lifetimes and invalidation ordering. Timed-out or
  cancelled actions now report unknown outcomes after their worker control
  connection is stopped, raw execution timers and CDP listeners cannot outlive
  their request lease, and replacement workers wait for the previous worker to
  finish shutting down.
- 2a43124: Build the legacy extension identity in the Chrome test harness.

  `playwriter/src/test-utils.ts` now runs `pnpm build:legacy` in `extension/`
  instead of the fork default `pnpm build`. The legacy browser regression suites
  assert the upstream dev extension ID, so the harness keeps that identity while
  `pnpm build` stays the fork build for users. The test port and dist env vars
  are unchanged, and the new Chrome acceptance harness builds the fork extension
  through its own `build:fork` path, so it is unaffected.

- 84ab1aa: Add a local, offline Chinese getting-started page to both browser builds.

  Chrome opens `src/tutorial.html` from `manifest.json` `options_ui` (extension
  options, or the icon context menu); Firefox 139+ opens `firefox-tutorial.html`
  from `manifest.firefox.json` `options_ui` (add-on options) plus a Help link in
  the add-on popup. Both pages are bundled HTML/CSS/JS with no remote assets, no
  new permission, and no CSP exception, and they never connect to the runtime,
  adopt or open a tab, or start the runtime. Their content documents the current
  Pi Browser Use flow (source install, paired managed runtime, `browser_profiles`
  → `browser_tabs discover`/`attach` → `browser_snapshot` → `browser_tabs
release`) instead of the old `npx playwriter` commands.

  No new automatic opening path was added. Chrome keeps its pre-existing
  development paths, which changed only in which page they show: the idle-icon
  click already opened `src/tutorial.html`, and the install-time open now calls the
  same helper because the obsolete `welcome.html` is removed. Packaged builds still
  compile that install-time open out (`PLAYWRITER_OPEN_WELCOME_PAGE=0`).

  Packaging also verifies every manifest-declared local entry point (`background`,
  `default_popup`, `options_ui.page`, `options_page`, icons) and each page's local
  `<script src>` / `<link href>` / `<img src>` / `<a href>` before writing a
  ZIP/XPI, so a missing page or asset fails the build instead of shipping. A
  manifest entry must be a non-empty local path that exists in the bundle: a
  remote URL, an empty string, a path that escapes the package, or a non-string
  value now fails the package instead of being skipped. Explicit external links in
  pages (`https:`, `mailto:`, `#fragment`) stay allowed.

  With `welcome.html` gone, Prism has no consumer left: its CDN download script,
  the build step that ran it, and the Prism-only packaging assertion are removed,
  so building the extension no longer depends on a network download. Extension
  builds now clear their own output directory first, so a removed page or asset
  cannot survive in a loadable build or in a release archive. The Chrome output
  directory must be `dist` or `dist-<suffix>`: source directories, parent or
  nested paths, and the Firefox output directory are rejected before anything is
  deleted, and a symlinked output directory only loses the link, never the
  directory it points at.

- cffbeea: Report a managed executor deadline as `timeout`, not `cancelled`.
  - The relay now aborts its pending controller with an internal typed cancellation reason and passes the same reason to `ManagedExecutorPool.cancel()`, so both the signal listener and an explicit cancel keep the first abort reason instead of always classifying the stop as a user cancel.
  - A relay deadline that terminates an active worker returns `code=timeout` with `outcome=unknown`; an explicit user/client cancel stays `cancelled`, and a request stopped before dispatch stays `not-started`. Worker termination, capture retention and no-replay semantics are unchanged.

- 33e6ab2: Include stable snapshot reference metadata in managed snapshot results so
  callers can select an `aria-ref` using the returned short ref, role, and name
  without inferring refs from rendered CSS locators.
- b28788a: Make managed snapshots and page actions fail fast and report truthfully.
  - **Bounded snapshot scope selectors.** A `locator` scope that matches no elements or more than one now returns a clear, short error before the AX scan. Scope marking uses the remaining request budget, missing markers fail instead of falling back to the whole page, and UUID-guarded cleanup is best-effort with a 100ms native timeout.
  - **Refs match model-visible snapshot text.** Search context, offset/limit, line count, UTF-8 byte/character truncation, and structured-ref budgets are applied together. Only refs whose complete lines and metadata fit are returned, while no-match searches return no refs.
  - **Native `<details>`/`<summary>` get a valid selector.** Chrome exposes these as the unsupported `disclosuretriangle` AX role. Normal document and open-shadow summaries use exact DOM ancestry and `:nth-of-type()` selectors that count hidden siblings; open shadow roots are linked to their host through CDP `shadowRoots` metadata so the selector is anchored at the document root. Summaries in documents that `page.locator` cannot safely address, under closed/user-agent shadow roots, or behind any ancestor chain that cannot be proven to the root are shown without an actionable ref instead of a partial selector that could misclick.
  - **Clearer stale-ref explanations.** Snapshot-ref errors now say whether no snapshot is current (a prior navigate/click/fill/evaluate/execute invalidated it), the snapshot was replaced, or the ref was filtered out by the search/offset/limit window — and how to recover.
  - **Click reports an observation, not a settled navigation.** The click result URL is the tab state observed immediately after the click, never a promise that a triggered navigation has finished; no sleeps or auto-goto.
  - **`full` snapshot flag is coherent.** `full: true` forces the complete readable tree (labels, contexts, text) even when a caller would narrow to interactive-only, and stays subject to the same line/character caps and windowing.
  - **Request-aware native timeouts.** Navigate, back, click, fill, and snapshot-scope resolution use the request budget remaining after page lookup, capped at 30s for navigation and 5s for selectors with response time reserved. Outer worker cancellation still terminates unresponsive CDP/evaluate work and actions are never replayed.
  - **Observed page context on results.** Page operations attach a `pageInfo { tabId, url, title? }` from cached URL and titles actually computed by navigate/back. Arbitrary evaluate/execute objects with a `title` business field no longer fabricate a page title.

- c37a0ba: Wait for an explicitly selected managed tab's Playwright page to finish attaching before starting a page operation.
- f14680e: Require the configured relay token before accepting MCP logs or returning browser metadata such as profile details, tab titles, and tab URLs.
- d83355b: Keep observing Firefox navigation completion candidates through redirects and load-time history changes, and verify repeated matching frame/tab facts within the original cancellation and timeout budget. Defer the exact WebNavigation abort signal until a replacement navigation is observed and verified; preserve API errors and do not replay actions.
- 8ca3e54: Stop a Firefox `tabs.create` from failing without a `tabId` when its optional DOM preheat runs on a tab whose document is not injectable yet.

  The native tab and its ownership were already committed before the preheat, so a preheat failure is now logged and the created tab is still returned. The preheat only runs for a `complete` tab whose URL is a supported HTTP(S) page, mirroring the existing `tabs.onUpdated` guard. `tabs.attach` keeps its injection capability probe, and later snapshot/click operations still surface real host-permission or injection errors. No permission, CSP, session, epoch, ledger, atomic-persistence or cancellation semantics change.

- 1107228: Stop clients from killing a running relay based on a version string, and stop the runtime from treating a busy port as a successful start.

  Ports are probed with explicit states instead of an optimistic "running" flag:
  - `ready`: a valid `/version` payload and every required managed capability is `true`
  - `incompatible`: the managed protocol answers but a required capability is `false` (reported with the missing names)
  - `occupied`: HTTP answers but the payload is not a relay version (or is invalid JSON)
  - `unauthorized`: HTTP 401/403 from a token-protected listener
  - `unreachable`: nothing is listening

  Reachable is not the same as usable: `managedGroups: false` or `persistentOwnership: false` no longer counts as an available runtime. `pi-browser-runtime` exits successfully on `EADDRINUSE` only when another instance is fully capable; anything else exits with an error and a reason. `ensureManagedRuntime` refuses to use or replace incompatible and unsupported listeners, probes the requested host, never auto-starts remote hosts, and deduplicates in-flight probes per host/port/token. Full URLs are used as-is for probes (no default port injected into https tunnels) and bare IPv6 hosts are bracketed.

- 1107228: Keep the relay alive when logging fails, and never wipe a running relay's logs.

  Both the relay log and the CDP JSONL log open in append mode instead of truncating on startup, so a second process racing for the same data dir cannot erase the running relay's history. Rotation counters start from the size and line count already on disk, so an existing large file still rotates at the configured budget. Buffers are bounded, files rotate by size or line budget, and filesystem errors are swallowed: a full or unwritable disk no longer rejects the write queue, stops the relay, or grows memory without bound. Serializing an entry that cannot be stringified (for example a payload containing BigInt) writes a `cdpLogSerializeError` marker instead of throwing. Dropped lines are recorded with an overflow marker so gaps in the logs are visible.

- f6172f8: Retain bounded page network metadata in the long-lived runtime when an executor worker is cancelled, times out, or is replaced. Network list and stop now report whether a capture is active, stopped, interrupted, or was never started, while preserving their existing value shapes.

  Failed replacement starts preserve the previous evidence, and stop fences out older queued or in-flight starts without waiting behind page operations.

  Queue wait time now consumes the original browser request deadline, and executor workers receive only the remaining timeout budget.

- 709b880: Report a bounded, non-sensitive reason in the Firefox `stale-snapshot` error.

  A snapshot ref resolved with the wrong or missing `snapshotId` previously returned only
  "missing or stale", so the Firefox acceptance run could not tell which internal lifetime ended
  the snapshot. `resolveRef` now appends one fixed enum reason: `missing-snapshot-id`,
  `snapshot-replaced`, `ref-not-in-snapshot`, `different-document`, `element-detached`,
  `element-document-changed`, `invalidated:<dom-mutation|navigation|explicit-invalidate|action|evaluate|dispose>`,
  or `unknown` when the driver cannot attribute it. `snapshot-replaced` is reported only when the requested
  `snapshotId` is the exact most recent ended snapshot this driver recorded, which `takeSnapshot` records
  when it overwrites an existing snapshot; any other unmatched id stays `unknown`. The driver keeps only
  that single most recent ended `snapshotId` plus its enum reason and stores no MutationRecord, DOM node,
  text, attribute value, or URL.

  The `stale-snapshot` code, the `not-started`/`unknown` outcome, and every rejection condition are
  unchanged; refs are still never refreshed, retried, or revived, and no snapshot lifetime,
  ownership, permission, CSP, protocol, or timer behavior changes. This is diagnostics only: it does
  not fix the still-unreproduced intermittent stale ref.

- 288c2d0: Keep the Firefox MV3 background page alive while a local runtime stays connected.

  Firefox suspends a non-persistent background page after 30s without activity it counts, and a bare WebSocket round-trip is not counted, so replying to a relay ping did not keep the page alive. Each ping now performs one read-only `getBrowserInfo` parent call, which is one of the activities Firefox counts. Failures are contained, only the live socket answers, and no timer, permission, preference or loopback handshake/Origin/Host/CSP change is introduced. When the runtime disconnects the pings stop, the background is free to suspend again, and the existing reconnect alarm still wakes it.

- 2913c2f: Allow Firefox frame actions (`frameLocator` fill/click) on stock Firefox, where `Element.getBoxQuads` is not exposed.

  Gecko gates `getBoxQuads` behind `nsINode::HasBoxQuadsSupport`, which is `isChrome(cx compartment) || StaticPrefs::layout_css_getBoxQuads_enabled()`, and `layout.css.getBoxQuads.enabled` defaults to false. A WebExtension content script is not chrome, so the member is missing and every frame action was refused with `unsupported-capability`. When `getBoxQuads` is present the previous content-quad validation is unchanged. When it is absent, the ancestor frame content box is now derived from the frame's real client rect plus its used border and padding, and only for a chain that is provably axis-aligned: `transform` must be `none` or an identity matrix, and `rotate`, `scale`, `translate`, `zoom`, `perspective` and `offset-path` must be neutral. Fragmented, degenerate, non-finite, or unreconcilable boxes (including fractional border/padding where the rounded client offset or client box cannot be proven exact) are refused instead of approximated. Ancestor `elementFromPoint` occlusion, viewport bounds, and prepared-action identity checks are unchanged.

- afe3a5d: Set an explicit Firefox extension-page CSP that permits only packaged scripts and omits upgrade-insecure-requests, preserving the local relay's plain WebSocket connection. Validate the policy during Firefox builds and packaging.
- b22a91f: Validate Firefox frame injection results before attaching tabs or executing page commands, and recheck cancellation after asynchronous resource and frame resolution. Track newly created tab identity while finishing group setup so user release stops further operations.

  Enforce Firefox network capture body quotas across retained UTF-8 text and all concurrent response chunks. Release in-flight reservations on redirects, errors, eviction and capture shutdown without replaying operations or changing the response bytes delivered to the page.

  Wait for Firefox main-frame navigation or same-document history/fragment events before reporting navigate/back completion. Reject unconfirmed or mismatched navigation facts instead of returning the previous page URL, with cancellation, timeout and listener cleanup preserved.

  Continue observing Firefox main-frame navigation chains after a document commits, ignore superseded document abort/completion events, and track history/fragment URL changes during loading without reporting early completion. Converge the inner navigation wait on interruption.

- 781ee0f: Match in-page toasts to the toolbar and put them where you look.

  Copied-element and recording confirmations use the same dark surface as the toolbar. Pin toasts sit on the click X. The recording "prompt copied" toast sits just below the toolbar instead of covering it.

- 3e638d1: Publish released managed resources in the extension inventory so `tabs.release` tombstones stay visible to the runtime.

  After releasing a tab, `tabs.list` keeps returning it with `state: released` and page operations on it fail with `resource-released` instead of `resource-not-found`. Released groups are published together with their tabs so the inventory stays internally consistent (the runtime rejects tabs that reference unknown groups). Tombstones only record state and never re-authorize work: released records keep no `targetId`/`cdpSessionId` and stay hidden from the active session lookups.

- Updated dependencies [ec3e1ca]
  - @xmorse/playwright-core@1.59.12

## 0.5.0

1. **Skill Recorder** — record a workflow once in your real Chrome and let an agent turn it into a reusable skill. Click **Record Skill** on the in-page toolbar, or run:

   ```bash
   playwriter recorder start            # reuse the only session, or create one
   playwriter recorder start -s 1       # attach to an existing session
   # ... perform the workflow in the browser ...
   playwriter recorder stop             # stop the only active recording
   playwriter recorder events           # thin timeline of the latest recording
   playwriter recorder events 4 7       # full details of events 4 and 7
   playwriter recorder events -r 3      # events of recording 3
   playwriter recorder status           # active recordings + current page urls
   ```

   Every click, fill, press, select, and file pick is recorded with Playwright locator code plus structured fields (`text`, `key`, `options`, `files`, `button`, `modifiers`). Mutating xhr/fetch (POST/PUT/PATCH/DELETE) is captured with request and response bodies so the agent can reverse-engineer a site API into an in-page SDK. Analytics collector hosts are dropped. WebSockets are not recorded.

   Events live at `~/.playwriter/recordings/<id>.json`. A jpeg is saved for each visual change in `~/.playwriter/recordings/<id>/frames/<ms>.jpg`. Every event has an `ms` timestamp so you can pick the frame just before a click. Recording runs in the relay daemon, survives CLI exit, and auto-stops after 20 minutes. At most 10 recordings can be active; a new start stops the oldest one.

   `recorder start` prints instructions for writing a `SKILL.md` plus a named helper (`submit.js`, `sdk.js`). The agent skill now installs from https://playwriter.dev:

   ```bash
   npx -y skills add https://playwriter.dev
   ```

   The toolbar Record button creates a session when none exists and no longer fails when many sessions are open. Websites cannot start or stop recordings: CORS on those routes allows only the Playwriter extension origin.

2. **Live RTMP streaming** — stream a browser tab to X Live, Twitch, YouTube, or any RTMP endpoint via ffmpeg. Uses the same `chrome.tabCapture` pipeline as video recording, so the stream survives page navigation. ffmpeg runs inside the relay, so the stream keeps running after the CLI exits.

   ```bash
   playwriter stream start -s 1 --rtmp rtmp://va.pscp.tv:80/x/<stream-key>
   playwriter stream status -s 1
   playwriter stream stop -s 1
   ```

   Repeat `--rtmp` to fan out to several destinations with one encode. Defaults match X Live (1080p, 9000 kbps, 30 fps, 3s keyframes). For Twitch use `--video-bitrate 6000 --keyframe-interval 2`. Same API inside execute:

   ```js
   await stream.start({ rtmpUrls: ['rtmp://va.pscp.tv:80/x/KEY'] })
   await stream.status()
   await stream.stop()
   ```

   Stream keys are never logged. Status output only shows redacted destinations like `rtmp://host/…`.

3. **Native ESM imports in execute** — `import()` now works inside `-e` / MCP execute. Relative modules resolve from the session working directory and run with normal Node.js permissions:

   ```js
   const { inspectPage } = await import('./scripts/inspect-page.mjs')
   console.log(await inspectPage({ page }))
   ```

   Sandboxed `require()` and `importModule()` remain available for restricted access to allowlisted built-ins.

4. **Daemon tutorial on idle icon click** — clicking the extension icon while the local daemon is down now opens a short tutorial tab instead of sitting on a gray or orange badge. A second click focuses the existing tutorial tab.

5. **`PLAYWRITER_EXEC_TIMEOUT` env var** — set the default execution timeout (ms) for CLI `-e`/`-f` and the MCP `execute` tool. Explicit `--timeout` or the MCP `timeout` argument still wins:

   ```bash
   export PLAYWRITER_EXEC_TIMEOUT=30000
   playwriter -s 1 -e 'await page.goto("https://slow.example")'
   ```

6. **Hide Playwriter UI during screenshots** — toolbar, overlay, ghost cursor, scrollbars, and the blinking caret are hidden for `Page.captureScreenshot`, so captured frames stay clean.

7. **Show tracked page errors in execution output** — uncaught exceptions from pages assigned to the current session now appear automatically:

   ```text
   [PAGE ERROR] Uncaught TypeError: Cannot read properties of undefined
   ```

8. **Drop noisy CDP events** — high-frequency events such as `Network.dataReceived`, `*ExtraInfo`, and `webSocketFrame*` are no longer forwarded to Playwright clients. Relay and CDP logs also flush in 500ms batches, so heavy pages no longer flood the relay.

9. **Ghost cursor works on strict CSP pages** — the cursor is now an inline `<svg>` instead of a `data:` background image, so sites like Hacker News no longer block it.

10. **Fix long-running CLI executions** — `-e` / `-f` now follow the configured `--timeout` instead of failing at Node's fixed 300-second response-header timeout.

11. **Fix cross-OS session cwd** — a Windows CLI talking to a WSL relay no longer mangles `C:\Users\...` into a POSIX path. Windows paths are translated to `/mnt/c/...`.

12. **Fix remote relay auth** — MCP startup against token-protected remote relays, including Docker and devcontainer hosts, now sends the bearer token on the health check.

    ```bash
    playwriter --host host.docker.internal --token MY_SECRET_TOKEN
    ```

13. **Harden the execute sandbox** — `process.getBuiltinModule()` and `import()` no longer bypass the built-in allowlist.

14. **Fix stale snapshots after navigation** — `snapshot()` waits for the accessibility cache to update after a full-page or client-side navigation.

15. **Fix `Cannot find module 'ajv'` on `npx playwriter`** — `ajv` is now a direct dependency so npx can resolve it.

16. **Document extension-mode keyboard focus** — skill docs now say agents should click a field before filling it, because Chrome routes OS key events to the focused Chrome window.

Thanks @Ylandolsi for #103 and @tylergibbs1 for #101.

## 0.4.0

1. **Cloud browser sessions via Browser Use** — spin up stealth Chromium VMs in the cloud with `playwriter session new --browser cloud`. Cloud browsers support residential proxies (`--proxy us`, `--proxy de`), custom proxies (`--custom-proxy host:port`), and configurable timeouts (`--timeout 120`). Idle sessions auto-disconnect after 10 minutes.

   New CLI commands for cloud management:

   ```bash
   playwriter cloud login       # authenticate via device flow
   playwriter cloud status      # list active cloud VMs
   playwriter cloud subscribe   # open subscription page
   playwriter cloud live        # open live browser view
   ```

   Selecting a running cloud session (`cloud-1`, `cloud-2`) reattaches to the existing VM instead of creating a new one.

2. **Headless browser mode** — run without the extension or a visible browser:

   ```bash
   playwriter browser install                    # download Chrome for Testing
   playwriter session new --browser headless      # launch headless Chrome
   playwriter -s 1 -e "await page.goto('https://example.com')"
   ```

   Multiple sessions share the same Chrome process. Each session gets its own isolated context. Recording is not available in headless mode.

3. **API key authentication for cloud browsers** — skip the interactive device flow in CI and headless environments:

   ```bash
   export PLAYWRITER_API_KEY=pw_xxxxx
   playwriter session new --browser cloud
   ```

   Create and revoke keys at https://playwriter.dev/dashboard. Authentication priority: `PLAYWRITER_API_KEY` env var, then `PLAYWRITER_CLOUD_TOKEN` env var, then `~/.playwriter/auth.json`.

4. **Fixed relay routing across Chrome profiles** — the relay now identifies extension connections by per-profile install id before falling back to account identity, so two profiles signed into the same Google account no longer replace each other's relay connection. `context.newPage()` and `Target.createTarget` route to the intended browser profile.

5. **Fixed cloud billing race conditions** — concurrent `playwriter session new --browser cloud` requests now use durable per-org slot claims, preventing over-provisioning beyond the subscribed session quantity. Stripe Checkout also verifies Stripe directly before creating subscriptions, avoiding duplicates while webhook delivery is pending.

6. **Fixed `playwriter cloud login`** — the CLI now uses Better Auth's current device authorization endpoints (`/api/auth/device/code`, `/api/auth/device/token`) so cloud browsers appear after approving the login.

## 0.3.1

1. **Auto-page creation enabled by default** — MCP and CLI sessions now automatically create a blank Playwriter-enabled tab when no targets are available, so agents can start working immediately without manual tab setup. Set `PLAYWRITER_AUTO_ENABLE=false` to disable.

## 0.3.0

1. **New `sinceLastCall` option for `getLatestLogs()`** — inspect browser logs after every action without seeing duplicate messages:
   ```bash
   playwriter -s 1 -e 'console.log(await getLatestLogs({ page, sinceLastCall: true }))'
   ```
   The first call returns all buffered console logs and page errors for the page. Later calls return only new entries since the previous `sinceLastCall` read. Logs also persist across navigations, so hydration errors, redirect failures, and startup exceptions are not lost when the page changes.
2. **CDP logs now rotate automatically** — `~/.playwriter/cdp.jsonl` is capped at 10,000 entries by default to prevent unbounded disk growth. Set `PLAYWRITER_CDP_LOG_MAX_ENTRIES` to tune the cap. Rotation keeps the newest half of the log and writes through an atomic temp-file rename to avoid corrupting the JSONL file.
3. **More reliable `getLatestLogs({ page })` results** — page runtime errors and console messages emitted by related frame targets now appear in the returned log stream. This makes React and hydration failures visible through `pageerror` entries instead of requiring manual console listeners.
4. **CLI-created sessions auto-open pages more reliably** — `playwriter session new` can auto-create an initial extension tab even when the shared relay was originally started by MCP. This avoids `No Playwright pages are available` after all enabled tabs have closed.
5. **Remote status checks send bearer tokens** — `/extensions/status` and `/extension/status` requests now include the configured auth token, so remote relays using `--token` no longer reject status checks with 403 responses.
6. **Concurrent relay startup no longer crashes on port races** — simultaneous CLI and MCP commands now deduplicate startup work and treat a competing process winning port `19988` as a clean handoff instead of surfacing `EADDRINUSE`.
7. **Clearer multi-browser names in `playwriter session new`** — browser lists now use full user-agent client hints when available, so Chromium-family browsers such as Chrome Canary can show a more specific name.
8. **Skill docs prefer `getLatestLogs()` for page diagnostics** — the generated Playwriter skill now tells agents to call `getLatestLogs({ page })` instead of adding manual console listeners that miss errors emitted before listener setup.

## 0.2.0

1. **New `-f/--file` flag** — execute JavaScript from a file instead of inline `-e` strings:
   ```bash
   playwriter -s 1 -f script.js
   ```
   The file runs in the same sandbox as `-e` with all context variables (`state`, `page`, `context`, etc.) available. `-e` and `-f` are mutually exclusive.
2. **React component inspection for pinned elements** — agents can call `getReactComponentInfo({ locator })` to get the nearest React component name, parent hierarchy, sanitized props, and source file locations. Non-React elements return `null` instead of throwing.
3. **Performance profiling guide** — new generated `performance-profiling.md` resource covering TTFB, FCP, LCP, CLS measurement, heavy request detection, and interactivity blockers with concrete Playwriter + CDP snippets. Also links to `profano` for deeper `.cpuprofile` analysis.
4. **Shell tab completions** — `playwriter` now supports shell completions via goke. Run the completion setup for your shell to get tab completion on commands and flags.
5. **Security: token required on all requests regardless of source** — the previous loopback bypass on `/cli/*`, `/recording/*`, and `/mcp-log` let any request from `127.0.0.1` skip auth. Under tunnel setups (traforo/ngrok/cloudflared), every public request arrives from localhost, making the bypass equivalent to no auth. The middleware now requires the token on every request.
6. **`--token` works on every remote subcommand** — `session new`, `session list`, `session delete`, `session reset`, and `browser list` all forward `Authorization: Bearer …` to the relay's `/cli/*` endpoints. Previously only `playwriter -e` sent the token. Thanks to @ivanleomk for the original fix.
7. **`POST /mcp-log` is now token-protected** — previously open, so any reachable client could spam the relay log file.
8. **Fixed Next.js webpack layer prefixes in React source paths** — `/(app-pages-browser)/`, `/(ssr)/`, `/(rsc)/` and other webpack layer prefixes are now stripped from source file paths in React component info.
9. **Skill docs require absolute paths for saved artifacts** — `page.screenshot({ path })`, `page.pdf({ path })`, `download.saveAs(path)`, and `video.saveAs(path)` now documented to use absolute paths since Playwright resolves them outside the sandboxed `fs`.

## 0.1.0

1. **New in-page toolbar with pin mode** — every attached tab now gets a floating toolbar you can use to pin elements directly from the page. Pinning copies a natural-language prompt plus the exact `playwriter -e '…'` code needed to inspect that element later, so pasted prompts are immediately useful to an agent instead of just exposing a fragile DOM handle.
2. **Always-on ghost cursor with better motion** — the cursor overlay now appears on every Playwriter-attached tab, survives hard navigations, uses smoother move/press animation timing, and fades away after 5 seconds of idle time so manual browsing stays uncluttered. The next Playwright-driven mouse action brings it back instantly.
3. **`playwriter --help` and `playwriter serve --help` work on clean installs again** — browser-launch code is now lazy-loaded only when `playwriter browser start` actually runs, so generic CLI entrypoints no longer fail early on unrelated browser-install dependencies.
4. **Shared JavaScript dialogs no longer crash multi-client sessions** — when multiple `connectOverCDP()` clients auto-close the same `alert()`/`confirm()`/`prompt()`, duplicate best-effort closes are now ignored instead of surfacing an unhandled rejection that kills the process.

## 0.0.105

1. **Stabilize multi-browser extension connections**. The relay now keys fallback extension identities by a persisted per-install ID instead of collapsing every unsigned Chromium-family browser into `browser:Chromium`. This prevents Chrome/Vivaldi/Helium/Dia instances from replacing each other on the relay when `chrome.identity` returns no profile ID/email.
2. **Stop reconnect handoff loops after replacement**. A replaced extension worker now waits until no replacement connection exists before reclaiming the relay slot, instead of treating `activeTargets: 0` as free. This closes the race where a fresh replacement briefly reports zero targets, gets stolen back, and drops the user's active Playwright tab.
3. **Regression coverage for dual-browser relay stability**. Added an integration test that launches a second Chromium context against the same relay and verifies the original active page stays connected.

## 0.0.104

1. **Executor logs new pages instead of unreachable popups**. Previously, when a page opened another via `window.open` or `target="_blank"`, the executor emitted `[WARNING] Popup window detected ... cannot be controlled by playwriter` and told the agent to retry. Paired with the extension 0.0.80 change (popups are auto-relocated to tabs in the source tab's window), the warning is now `[WARNING] New page opened from current page (index N, initial url: ...)` pointing the agent at the new tab to interact with it.
2. **Minimum extension version check**. If the user has an outdated Playwriter extension (< 0.0.80) that doesn't support popup relocation, the CLI/MCP now emits a warning telling them to update the extension via `chrome://extensions`. The warning is also enqueued into the MCP agent's warning stream so the agent knows why popup behavior is broken.
3. **Skill docs updated**. Removed the section instructing agents to use `cmd+click` (`{ modifiers: ['Meta'] }`) to work around popup windows during OAuth flows — the extension now handles this automatically. Added a short note under "working with pages" explaining popup auto-relocation.

## 0.0.103

1. **Auto-returned Playwright handles are silently skipped** (#82). `await page.goto(url)` and similar single-expression code previously dumped the Playwright Response object, which is useless output — it's a programmatic handle, not display data. That same dump also leaked every process env var because `util.inspect` traversed `_connection._platform.env` at depth 4 (secrets, API keys, tokens). The CLI now skips return values that are Playwright handles (Response, Page, Browser, Request, Frame, BrowserContext, etc.) entirely. Return specific fields (`return response.url()`) or `console.log(response)` to see data.
2. **`@xmorse/playwright-core`** now has custom `util.inspect` handlers on `ChannelOwner` and channel proxies. `console.log(response)` renders a concise summary like `Response@response@abc123 { url: '...', status: 200 }` without leaking internals.

## 0.0.102

1. **`browser` exposed in sandbox** — user code can now call `browser.contexts()` to access pages from all open Chrome profiles when using `--direct` mode. The `browser` variable is available alongside `page`, `context`, etc. in all sandbox code.
2. **`browser start` deprecated and hidden from `--help`** — the command still works if called directly but no longer appears in the help output. Use `session new --direct` for headless automation flows instead.
3. **`PLAYWRITER_DIRECT` only accepts `'1'`** — removed `'auto'` and `'true'` aliases. The standard boolean env var pattern (`PLAYWRITER_DIRECT=1`) is the only accepted value for auto-discovery. Explicit `ws://` endpoints still work as before.

## 0.0.101

1. **Chrome 136+ direct CDP discovery** — `playwriter browser list` and `--direct` auto-discovery now detect Chrome instances where `/json/version` returns 404 (Chrome 136+ with `chrome://inspect` debugging). Previously these were silently ignored. Discovery uses HTTP-only probing and never triggers Chrome's approval dialog.
2. **`--direct` moved to `session new` only** — removed the `--direct` flag from the root command. For MCP, set `PLAYWRITER_DIRECT=1` env var instead.
3. **Unique WS paths per session** — direct CDP connections now use the session ID (CLI) or a UUID (MCP) as the WebSocket path segment, making connections traceable.

## 0.0.100

1. **`resizeImageForAgent` now defaults to PNG** — previously defaulted to JPEG, which caused `image/png` vs `image/jpeg` mismatch errors when MCP clients assumed PNG. All images emitted by playwriter are now consistently PNG unless explicitly overridden with `format: 'jpeg'`.

## 0.0.99

1. **Kitty Graphics Protocol support in CLI** — when `AGENT_GRAPHICS=kitty` is set, the CLI now emits screenshots and resized images as Kitty Graphics Protocol escape sequences to stdout. Agents with `kitty-graphics-agent` (or compatible parsers) automatically extract the PNG images and pass them to the LLM as media parts — no extra tool call or file reading needed.
2. **Screenshots now use PNG format** — `screenshotWithAccessibilityLabels()` now captures and returns PNG instead of JPEG. PNG is lossless and is the only format supported for extraction by the Kitty Graphics Protocol (`f=100`). The `resizeImage()` function now accepts a `format` option (`'jpeg' | 'png'`).
3. **`resizeImageForAgent`** — renamed from `resizeImage`. Resized images are now automatically collected and included in the response (emitted via Kitty Graphics in CLI, included as image parts in MCP). The old `resizeImage` name still works as a backward-compatible alias.

## 0.0.98

1. **Direct CDP connection mode** — new `--direct` flag on `session new` connects to Chrome's built-in debugging WebSocket without needing the Playwriter extension. Works with any Chromium-based browser (Chrome, Brave, Ghost Browser, Arc, Edge, etc.) that has debugging enabled via `chrome://inspect/#remote-debugging` or `--remote-debugging-port`. Auto-discovers instances via DevToolsActivePort files and port scanning (9222-9229). Recording is unavailable in this mode.
2. **`playwriter browser list` command** — lists all Chrome/Chromium instances with debugging enabled, showing port, browser name, and profile info.
3. **MCP direct mode** — set `PLAYWRITER_DIRECT=1` or `PLAYWRITER_DIRECT=ws://...` env var to start the MCP server in direct CDP mode without a relay server.
4. **Multi-browser table includes direct instances** — when multiple extensions are connected, `session new` now also discovers and shows direct CDP instances in the unified selection table.

## 0.0.97

1. **Remove low-value managed-browser unit tests** — dropped the temporary browser-config, browser-launch, and package-path unit tests that were mostly asserting implementation details instead of protecting meaningful product behavior.

## 0.0.96

1. **Document managed-browser recording permissions** — `playwriter browser start` now clearly reports that recording/tab-capture flags are enabled, and the skill docs now explain that `recording.start()` does not require a manual extension click when using the managed browser flow.

## 0.0.95

1. **Skip the welcome tab for bundled automation builds** — the Playwriter CLI now packages an extension build with `welcome.html` disabled on install, so fresh managed browser profiles do not waste a tab in headless and AVPS flows.

## 0.0.94

1. **Make `browser start` work from source checkouts** — runtime package path resolution now falls back to the local `playwriter/` package directory before using installed-package resolution, so `tsx playwriter/src/cli.ts browser start` works during development.
2. **Fall back to Playwright's managed Chromium** — browser autodiscovery now also considers the Chromium / Chrome for Testing binary installed by `@xmorse/playwright-core`, so the command succeeds even when no system-wide Chromium app is installed.

## 0.0.93

1. **Show searched browser paths on launch failures** — `playwriter browser start` now prints every Chrome for Testing / Chromium path it checked, making it much easier to debug autodiscovery issues on local machines and AVPS hosts.

## 0.0.92

1. **Add `playwriter browser start`** — the CLI can now launch a managed Chrome for Testing or Chromium instance with the bundled Playwriter extension preloaded, making fresh AVPS/VPS automation setups much easier.
2. **Bundle the extension into the npm package** — Playwriter now builds and ships an unpacked extension copy inside `dist/extension`, resolved at runtime from the installed package path so the CLI can side-load it without depending on a separate checkout.

## 0.0.91

1. **Stabilize external accessibility snapshot coverage** — Hacker News and shadcn snapshot regression tests now wait for stable page content before capturing the AX tree, avoiding flaky empty interactive snapshots from live pages.
2. **Refresh extension download event expectations** — relay-core coverage now matches the current extension-mode behavior where both `Browser.download*` and `Page.download*` events are observed during downloads.

## 0.0.90

1. **Show session cwd in `playwriter session list`** — the CLI session table now includes the working directory each session was created with, making it easier to tell similar sessions apart.
2. **Fix session cwd leakage across relay restarts** — relative `fs` paths in the sandbox now resolve from the cwd captured by `playwriter session new`, instead of whichever directory last launched the detached relay server.

## 0.0.89

1. **More reliable downloads in extension mode** — download behavior now stays compatible with both `Page.download*` and `Browser.download*` event paths, so Playwright flows like `page.waitForEvent('download')` work consistently when connected through the relay.
2. **Default action timeout is now 60 seconds** — reduced false click failures on slower, real-world pages where the interaction succeeds but post-action waiting previously exceeded short timeout budgets.
3. **Ghost cursor injection is more stable** — recording flows now use direct per-page cursor injection again, avoiding the unreliable init-script persistence path used in prior builds.

## 0.0.80

### Bug Fixes

- **Relaxed relay server version check timeout**: Increased `getRelayServerVersion` timeout from 500ms to 2000ms to prevent false "server not running" detections that kill a healthy relay server and disconnect the extension. This was causing intermittent `session new` failures when the relay was briefly busy (e.g. processing recording chunks).

## 0.0.80 (previous)

### Improvements

- **Descriptive click timeout errors**: When `locator.click()` times out due to actionability failures, the error now includes the reason (e.g. "Element is not visible", "Element is not stable", "<button> intercepts pointer events") instead of just "Timeout exceeded."
- **Faster action timeouts for agents**: Default Playwright action timeout reduced from 10s to 2s. Navigation timeout remains at 10s. Agents now get fast failure with descriptive errors instead of waiting 10 seconds for a generic timeout.

## 0.0.79

### Improvements

- **Faster ghost cursor motion defaults**: Reduced min/max movement durations and increased base movement speed so pointer travel feels snappier while preserving smooth easing.
- **Recording docs now emphasize interaction-driven navigation**: Updated skill guidance to prefer click/type/hover flows during recordings so ghost cursor motion is visible and human-like instead of bypassed by direct `goto` jumps.

## 0.0.78

### Features

- **Add `resizeImage` sandbox utility**: Standalone function to resize images, useful for shrinking screenshots before reading them back into context. Default LLM-optimal mode fits within 1568×1568px; also supports explicit width/height/maxDimension. Available in execute sandbox alongside other utilities.

## 0.0.77

### Improvements

- **Cap speed-up output to source fps in FFmpeg pipeline**: Speed-up filters now use explicit `fps=fps=<source>:round=down` and set output `-r` to the same probed frame rate, keeping accelerated sections bounded to the recording's native fps.

## 0.0.76

### Bug Fixes

- **Fix ultra-short/slow demo generation on variable-framerate recordings**: `probeVideo()` now prefers `avg_frame_rate` and clamps output FPS to sane bounds, avoiding accidental `fps=30000` filter chains.
- **Avoid speeding entire video when no execute timestamps exist**: `computeIdleSections()` now returns no idle sections when timestamps are empty, so `createDemoVideo()` preserves original speed instead of aggressively compressing full recordings.

## 0.0.75

### Improvements

- **Switch minimal cursor to triangular pointer icon**: Updated the `minimal` ghost cursor style to use a stylized triangular SVG pointer (with subtle drop shadow) instead of the circular indicator, while keeping `dot` and `screenstudio` styles available.

## 0.0.74

### Improvements

- **Switch default ghost cursor to a stylized minimal look**: Updated cursor rendering defaults to a cleaner minimal style while preserving `dot` and `screenstudio` options for explicit overrides.

## 0.0.73

### Improvements

- **Simplify recording integration in executor**: Moved ghost-cursor-aware recording wrappers out of `executor.ts` into `screen-recording.ts` via `createRecordingApi(...)`, reducing executor complexity while preserving existing `recording.*` and backward-compatible top-level recording helpers.

## 0.0.72

### Improvements

- **Reduce false "extension disconnected" on relay restarts**: `playwriter session new` now waits longer for extension reconnect and adds a short polling grace window before failing, preventing transient post-restart races from surfacing as hard disconnect errors.

## 0.0.71

### Features

- **Add `recording` and `ghostCursor` namespaces in execute context**: New `recording.start/stop/isRecording/cancel` and `ghostCursor.show/hide` APIs are now exposed for cleaner scripting while keeping `startRecording`, `stopRecording`, `isRecording`, and `cancelRecording` as backward-compatible aliases.
- **Manual cursor overlay controls**: Cursor overlay can now be shown/hidden explicitly outside recording flows for screenshot and demo generation.

## 0.0.70

### Features

- **Ghost cursor overlay during recording**: Playwriter now auto-enables a smooth in-page ghost cursor when `startRecording()` is called, driven by `page.onMouseAction` callbacks from the Playwright fork so both `page.mouse.*` and `locator.click()` actions are visualized.

### Tests

- **Add ghost-cursor integration coverage**: Extended `on-mouse-action.test.ts` to verify callback-driven cursor animation and teardown in real extension-connected runs.

## 0.0.69

### Bug Fixes

- **Scope CDP tab session IDs by extension runtime**: Switched root tab IDs to `pw-tab-<scope>-<n>` so concurrent extension connections do not reuse the same `pw-tab-1`, `pw-tab-2`, etc. The scope is generated once per extension runtime to avoid cross-profile collisions and ambiguous recording-route resolution.
- **Standardize recording routes on CDP `sessionId`**: Recording HTTP routes now treat `sessionId` as a CDP tab session ID (`pw-tab-*`) only, removing executor-target branching from the recording path.

## 0.0.68

### Tests

- **Use a more realistic complex page in aria label screenshot test**: Replaced `example.com` with `old.reddit.com` in the optimized label rendering integration test to keep stronger real-world DOM coverage while preserving faster runtime.

## 0.0.67

### Tests

- **Speed up aria label screenshot integration test**: Reduced the `should show aria ref labels on real pages and save screenshots` runtime by loading fewer external pages, removing `networkidle` waits, and parallelizing initial page loading.

## 0.0.66

### Internal

- **Simplify warning scope tracking**: Replaced warning-scope map + execution ID counter with a direct set of scope objects, keeping the same concurrent warning behavior with less executor state.

## 0.0.65

### Improvements

- **State-aware page-close warnings**: Executor now emits page-close warnings only when the closed page is referenced in session state (for example `state.page`), and warning text includes the exact state key(s) that must be reassigned.
- **Safer active page fallback messaging**: When the active page closes and a replacement tab is available, warning text now includes both fallback index/URL and the affected state key(s).

### Docs

- **Standardize examples on `state.page`**: Updated skill examples and guidance to consistently initialize and use `state.page` at task start, reducing cross-agent tab confusion.

## 0.0.64

### Improvements

- **Warn when active page closes**: Executor now listens for page close events and emits explicit `[WARNING]` messages when the current page is closed, including the closed URL and automatic fallback behavior.
- **Automatic page fallback after close**: When possible, executor switches `page` to another open tab and reports which page index/URL it selected so agents understand context changes immediately.
- **Concurrency-safe warning delivery**: Warning buffering now tracks warning scopes per execute call so concurrent executions do not lose page-close or popup warnings.

### Tests

- **Add active-page-close integration test**: New extension connection test verifies warning emission and successful continuation on a replacement page after closing the active page.

## 0.0.63

### Security

- **Harden privileged HTTP routes against cross-origin attacks**: Added route-level middleware on `/cli/*` and `/recording/*` that blocks cross-origin browser requests via `Sec-Fetch-Site` header validation, rejects POST requests without `Content-Type: application/json` (prevents the CORS preflight bypass via `text/plain`), and enforces token authentication when token mode is enabled. Previously, CORS alone was relied upon, but CORS only blocks reading responses — it does not prevent "simple" POST requests from executing side effects like `/cli/execute`.
- **Token enforcement on HTTP routes**: When `--token` is set (remote access mode), `/cli/*` and `/recording/*` routes now require `Authorization: Bearer <token>` or `?token=<token>`, matching the behavior already documented in remote-access.md.
- **Security regression tests**: Added tests covering Sec-Fetch-Site blocking, Content-Type enforcement, token validation on privileged routes, and pass-through for legitimate Node.js clients.

## 0.0.62

### Features

- **Remote access support**: `PLAYWRITER_HOST` now accepts full URLs (e.g., `https://x-tunnel.traforo.dev`) in addition to plain hostnames, enabling secure remote browser access through tunnels like traforo
- **WebSocket over HTTPS**: Automatically uses `wss://` protocol when connecting to HTTPS relay hosts
- **Remote access documentation**: Added comprehensive guide covering architecture, setup, use cases, and security model for remote Playwriter access

### Internal

- **Centralized host parsing**: New `parseRelayHost()` utility handles URL/hostname detection and returns correct HTTP/WebSocket base URLs

## 0.0.61

### Improvements

- **Simplified Unix port killing**: Replaced shell pipeline approach (lsof/grep/awk/xargs) with direct `lsof -t` for PID discovery and `process.kill()` for termination. This eliminates spawn overhead and makes the code more maintainable while improving reliability.

## 0.0.60

### Bug Fixes

- **Fix relay startup EADDRINUSE timeouts**: If the relay port is already bound but `/version` is not responding, Playwriter now detects the listening PID(s), stops the existing process, and only then starts the relay (the 5s startup timeout now measures post-spawn readiness, not port cleanup time).
- **Harden port-kill implementation**: Replaced Playwriter's port killer with an implementation that mirrors `kill-port-process` (lsof/grep/awk/xargs on unix; taskkill on Windows) and includes the `xargs.stdout` pipe fix from upstream PR #199.

### Tests

- **Add kill-port subprocess test**: New test starts a real HTTP server subprocess on an ephemeral port, measures kill latency, and asserts the port is released.

## 0.0.59

### Bug Fixes

- **Fix "Cannot find module 'graceful-fs'" error**: Updated `@xmorse/playwright-core` to 1.59.3 which adds missing runtime dependencies (`graceful-fs`, `retry`, `signal-exit`) for clean `npx playwriter` installs (GitHub #45)

## 0.0.58

### Bug Fixes

- **Fix `bunx playwriter@latest` relay restarts**: Replaced `kill-port-process` with a vendored cross-platform port killer to avoid runtime crashes during version-mismatch restart flows.
- **Harden relay port cleanup behavior**: Unified relay/test/serve port termination through local `killPortProcess({ port })` helper with Windows/macOS/Linux support.

### Internal

- **Removed `kill-port-process` dependency**: Dropped external dependency and updated lockfile to reduce transitive process-management packages.

## 0.0.57

### Features

- **Ghost Browser Support**: Added integration with Ghost Browser APIs (multi-identity, proxies)
- **Multi-browser Support**: Added support for connecting to multiple browser instances/extensions
- **Screen Recording**: Added concurrent screen recording support in MP4 format (requires extension update)
- **Iframe Handling**: Improved iframe targeting using `Frame` objects and `Runtime.enable` routing
- **Accessibility Snapshots**: Added support for inline locators and better filtering
- **CDP JSONL Logging**: Added structured CDP logging to `~/.playwriter/cdp.jsonl`

### Bug Fixes

- **Fix hung navigations on YouTube and similar sites**: Resume filtered targets (like service workers) to avoid blocking navigations
- **Fix tab group infinite loop**: Prevent infinite loop when dragging tabs
- **Fix log dir permissions on shared machines**: Move default log directory from `/tmp/playwriter` to `~/.playwriter` so each OS user gets their own directory. Fixes startup crash when `/tmp/playwriter` is owned by another user (#44).

## 0.0.56

### Bug Fixes

- **Fix hung navigations on YouTube and similar sites**: Resume filtered targets (like service workers) to avoid blocking navigations. CDP `Target.setAutoAttach` with `waitForDebuggerOnStart: true` requires calling `Runtime.runIfWaitingForDebugger` even on targets we filter out, otherwise they hang forever.
- **Fix auto-enable page selection when no pages**: Properly handles the case when there are no existing pages during auto-enable

### Features

- **CDP JSONL logging**: Added structured CDP logging to a JSONL file (`/tmp/playwriter/cdp.jsonl`) for debugging. Log all CDP messages with direction, timestamp, and source info. Use `jq` to analyze.
- **Sync tab state for automated tabs**: Tab state is now properly synced for programmatically created tabs

### Improvements

- **Better logging output**: Use `util.inspect` for cleaner log output with proper object formatting
- **Set default timeout**: Added sensible default timeouts for operations

## 0.0.55

### Features

- **`playwriter skill` CLI command**: New command that prints full MCP instructions to stdout, useful for agents that need up-to-date documentation without relying on MCP resources

### Internal

- **Moved SKILL.md to src/**: Source of truth for agent instructions now lives in `src/skill.md`
- **Removed docker.package.json**: Cleaned up unused Docker configuration

## 0.0.54

### Features

- **Faster aria snapshot ref lookup**: Refs are now extracted directly from the snapshot string and fetched in parallel (20 concurrent requests), significantly reducing time to generate accessibility snapshots with labels
- **`refFilter` parameter for `getAriaSnapshot`**: New optional filter to include only specific refs by role/name, reducing unnecessary ref lookups
- **Increased default execution timeout**: Execution timeout increased from 5s to 10s for better handling of slow operations

### Bug Fixes

- **Pass cwd to executor in MCP**: File operations in executed code now use the correct working directory

## 0.0.53

### Bug Fixes

- **Fix CLI relay server startup from source**: Detect source vs compiled via `__filename.endsWith('.ts')` instead of env var, fixing `tsx` and `vite-node` execution
- **Wait for extension to reconnect**: CLI now waits up to 10 seconds for extension to reconnect after server (re)start before executing commands

### Improvements

- **Colored CLI output**: Setup messages now use colors (dim for progress, green for success, yellow for warnings)

## 0.0.52

### Features

- **First extension keeps connection**: When multiple Playwriter extensions are installed (e.g., dev and prod), the first one with active tabs now keeps the connection instead of being replaced by newer connections. Idle extensions (no tabs) can still be replaced.
- **Smarter extension slot detection**: `/extension/status` endpoint now returns `activeTargets` count, allowing extensions to know when the slot becomes available (no active tabs).
- **Accessibility snapshot format options**: `accessibilitySnapshot` now supports `format` option (`'yaml'` or `'markdown'`) with deduplication of interactive refs
- **Session management CLI commands**: New CLI commands for managing relay sessions (`playwriter sessions list`, `playwriter sessions kill`)
- **Eval CLI flag**: New `-e/--eval` CLI flag for quick code execution from command line
- **Auto-enable environment variable**: CLI now passes `PLAYWRITER_AUTO_ENABLE` when starting relay server

### Bug Fixes

- **Relay server auto-recovery**: Restored auto-recovery on every execute call
- **Preserve tabs during relay reconnects**: Tabs now persist correctly when relay reconnects
- **Show log file path on connection refused error**: Better debugging experience with log file location in errors
- **Improved error messages for extension connection states**: Clearer error messages when extension isn't connected

### Security

- **Block browser access to CLI endpoints**: Prevents browsers from accessing CLI-specific endpoints

### Internal

- **SKILL.md as source of truth**: Refactored to generate `prompt.md` from `SKILL.md`
- **Aria snapshot module**: New `aria-snapshot.ts` with dedicated accessibility snapshot functions

## 0.0.50

### Bug Fixes

- **Sharp fallback with viewport clipping**: When sharp is unavailable (optional dependency), screenshots now clip to max 1568px instead of relying on Claude's auto-resize
- **Error logging for sharp failures**: Added logging when sharp import or resize fails, making it easier to debug screenshot optimization issues

## 0.0.49

### Features

- **CORS support for relay server**: Added CORS middleware to allow extension's fetch/XHR requests during development. Only allows requests from our specific extension IDs for security.

### Bug Fixes

- **Clearer error messages**: Improved error messages when another Playwriter extension connects, making it easier to diagnose connection issues

## 0.0.48

### Bug Fixes

- **Fix SSE streaming (issue #22)**: CDP's Network domain buffers response bodies by default, which breaks SSE/streaming - data arrives at Chrome but `ReadableStream` never receives it. Now `Network.enable` defaults to `maxTotalBufferSize: 0` to disable buffering.

### Features

- **Auto-switch to another page when default page is closed**: When the current page is closed, MCP automatically switches to another available page instead of erroring
- **Optimized screenshot token usage**: Screenshots are now resized with sharp to reduce Claude token consumption
- **Reading response bodies**: Agents can re-enable Network buffering via `Network.disable` + `Network.enable` with explicit buffer sizes when they need `response.body()`

### Changes

- **Dependencies cleanup**: Removed unused deps, updated to zod v4, replaced chalk with picocolors

## 0.0.47

### Bug Fixes

- **Improved connection reliability**: Use `127.0.0.1` instead of `localhost` to avoid DNS/IPv6 resolution issues, add 15s global timeout wrapper around `connect()` to prevent hanging forever
- **Use domcontentloaded everywhere**: Changed `getCurrentPage()` and prompt guidance to use `domcontentloaded` instead of `load` for faster, more reliable page detection
- **Allow attaching to own extension pages**: Extension pages can now be debugged while still blocking other extensions

### Changes

- **Centralized target filtering**: Consolidated extension ID arrays and target filtering logic for cleaner code
- **Optional wsUrl in getCDPSessionForPage**: `wsUrl` parameter now defaults to `getCdpUrl()` if not provided

## 0.0.46

### Bug Fixes

- **Limit screenshot dimensions to 2000px**: Screenshots are now clipped to max 2000x2000 pixels to avoid Claude API rejection for many-image requests (Claude enforces 2000px limit when >20 images in a request)

## 0.0.45

### Bug Fixes

- **Filter non-page targets from Playwright (issue #14)**: Service workers, web workers, and other non-page targets are now filtered out at the server level. This prevents Playwright from trying to initialize these targets, which would cause timeouts waiting for `executionContextCreated` events and errors on `Target.detachFromTarget`.

## 0.0.44

### Features

- **Search context lines**: `accessibilitySnapshot`, `getCleanHTML`, and `getLatestLogs` now include 5 lines of context above and below each search match
  - Non-contiguous sections are separated by `---`
  - Provides better context for understanding search results

- **CDP discovery endpoints**: Added standard Chrome DevTools Protocol HTTP discovery endpoints
  - `/json/version` - Returns browser info and `webSocketDebuggerUrl`
  - `/json/list` - Returns list of debuggable targets
  - `/json` - Alias for `/json/list`
  - Supports both GET and PUT methods (Chrome 66+ compatibility)
  - Handles trailing slash variants (Playwright compatibility)
  - Allows `chromium.connectOverCDP('http://127.0.0.1:19988')` without needing to call `getCdpUrl` first

## 0.0.43

### Features

- **`getCleanHTML` utility**: New function to get cleaned HTML from a locator or page
  - Removes script, style, svg, head tags
  - Keeps only essential attributes (aria-_, data-_, href, role, title, alt, etc.)
  - Supports `search` option to filter results (returns first 10 matching lines)
  - Supports `showDiffSinceLastCall` to see changes since last snapshot
  - Supports `includeStyles` to optionally keep style/class attributes

### Changes

- **Simplified `accessibilitySnapshot` search**: Removed `contextLines` parameter, search now returns just matching lines instead of context around matches. Use `.split('\n').slice()` for pagination instead.

## 0.0.42

### Bug Fixes

- **Fix "no low surrogate in string" API error**: Sanitize accessibility snapshot text using `toWellFormed()` to remove unpaired Unicode surrogates that break JSON encoding for Claude API (requires Node.js 20+ for sanitization, gracefully degrades on older versions)

## 0.0.41

### Features

- **Arrow connectors in screenshot labels**: Visual labels now show arrow lines from label to element center, making it clearer which element each label references

### Patch Changes

- **Bigger label font**: Increased label font size from 11px to 12px for better readability
- **Fixed screenshot dimensions**: Screenshots now use actual viewport size (`innerWidth`/`innerHeight`) with `scale: 'css'` to match visual appearance

## 0.0.40

### Features

- **`screenshotWithAccessibilityLabels`**: New utility function that takes a screenshot with Vimium-style visual labels overlaid on interactive elements
  - Labels show aria-ref IDs that can be used with `page.locator('aria-ref=e5')`
  - Image and accessibility snapshot are automatically included in the response
  - Can be called multiple times to capture multiple screenshots
  - Labels are color-coded by element type
- **Media elements in aria labels**: Added `img`, `video`, `audio` to INTERACTIVE_ROLES
  - Light blue color scheme for media element labels
  - Agents can now reference images by aria-ref for visual tasks

### Patch Changes

- **Extension fix**: Query playwriter tab group by title instead of caching ID, fixing stale group issues after debugger detach/reattach

## 0.0.39

### Patch Changes

- **Fix icon not updating on WS disconnect**: `maintainLoop` now ensures tabs transition to 'connecting' state when WebSocket is not connected, fixing edge cases where `handleClose` wasn't called
- **Increased aria-labels auto-hide timeout**: Labels now auto-hide after 30 seconds instead of 5 seconds

## 0.0.38

### Patch Changes

- Internal connection handling improvements

## 0.0.36

### Features

- **Visual Aria Ref Labels**: New `showAriaRefLabels()` and `hideAriaRefLabels()` functions overlay Vimium-style labels on interactive elements
  - Labels show aria-ref IDs (e.g., "e1", "e5") that can be used with `page.locator('aria-ref=e5')`
  - Color-coded by element type: yellow=links, orange=buttons, coral=inputs, pink=checkboxes, peach=sliders, salmon=menus, amber=tabs
  - Only shows truly interactive roles (button, link, textbox, combobox, checkbox, etc.)
  - Skips elements covered by opaque overlays using `elementsFromPoint()`
  - Greedy overlap prevention skips labels that would overlap with already-placed ones
  - Auto-hides after 30 seconds to prevent stale labels (timer cancelled if called again)
  - Available in MCP execute context

### Usage

```js
const { snapshot, labelCount } = await showAriaRefLabels({ page })
await page.screenshot({ path: '/tmp/labeled-page.png' })
await page.locator('aria-ref=e5').click()
// Labels auto-hide after 30 seconds, or call hideAriaRefLabels({ page }) manually
```

## 0.0.35

### Patch Changes

- **Persistent WS connection**: Extension now connects to relay server at startup and maintains connection indefinitely, retrying every 5 seconds silently in background
- **Silent background retry**: Connecting badge only shows when user explicitly clicks to attach a tab, not during background reconnection attempts
- **Fixed tab group race condition**: All tab group operations now queue through `tabGroupQueue` to prevent race conditions between `syncTabGroup`, `disconnectEverything`, and `onTabUpdated`
- **Simplified connection states**: Renamed `'disconnected'` to `'idle'`, removed global `'connecting'` state (only individual tabs show connecting state)
- **Auto-create initial tab**: When `PLAYWRITER_AUTO_ENABLE` env var is set, automatically creates an about:blank tab when Playwright connects and no tabs exist

## 0.0.34

### Patch Changes

- **Skip server restart for newer versions**: MCP no longer kills and restarts the relay server when the server version is higher than the MCP version. This prevents older MCPs from disrupting newer server instances.
- **Ping/pong keep-alive**: Added WebSocket ping/pong mechanism to prevent Chrome extension service worker from terminating due to inactivity.

## 0.0.33

### Patch Changes

- **Fixed prompt.md not found error**: Read `prompt.md` from `src/` instead of `dist/`, fixing `ENOENT: no such file or directory` error when running the MCP

## 0.0.32

### Patch Changes

- **Build-time resource generation**: API docs (debugger-api, editor-api, styles-api) are now generated at build time via `build-resources.ts`
- **Hosted resources on playwriter.dev**: Resources now use `https://playwriter.dev/resources/*.md` URLs instead of `playwriter://` custom URIs
- **Simplified mcp.ts**: Resource handlers now read pre-built markdown files from `dist/` instead of constructing content at runtime

## 0.0.31

### Patch Changes

- **Added `styles-api` resource**: New MCP resource (`playwriter://styles-api`) with types and examples for `getStylesForLocator` CSS inspection API
- **Reduced prompt context**: Simplified prompt.md to reference resources (`playwriter://debugger-api`, `playwriter://editor-api`, `playwriter://styles-api`) instead of inline documentation

## 0.0.30

### Patch Changes

- **Wait for main frame execution context**: `Runtime.enable` now waits for the main frame's default execution context (`auxData.isDefault === true`) instead of any context. This prevents "Frame has been detached" errors when pages weren't fully ready.
- **Fix race condition when toggling extension**: When re-enabling the extension on a tab, ignore group removal events while the tab is still in 'connecting' state. Previously, `syncTabGroup` would ungroup 'connecting' tabs which triggered a disconnect during connection.

## 0.0.29

### Patch Changes

- **Fixed Editor/Debugger script listing after page load**: `listScripts()` and `list()` now work correctly even when called after page has loaded
  - `enable()` now disables first then re-enables to force CDP to emit `scriptParsed` and `styleSheetAdded` events
  - Added 100ms debounced wait for events to arrive before returning
  - `listScripts()` and `list()` are now async and auto-call `enable()`
- **Bun/bunx compatibility**: Removed known issue about bunx - the MCP now works with both `npx` and `bunx`

## 0.0.28

### Patch Changes

- **Added `getReactSource` utility**: Extract React component source location (file, line, column) from DOM elements
  - Uses bippy library for React fiber introspection
  - Returns `{ fileName, lineNumber, columnNumber, componentName }` or `null`
  - Only works on local dev servers (Vite, Next.js, CRA) with JSX transform in development mode
- **CSP bypass for script injection**: Changed `getLocatorStringForElement` and `getReactSource` to use CDP `Runtime.evaluate` instead of `addScriptTag`
  - Scripts now work on pages with strict Content Security Policy
- **Switched to Bun.build**: Replaced esbuild and esm.sh downloads with Bun.build for bundling selector-generator and bippy
  - New `build-selector-generator.ts` and `build-bippy.ts` scripts

## 0.0.27

### Patch Changes

- **Fixed gray icon on about:blank pages**: `about:blank` pages now show the black (clickable) icon instead of gray (restricted). Chrome returns `undefined` for `tab.url` on blank pages, which was incorrectly treated as restricted.
- **Auto-recovery after extension replacement**: When another extension instance takes over the connection, the replaced extension now polls `/extension/status` every 3 seconds. When the slot becomes free, it clears the error state so the user can click to reconnect.

## 0.0.26

### Patch Changes

- **Fixed CDP commands sent too soon after attach**: Added 400ms delay after debugger attach before sending CDP commands to prevent race conditions
- **Deferred page emulation setup**: Disabled early `setDeviceScaleFactorForMacOS` and `preserveSystemColorScheme` calls that could fail on newly attached pages
- **Fixed main tab cleanup on detach**: `Target.detachedFromTarget` now properly removes main tabs from state, not just child sessions

## 0.0.25

### Patch Changes

- **Wait for extension after server start**: When MCP starts the relay server, wait 3 seconds for the extension to connect before proceeding

## 0.0.24

### Patch Changes

- **Auto-restart relay server on version mismatch**: Server now exposes `/version` endpoint, MCP checks and restarts server if versions differ after package update
- **Simplified logging**: Single `relay-server.log` file instead of timestamped files with symlinks
- **Cross-platform process killing**: Use `kill-port-process` package for Windows/Mac/Linux compatibility
- **IPv4 compatibility**: Use `127.0.0.1` instead of `localhost` to avoid IPv6 resolution issues
- **Reset tabs on disconnect**: Clear connected tabs state when extension disconnects

## 0.0.23

### Patch Changes

- **Windows compatibility**: Use `os.tmpdir()` for log files instead of XDG paths, ensuring cross-platform support
- **Removed `xdg-basedir` dependency**: Simplified path handling by using Node's built-in `os.tmpdir()`

## 0.0.22

### Patch Changes

- **Green icons for connected tabs**: Extension now uses distinct green icons when tabs are connected
- **Cleaner timeout handling**: Code execution timeouts no longer suggest using reset tool

## 0.0.21

### Patch Changes

- **Improved debug message clarity**: Changed log file path hint to specify "internal playwriter errors" for better guidance

## 0.0.20

### Patch Changes

- **Timestamped log files**: Log files now include timestamps in filename (`relay-server-{timestamp}.log`) instead of overwriting a single file
- **Automatic log cleanup**: Keeps only the 10 most recent log files, deleting older ones automatically
- **Async log writes**: Logger now uses a queue for async file writes instead of blocking sync writes

## 0.0.19

### Patch Changes

- **Added `getCDPSession` utility**: New function to send raw CDP commands through the relay
  - Works with `getCDPSession({ page })` in MCP execute context
  - Returns `{ send, on, off, detach }` interface for CDP commands and events
  - Uses page index matching with URL verification for reliable target identification
- **Converted CDP tests to use relay**: All CDP Session tests now go through the relay instead of direct playwright CDP
  - Debugger, Profiler, and layout metrics tests all use `getCDPSessionForPage`
- **Added warning about `newCDPSession`**: Documented in prompt.md that `page.context().newCDPSession()` does not work through the relay

## 0.0.18

### Patch Changes

- **Marked project as production ready**: Removed "Still in development" notice from README

## 0.0.17

### Patch Changes

- **Improved error debugging**: Log file path now included in error messages and tool description. Log file writes to OS temp directory by default (`PLAYWRITER_LOG_PATH` env var to override)
- **Added CDP Session tests**: New test suite for CDP commands through the relay
  - Debugger test: pauses on `debugger` statement, captures stack trace, local variables, and evaluates expressions
  - Profiler test: profiles JavaScript execution with inline snapshot of function names
  - Layout metrics test: captures viewport dimensions via CDP
- **Refactored test setup**: Extracted `setupTestContext()` and `cleanupTestContext()` to deduplicate beforeAll/afterAll code
- **Improved `getExtensionServiceWorker`**: Now waits for extension global functions to be ready before returning
- **Better TypeScript types**: Uses `Protocol.Debugger.PausedEvent`, `Protocol.Profiler.Profile`, `Protocol.Performance.Metric` instead of `any`

## 0.0.16

### Patch Changes

- **Fixed Stagehand timeout**: Send `Target.attachedToTarget` event after `Target.attachToTarget` returns
  - Stagehand creates sessions from `attachToTarget` response, then expects `attachedToTarget` event to create Page
  - Previously events were only sent from `setAutoAttach` which arrived before sessions were created

## 0.0.15

### Patch Changes

- **Fixed logger safety**: Added optional chaining to logger calls in CDP relay to prevent errors when logger methods are undefined

## 0.0.14

### Patch Changes

- **Added Stagehand support**: CDP relay now works with Stagehand's `cdpUrl` connection option
  - Added `Target.setDiscoverTargets` handler that sends `Target.targetCreated` events for connected targets
  - Added `Target.attachToTarget` handler that returns existing sessionId for already-attached targets
  - Added Stagehand integration test verifying connection and page access
- **Viewport initialization**: Extension now sets initial viewport via `Emulation.setDeviceMetricsOverride` when attaching to tabs
  - Gets layout metrics via `Page.getLayoutMetrics`
  - Sends `Page.frameResized` event after setting viewport

## 0.0.13

### Patch Changes

- **Fixed home directory expansion on Windows**: Use `os.homedir()` instead of `process.env.HOME` for `~` path expansion in browser-config.ts, which doesn't exist on Windows.

## 0.0.12

### Patch Changes

- **Fixed Windows path resolution**: Use `fileURLToPath` for prompt.md path resolution, fixing issues on Windows where `import.meta.url` paths weren't being handled correctly.

## 0.0.11

### Patch Changes

- **Fixed `page.url()` returning empty after extension runs for a while**: The `Target.targetInfoChanged` handler was incorrectly updating the parent page's cached `targetInfo` with child target info (service workers, iframes). Now correctly looks up targets by `targetId` instead of `sessionId`.

## 0.0.10

### Patch Changes

- **Browser console log capture**: Added `getLatestLogs` function to capture and retrieve browser console logs
  - Automatically captures up to 5000 logs per page
  - Logs cleared on page reload/navigation
  - Logs deleted when page is closed
  - Supports filtering by page, search string/regex, and count limit
- **Fixed test contamination**: Added `clearAllLogs` function to prevent log persistence across tests
- **Improved console listener setup**: Made listeners synchronous using page `_guid` for immediate log capture
- **Critical reconnection test**: Added test verifying extension reconnection after `disconnectEverything()`
  - Tests full disconnect/reconnect cycle
  - Verifies MCP client can reconnect with `resetPlaywright()`
  - Ensures pages are visible after reconnection
- **Persistent console listeners**: Console logs now persist across browser reconnections (not cleared in `resetConnection`)

## 0.0.9

### Patch Changes

- Added `tabs` permission to extension manifest to fix `chrome.tabs` access issues
- Implemented `toggleExtensionForActiveTab` global helper in extension background script
- Automated extension loading and toggling in MCP tests using `chromium.launchPersistentContext`
- Added comprehensive tests for extension lifecycle:
  - Toggling extension on new and existing pages
  - Verifying direct CDP connection to relay
  - Handling Playwright connection before extension attachment
- Fixed `getCdpUrl` utility usage in tests
- Updated tests to use unique URLs for better debugging

## 0.0.8

### Patch Changes

- Added `getLocatorStringForElement` utility to `execute` tool context
- Helper generates Playwright locator strings for element handles
- Fixed bug where timeout was not correctly passed to `waitForEvent` in `getCurrentPage`

## 0.0.7

### Patch Changes

- Increased default timeout for execute tool from 3000ms to 5000ms

## 0.0.6

### Patch Changes

- Added `resetPlaywright` functionality to reset Playwright connection
- Added `getCdpUrl` utility function for CDP endpoint access
- Support for multiple tabs in CDP relay
- Support for multiple Playwright clients
- Enhanced prompt documentation with better examples
- Improved CDP relay error handling and logging
- Added `utils.ts` with helper functions

## 0.0.5

### Patch Changes

- Added `activateTab(page)` utility function to bring browser tabs to front and focus them
- Added `Playwriter.activateTab` CDP command support in relay server
- Added `activateTab` message type to extension protocol
- Extension now handles tab activation via `chrome.tabs.update` and `chrome.windows.update`

## 0.0.4

### Patch Changes

- Added `context` field to `State` type
- Renamed `ToolState` interface to `State`
- Limit execute tool output to 1000 characters with truncation message

## 0.0.3

### Patch Changes

- Replace CommonJS `require` with ESM `import` for user-agents module

## 2025-07-24 22:15

- Changed Chrome process stdio from 'ignore' to 'inherit' to print Chrome logs
- Helps with debugging CDP connection issues

## 2025-07-24 22:00

- Simplified email validation by checking profiles directly in MCP connect tool
- Connect tool validates email against available profiles before starting Chrome
- Returns helpful message with available profiles when email doesn't match
- startPlaywriter now simply throws an error for invalid emails

## 2025-07-24 21:45

- Added test infrastructure with vitest for MCP server testing
- Created mcp-client.ts with MCP client setup using vite-node
- Added comprehensive tests for Chrome CDP connection and console log capture
- Fixed callTool signatures to match MCP SDK API
- Added proper TypeScript types for CallToolResult

## 2025-07-24 21:30

- Moved profile listing functionality into connect tool when emailProfile is not provided
- Updated parameter description with agent-appropriate phrasing ("ask your user/owner")
- Removed separate get_profiles tool for cleaner API
- Connect tool now handles both profile listing and connection in one place

## 2025-07-24 21:15

- Modified startPlaywriter to accept optional emailProfile parameter
- Removed prompts dependency and interactive profile selection
- Connect tool now accepts emailProfile parameter or returns available profiles
- Added security guidance for profile selection in MCP response
- Suggests storing selected email in AGENTS.md or CLAUDE.md to avoid repeated selection

## 2025-07-24 21:00

- Integrated Chrome launch via startPlaywriter from playwriter.ts
- Connect tool now starts Chrome with CDP port and connects via playwright.chromium.connectOverCDP
- Added proper cleanup handlers for browser and Chrome process on server shutdown
- Removed placeholder getActivePage function in favor of direct browser connection

## 2025-07-24 20:50

- Moved console object definition outside of the Function constructor template string
- Improved code readability and maintainability

## 2025-07-24 20:45

- Refactored console capture to use a custom console object instead of overriding global console
- Cleaner implementation that avoids modifying global state

## 2025-07-24 20:40

- Enhanced execute tool to capture console.log, console.info, console.warn, console.error, and console.debug output
- Console methods are temporarily overridden during code execution to collect logs
- Output now includes both console logs and return values in a formatted response

## 2025-07-24 20:35

- Added execute tool to run arbitrary JavaScript code with page and context in scope
- The tool uses the Playwright automation guide from prompt.md as its description

## 2025-07-24 20:30

- Fixed MCP server tool registration API usage to match the correct method signature (name, description, schema, handler)
