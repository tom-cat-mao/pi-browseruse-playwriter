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

```bash
# full baseline (includes a 96s read-only idle connection observation)
node acceptance/firefox-swarm/firefox-swarm-acceptance.mjs

# fast pass (skips the idle observation)
PI_ACCEPT_SKIP_IDLE=1 node acceptance/firefox-swarm/firefox-swarm-acceptance.mjs
```

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_BROWSER_RUNTIME_URL` | `http://127.0.0.1:19991` | managed runtime base URL (non-loopback refused) |
| `PI_FIREFOX_EXPECT_VERSION` | `0.0.136` | expected extension version; mismatch blocks the run |
| `PI_ACCEPT_SKIP_IDLE` | unset | set to `1` to skip the 96s idle sampling |

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
  transport grace, so the runtime's own typed timeout wins instead of a
  client-side abort.
- Assertions never wait longer than 5 s; the whole script has no fixed timeout.

## Statuses

- **PASS** — the declared capability worked.
- **FAIL** — a declared capability was executed and did not behave as declared,
  or the runtime returned an inconsistent/incorrect result.
- **SKIP** — genuinely not executed, or an explicit documented platform
  limitation (e.g. untrusted DOM input cannot open popups).
- **FINDING** — a recorded runtime problem with expected/actual/minimal repro;
  also mirrored as a FAIL assertion when it contradicts a declared capability.
