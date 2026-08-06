/**
 * Relay bootstrap + session binding.
 *
 * Lifecycle:
 *   1. First tool call probes `GET /version`. If the relay is unreachable,
 *      auto-start it via the playwriter CLI (global `playwriter session new`,
 *      falling back to `npx -y playwriter@latest session new`) — the CLI
 *      spawns the relay server if it is not listening yet — then parse the
 *      printed session id.
 *   2. If the relay was reachable, create a session over HTTP with the name
 *      `pi-<first-8-of-pi-session-id>` (contract with B workstream: the relay
 *      may bind a tab group named after the session; unknown body fields are
 *      ignored by stock relays).
 *   3. From then on everything is pure HTTP. The session is 1:1 with the pi
 *      session; `session_shutdown` deletes it via `/cli/session/delete`.
 *   4. If an execute reports session-invalid (404 "Session not found"), the
 *      binding is invalidated and recreated exactly once on the next call.
 *
 * Capabilities (`/cli/capabilities`) are probed once per session; on a stock
 * relay the endpoint 404s and every capability degrades to false.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as relay from "./relay-client.ts";

export type BoundSession = {
  id: string;
  name: string;
};

type PiLike = Pick<ExtensionAPI, "exec">;

let session: BoundSession | null = null;
let capabilities: relay.Capabilities | null = null;
let inflight: Promise<BoundSession> | null = null;
let pendingGroupTitle: string | undefined;

export function boundSessionId(): string | undefined {
  return session?.id;
}

export function boundCapabilities(): relay.Capabilities | null {
  return capabilities;
}

/** Forget the binding so the next tool call recreates it (session-invalid path). */
export function invalidateSession(): void {
  session = null;
  capabilities = null;
}

/** Remember a group title the user asked for; used at next session creation. */
export function rememberGroupTitle(title: string | undefined): void {
  if (title) pendingGroupTitle = title;
}

/** Reset all module state (used by session_shutdown). */
export function reset(): void {
  session = null;
  capabilities = null;
  pendingGroupTitle = undefined;
}

function piSessionShortId(ctx: ExtensionContext): string {
  const id = ctx.sessionManager?.getSessionId?.() ?? "";
  return id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8) || "default";
}

/** Session name is always `pi-<id8>` (1:1 with the pi session). */
export function sessionName(ctx: ExtensionContext): string {
  return `pi-${piSessionShortId(ctx)}`;
}

export type EnsureOptions = {
  groupTitle?: string;
};

/** Get the bound session, creating it on first use. Concurrent callers share one inflight promise. */
export async function ensureSession(pi: PiLike, ctx: ExtensionContext, opts: EnsureOptions = {}): Promise<BoundSession> {
  if (session) {
    if (opts.groupTitle) pendingGroupTitle = opts.groupTitle;
    return session;
  }
  if (opts.groupTitle) pendingGroupTitle = opts.groupTitle;
  if (!inflight) {
    inflight = doEnsure(pi, ctx).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function doEnsure(pi: PiLike, ctx: ExtensionContext): Promise<BoundSession> {
  const url = relay.baseUrl();
  const version = await relay.getVersion(url);
  const name = sessionName(ctx);

  let id: string;
  if (version === null) {
    // Relay not listening: auto-start via CLI, parse the printed session id.
    id = await startRelayViaCli(pi);
  } else {
    // Relay is up: create the session over HTTP, tagged with our name.
    const status = await relay.getExtensionStatus(url);
    if (!status?.connected) {
      throw new relay.RelayError(
        "extension-disconnected",
        "the Playwriter extension is not connected to the relay. Open Chrome and click the Playwriter extension icon on the tab you want to control (or check /extension/status).",
      );
    }
    const created = await relay.createSession(url, { name, groupTitle: pendingGroupTitle });
    id = created.id;
  }

  // Capability probe; 404 -> all false (silent degradation).
  capabilities = await relay.getCapabilities(url);
  session = { id, name };
  pendingGroupTitle = undefined;
  return session;
}

/** Auto-start the relay with the playwriter CLI (global first, then npx). Returns the session id. */
async function startRelayViaCli(pi: PiLike): Promise<string> {
  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: "playwriter", args: ["session", "new"] },
    { cmd: "npx", args: ["-y", "playwriter@latest", "session", "new"] },
  ];
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const result = await pi.exec(attempt.cmd, attempt.args, { timeout: 90_000 });
      if (result.code !== 0) {
        lastError = new Error(`${attempt.cmd} exited ${result.code}: ${result.stderr || result.stdout}`);
        continue;
      }
      const id = parseSessionId(result.stdout ?? "");
      if (id) return id;
      lastError = new Error(`no session id in output of ${attempt.cmd} session new`);
    } catch (e) {
      lastError = e;
    }
  }
  throw new relay.RelayError(
    "relay-unreachable",
    `could not reach the relay and auto-start via CLI failed (${String(lastError)}). Install playwriter globally (\`npm i -g playwriter\`) or start the relay manually.`,
    { cause: lastError },
  );
}

/** The CLI prints the session id on its own line (e.g. `1`). */
export function parseSessionId(output: string): string | null {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(\d+)$/);
    if (m) return m[1];
    // tolerates `Session 1 created` style lines
    const m2 = lines[i].match(/session[^\d]{0,10}(\d+)/i);
    if (m2) return m2[1];
  }
  return null;
}

/** Delete the relay session on pi session shutdown; swallows 404s. */
export async function closeSession(): Promise<void> {
  if (session) {
    await relay.deleteSession(session.id);
  }
  reset();
}
