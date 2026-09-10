---
title: Pi Browser Acceptance Harness — User Cooperation Steps
description: Open an isolated Chrome with the fork extension and a dedicated test runtime so the acceptance harness can verify the Pi browser rebuild against the real /browser/v1 API.
prompt: |
  Write the user cooperation guide for the acceptance harness in
  playwriter/scripts/acceptance/. The harness must never launch a
  browser, never start a relay and never touch port 19988. The user
  opens an isolated Chrome profile with the fork extension and starts
  a dedicated test runtime on a non-19988 port. Context sources:
  @docs/exec/browser-rebuild-plan.md
  @docs/exec/browser-runtime-contract.md
  @playwriter/src/browser-protocol.ts
  @playwriter/scripts/acceptance/acceptance-harness.ts
  @playwriter/scripts/acceptance/acceptance-plan.ts
  @playwriter/scripts/acceptance/fixture-server.ts
  @extension/package.json @extension/scripts/build-extension.mjs
  @README.md. Never write temporary files to /tmp.
---

# What this harness does and never does

The harness drives the real `/browser/v1` HTTP API of a test runtime and
checks ownership, grouping, popups, navigation, screenshots,
snapshot/click/fill, logs, network, release and cancel behaviour with real
browser events.

The snapshot steps take the element ref from the `refs` array that the
page.snapshot response carries in its `value` (entries of
`{ ref, role, name }`, the same short refs the runtime ref map is keyed
by), pick the unique entry for a role+name pair, and send it as
`aria-ref=<ref>` together with the `snapshotId` of that same snapshot.
Nothing is derived from CSS selectors, from parsing the snapshot text or
from position numbers: a missing or ambiguous ref fails the step with a
clear error.

It never launches Chrome, never starts or kills a relay, never touches
port 19988, never uses Playwright and never guesses resource owners by
URL. Cleanup only closes groupIds/tabIds recorded in its own ledger, and
only while the live inventory still attributes them to the run's
sessions. If you do not open Chrome and start the runtime, the harness
does nothing but print its checklist (dry-run is the default).

Everything below assumes you run commands from the repository root.

Pick a test port that is not `19988`, for example `19990`. The extension
build bakes in the port it connects to, so build and runtime must use the
same value.

# Step 1 — build the fork extension for the test port

```bash
cd extension
PLAYWRITER_PORT=19990 PLAYWRITER_EXTENSION_DIST=dist-acceptance pnpm build:fork
cd ..
```

This produces `extension/dist-acceptance` with the fork identity
`eeklahpecooapnailfaebkjjembkjhhg` (fork dev key is embedded, so the ID
is stable) and port `19990`. Do not use `pnpm reload`; that flow targets
the legacy entry points and is refused by design.

# Step 2 — start the dedicated test runtime

Build the runtime once, then start it with a separate data directory so the
run cannot touch `~/.pi-browser-use`:

```bash
pnpm --filter @tom-cat/pi-browser-runtime build
```

```bash
PI_BROWSER_PORT=19990 \
PI_BROWSER_DATA_DIR="$PWD/tmp/acceptance-runtime" \
PI_BROWSER_TOKEN=acceptance-local-token \
node playwriter/bin-runtime.js
```

Keep this terminal open; the fault phases will ask you to stop and start
this exact process. Leave the user's daily runtime on 19988/19989 alone.

# Step 3 — open an isolated Chrome and load the extension

Use a dedicated profile directory (never your daily profile):

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/.pi-browser-acceptance/chrome-profile" \
  --no-first-run --no-default-browser-check \
  --remote-debugging-port=9333 \
  about:blank
```

```bash
# Linux
google-chrome --user-data-dir="$HOME/.pi-browser-acceptance/chrome-profile" \
  --no-first-run --no-default-browser-check --remote-debugging-port=9333
```

`--remote-debugging-port=9333` is optional. It only enables the
harness's extra cross-check that recorded targetIds really exist in
Chrome; without it that one step is reported as skipped. Chrome will
show an automation infobar on this isolated window, which is fine.

Then load the extension:

1. Go to `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked" and select
   `<repo>/extension/dist-acceptance`.
4. Confirm the card shows ID `eeklahpecooapnailfaebkjjembkjhhg`.

If your Chrome build still accepts `--load-extension`, you may add
`--load-extension=<repo>/extension/dist-acceptance
--disable-extensions-except=<repo>/extension/dist-acceptance` to the
launch command instead of using Load unpacked.

# Step 4 — verify the extension is connected

Check the runtime directly:

```bash
curl -s -H 'authorization: Bearer acceptance-local-token' \
  http://127.0.0.1:19990/browser/v1/capabilities
curl -s -H 'authorization: Bearer acceptance-local-token' \
  http://127.0.0.1:19990/browser/v1/profiles
```

Both routes are token-protected when the runtime was started with
`PI_BROWSER_TOKEN`, so every curl needs the header above; without it
you get HTTP 401, not a connection problem.

`profiles` must contain one connected entry. If it is empty, use the
extension service worker console:

1. `chrome://extensions` -> fork card -> click "service worker".
2. In the DevTools console run `getExtensionState()` to see whether the
   relay websocket is connected.
3. Run `await chrome.storage.local.get(null)` to inspect the persisted
   managed registry (owned groups/tabs, browser epoch) that the
   acceptance run relies on.
4. No per-tab click is needed in managed mode: the extension keeps its
   own websocket connection, and `tabs.create` attaches the debugger to
   the new tab itself. Clicking the toolbar icon only wakes the service
   worker and toggles legacy control for the active tab; it is not
   required and it does not affect managed groups or tabs.

# Step 5 — run the main acceptance pass

```bash
PI_BROWSER_ACCEPTANCE=1 \
node playwriter/scripts/acceptance/acceptance-harness.ts \
  --run \
  --base-url http://127.0.0.1:19990 \
  --token acceptance-local-token \
  --fixture-server \
  --chrome-cdp http://127.0.0.1:9333
```

If fault phases will follow, the main run must keep its resources and
share one fixture server with them:

```bash
node playwriter/scripts/acceptance/acceptance-harness.ts \
  --fixture-only --fixture-port 8790   # separate terminal, keep running

PI_BROWSER_ACCEPTANCE=1 \
node playwriter/scripts/acceptance/acceptance-harness.ts \
  --run \
  --base-url http://127.0.0.1:19990 \
  --token acceptance-local-token \
  --fixture-url http://127.0.0.1:8790 \
  --cleanup never
```

`--cleanup never` is required for the fault workflow: with the default
`--cleanup=on-success` the main run closes its groups and tabs, and the
fault phases then have nothing to verify (the harness reports that as
not-verifiable instead of blaming the implementation).

Dry-run first if you want to see the plan without any request:

```bash
node playwriter/scripts/acceptance/acceptance-harness.ts --dry-run \
  --base-url http://127.0.0.1:19990
node playwriter/scripts/acceptance/acceptance-harness.ts --list
node playwriter/scripts/acceptance/acceptance-harness.ts --self-test
```

During the run the harness will ask you once to visually confirm that
the two fixture popups are inside the same Chrome group as their opener.
Press Enter after looking. Everything else is automated; each step
prints PASS/FAIL/SKIPPED with its evidence, and the run ends with a
report path under `tmp/acceptance/` plus a PNG screenshot artifact in
`tmp/acceptance/artifacts/`.

If several managed profiles are connected, pass `--profile <id>` once
per profile: the harness refuses to guess between profiles, and the
two-profile phase uses the first two ids you list.

Cleanup runs automatically on success (`--cleanup=on-success`). On
failure the resources are left in place for inspection; close them
later with the printed `--cleanup-only` command, or use
`--cleanup=always`.

# Step 6 — fault phases (separate authorization)

Fault phases interrupt a running runtime and extension, so they need a
second flag plus an explicit ownership confirmation. They also need a
fixture server that outlives the main run, otherwise the worker-kill
counter check has nothing to read. Start one in its own terminal for the
whole session and reuse its URL everywhere:

```bash
node playwriter/scripts/acceptance/acceptance-harness.ts \
  --fixture-only --fixture-port 8790
# then use --fixture-url http://127.0.0.1:8790 in the Step 5 main run
```

`--fixture-only` is not a live mode: it starts a local HTTP stub and
touches no browser, relay or product API. `--dry-run` starts nothing at
all.

```bash
PI_BROWSER_ACCEPTANCE=1 PI_BROWSER_ACCEPTANCE_FAULTS=1 \
node playwriter/scripts/acceptance/acceptance-harness.ts \
  --fault-mode \
  --fault-phase relay-restart \
  --base-url http://127.0.0.1:19990 \
  --token acceptance-local-token \
  --fixture-url http://127.0.0.1:8790 \
  --state tmp/acceptance/ledger-<runId>.json \
  --confirm-test-ownership
```

Each phase needs its own invocation: `--fault-phase ws-drop`,
`--fault-phase relay-restart`, `--fault-phase sw-restart`,
`--fault-phase extension-reload`, `--fault-phase drag-out`,
`--fault-phase worker-kill`. `extension-reload` must run alone because
it changes the browser epoch. Each phase first proves the recorded
resources are still alive and then prompts before and after your manual
action:

- `ws-drop` / `relay-restart`: stop the Step 2 runtime (Ctrl+C), press
  Enter, restart it with the same env, press Enter again. The harness
  checks the same groupIds/tabIds come back with the same states
  (released stays released, ready becomes ready again) and that a page
  action works.
- `sw-restart` stops only the extension service worker inside the same
  browser run. Open the fork card service worker, then DevTools ->
  Application -> Service Workers -> Stop, press Enter, wake the worker
  again (open a new tab or click the extension icon once), press Enter.
  `storage.session` survives this, so the same resources must come back
  ready. If your Chrome build does not offer Stop for the extension
  service worker, the harness reports the phase as not-verifiable
  instead of failing it.
- `extension-reload` uses the card reload button. That clears
  `storage.session`, so the browser epoch changes on purpose: the
  contract says old Chrome mappings are unverifiable, and every
  non-released record must degrade to `needs-rebind` (logical ownership
  kept, nothing auto-adopted, no duplicates, tabs stay where they are in
  Chrome). The harness verifies exactly that; recovery back to ready
  is not part of this round and is reported as not-verifiable.
- `drag-out`: drag the tab whose page shows
  `acceptance:A2-<runId>` out of its group (and, for the optional
  second step, the single last B1 tab). The extension must record a
  user release; the harness verifies the tab becomes `released` and
  that page actions are refused with `resource-released`.
- `worker-kill`: the harness starts a long `page.execute`, waits, then
  asks you to kill only the executor worker child process of the test
  runtime (`lsof -ti tcp:19990`, then `pgrep -P <runtime pid>`). The
  in-flight request must report an unknown outcome and the fixture
  counter must prove the action was not replayed. Never kill Chrome.

`--confirm-test-ownership` is your statement that the isolated Chrome,
the test runtime on the chosen port and every visible group/tab belong
to this acceptance test only.

# Step 7 — cleanup

- The main run cleans up after itself on success. If it stopped early,
  run:

```bash
PI_BROWSER_ACCEPTANCE=1 \
node playwriter/scripts/acceptance/acceptance-harness.ts \
  --cleanup-only --base-url http://127.0.0.1:19990 \
  --token acceptance-local-token \
  --state tmp/acceptance/ledger-<runId>.json
```

Cleanup rules the harness follows:

- only groupIds/tabIds from its own ledger are touched, and only while
  the live inventory still attributes them to this run's sessions;
- a tab that is already `released`, or answers `resource-not-found` /
  `needs-rebind`, is left alone instead of counted as a failure;
- after an `extension-reload` the harness can only release the logical
  records: the physical Chrome tabs and groups stay open for you to
  close by hand (the extension must not guess identities across epochs);
- a group is never force-closed while recorded ready tabs remain in it;
  the extension itself only closes tabs listed in its registry, so an
  unrecorded user tab in the same Chrome group is never closed by the
  harness.

- Close the isolated Chrome yourself when done.
- Remove `~/.pi-browser-acceptance/chrome-profile` and
  `tmp/acceptance-runtime` manually if you want a clean slate. The
  harness never deletes profile or runtime directories.
- Stop the Step 2 runtime with Ctrl+C, or leave it for the next phase.

# Evidence levels

The harness labels every mode and report with what it actually touched:

- `--self-test` / `--dry-run` / `--list`: pure. No HTTP, no browser, no
  relay; they only validate gates and print the plan.
- `--fixture-only`: a local HTTP fixture stub. It proves the fixtures
  serve real pages and count requests, nothing about the product.
- `--run`, `--fault-mode`, `--cleanup-only`: live. They drive the real
  `/browser/v1` API of the test runtime against the isolated Chrome you
  opened. Only this level counts as browser acceptance.

# Expected results

A complete pass reports PASS for: capabilities, explicit profile
selection, same-name groups without merging, session-filtered listings,
multi-profile isolation (or SKIPPED with reason when only one profile is
connected), tab creation, page.navigate with a marker check,
page.screenshot returning PNG bytes plus a repo-local artifact,
snapshot-ref-driven click/fill with snapshotId, stale snapshot and
unknown-ref rejection, logs, network, both popup kinds in the source
group, cross-session rejection, tab release, session release retention,
cancel without replay, and own-resources-only cleanup.

Anything the harness could not observe is reported as SKIPPED with the
reason (for example the CDP cross-check without
`--remote-debugging-port`, the multi-profile phase with a single
profile, or the visual popup confirmation in a non-interactive shell).
A SKIP is not a pass; the report keeps the distinction.

# Troubleshooting

- `no connected managed profile`: the extension websocket is not up.
  Check the Step 4 console; make sure the extension was built with
  `PLAYWRITER_PORT=19990` and the runtime listens on 19990. If the
  service worker was stopped or idle, wake it by opening a new tab or
  clicking the extension icon once.
- `needs-rebind` after an extension reload is the expected safe
  degradation, not a bug: the browser epoch changed and the contract
  deliberately refuses to re-adopt old Chrome mappings.
- HTTP 401: pass the same `PI_BROWSER_TOKEN` value you started the
  runtime with via `--token`.
- `port 19988` refused: that is intentional. Pick a test port.
- `EADDRINUSE` on startup: something already listens on the test port;
  use another port and rebuild the extension with that value.
- More than one profile connected: pass `--profile` for each.
