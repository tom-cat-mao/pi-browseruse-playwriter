/**
 * Runtime lifecycle + Pi-session identity for the managed browser tools.
 *
 * This module only speaks the frozen HTTP v1 contract to the paired runtime
 * (`@tom-cat/pi-browser-runtime`, default 127.0.0.1:19989); it never imports
 * runtime JS. The runtime process, its wire contract, and its packaging are
 * owned elsewhere — see docs/exec/browser-runtime-contract.md — so this file
 * stays small: resolve identity, probe, launch once when local, release.
 */

import child_process from "node:child_process";
import fs from "node:fs";
import url from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrowserCapabilities } from "@tom-cat/pi-browser-runtime/browser-protocol";
import {
  BrowserRuntimeClient,
  resolveRuntimeConfig,
  RuntimeRequestError,
  type RuntimeClientConfig,
} from "./runtime-client.ts";

// Cached state describes the shared runtime *process*, never a Pi session.
// It is re-resolved after reset() so a changed environment or a died daemon
// on the next tool use is honored (see reset() callers in index.ts run()).
let clientRef: BrowserRuntimeClient | null = null;
let capabilities: BrowserCapabilities | null = null;
// Deduplicate concurrent first-use launches (Pi runs tools in parallel).
let inflightStart: Promise<BrowserCapabilities> | null = null;

export function getClient(): BrowserRuntimeClient {
  if (!clientRef) clientRef = new BrowserRuntimeClient(resolveRuntimeConfig());
  return clientRef;
}

export function boundCapabilities(): BrowserCapabilities | null {
  return capabilities;
}

/**
 * Drop all memoized process state so the next ensureRuntime() re-resolves the
 * client (picking up env changes) and re-probes/relaunches the runtime. Called
 * on session_shutdown and after a runtime-unreachable failure to allow recovery.
 */
export function reset(): void {
  clientRef = null;
  capabilities = null;
  inflightStart = null;
}

/**
 * Full Pi session UUID for the active session, read fresh every call. Throws
 * when there is no started session so a browser tool fails loudly rather than
 * binding to a stale or empty id.
 */
export function sessionId(ctx: ExtensionContext): string {
  const id = ctx.sessionManager?.getSessionId?.();
  if (!id) {
    throw new Error("no active Pi session id; the browser tools require a started session");
  }
  return id;
}

/**
 * Ensure the paired managed runtime is reachable, launching it once if needed.
 * Returns the negotiated capabilities. Concurrent callers share one launch.
 */
export async function ensureRuntime(): Promise<BrowserCapabilities> {
  if (capabilities) return capabilities;
  if (!inflightStart) {
    inflightStart = doEnsureRuntime().finally(() => {
      inflightStart = null;
    });
  }
  return inflightStart;
}

async function doEnsureRuntime(): Promise<BrowserCapabilities> {
  const client = getClient();
  const existing = await probeCapabilities(client);
  if (existing) {
    capabilities = existing;
    return existing;
  }
  // Port is free. Only launch a runtime we own on a loopback address; a remote
  // PI_BROWSER_HOST is someone else's process and must never be spawned here.
  if (!isLocalRuntime(client.config)) {
    throw new Error(
      `no browser runtime reachable at ${client.config.baseUrl}; it points at a remote host, so it must be started there (this extension only launches a local runtime)`,
    );
  }
  await launchRuntime(client.config);
  const started = await waitForRuntime(client);
  capabilities = started;
  return started;
}

/**
 * Probe the runtime once. Returns capabilities if a managed runtime answers, or
 * null ONLY when the port is genuinely free (connection refused). A timeout,
 * a token-protected (401), or a non-managed listener is a hard error — we must
 * never launch over, nor replace, a process we do not own. Equating a timeout
 * with a free port would risk double-spawning onto a slow-but-live runtime.
 */
export async function probeCapabilities(client: BrowserRuntimeClient): Promise<BrowserCapabilities | null> {
  try {
    return await client.getCapabilities();
  } catch (e) {
    if (!(e instanceof RuntimeRequestError)) throw e;
    if (e.category === "runtime-unreachable") {
      return null;
    }
    if (e.category === "timeout") {
      throw new Error(
        `${client.config.baseUrl} did not answer capabilities in time; refusing to launch a second runtime over a possibly-live one — retry, or free/point PI_BROWSER_PORT`,
        { cause: e },
      );
    }
    if (e.category === "unauthorized") {
      throw new Error(
        `the browser runtime at ${client.config.baseUrl} rejected auth (401); set a matching PI_BROWSER_TOKEN — refusing to replace a token-protected process`,
        { cause: e },
      );
    }
    throw new Error(
      `${client.config.baseUrl} is answering but is not a managed browser runtime (${e.category}); refusing to replace it — free the port or set PI_BROWSER_PORT`,
      { cause: e },
    );
  }
}

/** Loopback baseUrl means the runtime is (or should be) local to this machine. */
function isLocalRuntime(config: RuntimeClientConfig): boolean {
  const host = (() => {
    try {
      return new URL(config.baseUrl).hostname;
    } catch {
      return "";
    }
  })();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * Resolve how to launch the runtime. PI_BROWSER_RUNTIME_PATH (a runtime-cli
 * entry) wins — run through node, or tsx for a TypeScript source entry in dev
 * worktrees. Otherwise locate the companion `pi-browser-runtime` bin from the
 * *installed* @tom-cat/pi-browser-runtime package via import.meta.resolve (E
 * declares it as a dependency, so it resolves without relying on PATH). The
 * PATH `pi-browser-runtime` executable is a last resort. `npx playwriter@latest`
 * is intentionally never used.
 */
export function resolveRuntimeEntry(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const explicit = env.PI_BROWSER_RUNTIME_PATH;
  if (explicit) {
    const isTypeScript = /\.(ts|mts|cts)$/.test(explicit);
    return { command: isTypeScript ? "tsx" : process.execPath, args: [explicit] };
  }
  const packaged = resolvePackagedRuntimeBin();
  if (packaged) {
    return { command: process.execPath, args: [packaged] };
  }
  return { command: "pi-browser-runtime", args: [] };
}

/**
 * Locate the runtime package's bin-runtime.js without importing runtime code.
 * import.meta.resolve on the ("./package.json") export gives us the package
 * root; the bin map then names the launcher script. Returns null if the package
 * is not installed in a resolvable location.
 */
function resolvePackagedRuntimeBin(): string | null {
  try {
    const pkgUrl = import.meta.resolve("@tom-cat/pi-browser-runtime/package.json");
    const pkgPath = url.fileURLToPath(pkgUrl);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { bin?: Record<string, string> | string };
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["pi-browser-runtime"];
    if (!binRel) return null;
    return url.fileURLToPath(new URL(binRel, pkgUrl));
  } catch {
    return null;
  }
}

/** Spawn the runtime detached so it outlives this tool call; never blocks on it. */
async function launchRuntime(config: RuntimeClientConfig): Promise<void> {
  const entry = resolveRuntimeEntry();
  try {
    const child = child_process.spawn(entry.command, entry.args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    await new Promise<void>((resolve, reject) => {
      child.once("error", (err) => {
        reject(err);
      });
      // The process stays alive; give the spawn a tick to surface ENOENT.
      setTimeout(resolve, 50);
    });
  } catch (e) {
    const hint =
      entry.command === "pi-browser-runtime"
        ? "install @tom-cat/pi-browser-runtime (E packages the `pi-browser-runtime` bin) or set PI_BROWSER_RUNTIME_PATH to a runtime-cli entry"
        : `check PI_BROWSER_RUNTIME_PATH=${process.env.PI_BROWSER_RUNTIME_PATH ?? "(unset)"}`;
    throw new Error(`could not launch the browser runtime (${entry.command}) at ${config.baseUrl}: ${String(e)}; ${hint}`, {
      cause: e,
    });
  }
}

/** Poll the runtime until it answers capabilities, or fail with a clear timeout. */
async function waitForRuntime(client: BrowserRuntimeClient, timeoutMs = 8000): Promise<BrowserCapabilities> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      return await client.getCapabilities();
    } catch (e) {
      lastError = e;
      if (e instanceof RuntimeRequestError && (e.category === "unauthorized" || e.category === "protocol")) {
        throw new Error(`browser runtime came up but is not usable (${e.category})`, { cause: e });
      }
    }
  }
  throw new Error(
    `browser runtime did not become reachable at ${client.config.baseUrl} within ${timeoutMs}ms (${String(lastError)})`,
    { cause: lastError },
  );
}

/**
 * Release this session's runtime workers/CDP clients. This is the ONLY thing
 * session_shutdown does — it frees workers but never deletes groups/tabs or
 * touches persistent ownership, and never stops the shared runtime. Scoped to
 * this Pi session by its own sessionId; best-effort.
 */
export async function releaseSession(ctx: ExtensionContext, requestId: string): Promise<void> {
  if (!capabilities) return; // runtime never started for this session
  try {
    await getClient().request({
      requestId,
      sessionId: sessionId(ctx),
      operation: { kind: "session.release" },
      timeoutMs: 5000,
    });
  } catch {
    // Advisory: the runtime may already have dropped the session.
  }
}
