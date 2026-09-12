# Firefox swarm independent acceptance harness

Standalone, reusable acceptance for the Firefox WebExtension backend against an
already-loaded real Firefox. It talks directly to the managed runtime over the
documented v1 HTTP contract and only ever creates/controls its own group and
tabs against a fixture it serves itself.

It does **not** modify product source code and it never:

- touches the user's existing tabs/groups
- closes a browser/context or kills processes (19989 is the daily Chrome runtime and is never contacted)
- changes Firefox settings/permissions, enables `userScripts`, reloads the
  extension, or starts an extra browser
- opens devtools/Inspector to keep a background alive
- runs runtime unit/integration suites (those are the coordinator's)

Fixture servers start inside this single foreground process, bind `127.0.0.1`
on random ports, and are always closed in `finally`. For the insecure-context
probe it additionally relies on public DNS (`localtest.me` → `127.0.0.1`); if
that DNS is unavailable the probe is reported as SKIP/NOT RUN.

## Run

`PI_BROWSER_RUNTIME_URL` and `PI_FIREFOX_EXPECT_VERSION` are **required**; there
are no implicit defaults for the current test port or version. Missing either
exits with an error before any browser action.

```bash
# full baseline (includes a 96s read-only idle connection observation)
PI_BROWSER_RUNTIME_URL=http://127.0.0.1:<port> \
PI_FIREFOX_EXPECT_VERSION=<version> \
node acceptance/firefox-swarm/firefox-swarm-acceptance.mjs

# fast pass (skips the idle observation)
PI_BROWSER_RUNTIME_URL=http://127.0.0.1:<port> \
PI_FIREFOX_EXPECT_VERSION=<version> \
PI_ACCEPT_SKIP_IDLE=1 \
node acceptance/firefox-swarm/firefox-swarm-acceptance.mjs
```

Environment:

| Variable | Requirement | Meaning |
| --- | --- | --- |
| `PI_BROWSER_RUNTIME_URL` | required | managed runtime base URL (must be loopback) |
| `PI_FIREFOX_EXPECT_VERSION` | required | expected extension version; mismatch blocks the run |
| `PI_ACCEPT_SKIP_IDLE` | optional | set to `1` to skip the 96s idle sampling |

Outputs are written under `tmp/firefox-swarm-acceptance/evidence-<timestamp>/`:
`evidence.json` (raw) and `report.md` (per-run summary). The harness exits
non-zero when any assertion fails or the run is blocked.

## Design notes

- Independent `crypto.randomUUID()` Pi session id for every run; a second
  session is used for isolation checks.
- All operations use explicit stable IDs (`groupId`, `tabId`).
- On an unknown/network result for `groups.create`/`tabs.create` the harness
  recovers via `groups.list`/`tabs.list` instead of blindly repeating create.
- `tabs.create` is documented to return before navigation settles
  (`about:blank` transition), so the harness waits for the URL to settle.
- Runtime deadline is requested as `timeoutMs: 3000` with a 5000 ms HTTP
  transport grace for **every** request (including screenshot and cleanup), so
  the runtime's own typed timeout wins instead of a client-side abort. No
  request or assertion waits longer than 5 s. If a real operation is slow enough
  to time out, report that as-is; do not widen the limits.
- Assertions never wait longer than 5 s; the whole script has no fixed timeout.

## Areas

`preflight`, `session-isolation`, `create`, `snapshot-ref`, `role-forms`,
`hidden-filtering`, `shadow-dom`, `iframe-same-origin`, `iframe-cross-origin`,
`iframe-geometry`, `navigate-back`, `target-blank`, `screenshot`, `network`,
`network-filter`, `logs`, `execute-reads`, `unsupported`, `locator-strictness`,
`insecure-context`, `release-isolation`, `idle`, `cleanup`.

`iframe-geometry` and `network-filter` were added for the next integrated build.

### iframe-geometry (positive and negative boundaries)

The frame fallback is only intended for no-transform frames whose box model is
exactly provable from client rect / used border / padding. Both boundaries are
asserted:

- positive: a no-transform same-origin frame wrapped in border+padding must map a
  click to the intended element;
- negative: a frame with `scale/rotate/perspective`, a fractional-geometry frame
  (fractional border/padding/offset/size), and a parent-occluded frame must be
  **explicitly refused** (`unsupported-capability`), never approximated.

Do not weaken the positive fixture to lower the FAIL count.

### shadow-dom (compound vs chained)

Native CSS matches **within each document/shadow root**. Compound cross-shadow
CSS (`#shadow-host input`) is an explicit non-goal this round and is recorded as
a limitation/SKIP, not a fix. Cross-host access is via an explicit chained
locator (`page.locator('#shadow-host').locator('input')`) or role/label/text
locators; the chained case is a required assertion that must actually succeed.
The baseline recorded the compound case as `count 0`; that evidence is retained.

### network-filter

Native response forwarding must be complete. The fixture confirms the page realm
actually received the complete original large body and the exact UTF-8 payload
(reading the response in the page), not merely that the capture record looks
truncated. Six bounded concurrent fetches verify the wiring. The capture record's
retained bytes are bounded and are **not** proof of the in-flight memory budget:
that budget unit is raw in-flight bytes + retained UTF-8 bytes and is provable
only in pure logic.

`page.back` is asserted so its returned `pageInfo.url` must equal the URL after
the navigation completes.

## Statuses

- **PASS** — the declared capability worked.
- **FAIL** — a declared capability was executed and did not behave as declared,
  or the runtime returned an inconsistent/incorrect result.
- **SKIP** — genuinely not executed, or an explicit documented platform
  limitation (e.g. untrusted DOM input cannot open popups).
- **FINDING** — a recorded runtime problem with expected/actual/minimal repro;
  also mirrored as a FAIL assertion when it contradicts a declared capability.
