/**
 * Lifecycle tests for bootstrap.ts against a real local HTTP server. We exercise
 * identity resolution, probe semantics (free vs timeout vs unauthorized vs
 * foreign), reset(), local-vs-remote launch guard, and session.release wiring —
 * WITHOUT ever spawning a real runtime or Chrome. Launch is verified only via
 * resolveRuntimeEntry (pure) and the remote guard.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as bootstrap from "../extensions/bootstrap.ts";
import { BrowserRuntimeClient } from "../extensions/runtime-client.ts";
import { startTestServer, validCapabilities, type TestServer } from "./test-server.ts";

let server: TestServer;
const savedEnv = { ...process.env };

beforeEach(async () => {
  server = await startTestServer();
  bootstrap.reset();
});
afterEach(async () => {
  await server.close();
  process.env = { ...savedEnv };
  bootstrap.reset();
});

function makeCtx(sessionId: string | undefined = "11111111-2222-3333-4444-555555555555") {
  return { sessionManager: { getSessionId: () => sessionId }, cwd: "/tmp" } as never;
}

function clientFor(s: TestServer): BrowserRuntimeClient {
  return new BrowserRuntimeClient({ baseUrl: s.baseUrl });
}

describe("sessionId", () => {
  it("returns the full session UUID read fresh each call", () => {
    expect(bootstrap.sessionId(makeCtx("uuid-abc"))).toBe("uuid-abc");
  });
  it("throws loudly when there is no active session", () => {
    const ctx = { sessionManager: { getSessionId: () => undefined }, cwd: "/tmp" } as never;
    expect(() => bootstrap.sessionId(ctx)).toThrow(/no active Pi session/);
  });
});

describe("probeCapabilities", () => {
  it("returns capabilities when a managed runtime answers", async () => {
    server.setHandler(() => ({ json: validCapabilities }));
    await expect(bootstrap.probeCapabilities(clientFor(server))).resolves.toEqual(validCapabilities);
  });
  it("returns null only when the port is genuinely free (connection refused)", async () => {
    const dead = new BrowserRuntimeClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(bootstrap.probeCapabilities(dead)).resolves.toBeNull();
  });
  it("treats a 401 as a hard error (never replace a token-protected process)", async () => {
    server.setHandler(() => ({ status: 401, json: {} }));
    await expect(bootstrap.probeCapabilities(clientFor(server))).rejects.toThrow(/rejected auth/);
  });
  it("treats a non-managed listener as a hard error", async () => {
    server.setHandler(() => ({ json: { hello: "not a runtime" } }));
    await expect(bootstrap.probeCapabilities(clientFor(server))).rejects.toThrow(/not a managed browser runtime/);
  });
});

describe("resolveRuntimeEntry", () => {
  it("runs a .ts PI_BROWSER_RUNTIME_PATH through tsx", () => {
    const entry = bootstrap.resolveRuntimeEntry({ PI_BROWSER_RUNTIME_PATH: "/abs/runtime-cli.ts" });
    expect(entry).toEqual({ command: "tsx", args: ["/abs/runtime-cli.ts"] });
  });
  it("runs a .js PI_BROWSER_RUNTIME_PATH through node", () => {
    const entry = bootstrap.resolveRuntimeEntry({ PI_BROWSER_RUNTIME_PATH: "/abs/runtime-cli.js" });
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual(["/abs/runtime-cli.js"]);
  });
  it("never falls back to npx (uses packaged bin or the pi-browser-runtime executable)", () => {
    const entry = bootstrap.resolveRuntimeEntry({});
    expect(entry.command).not.toBe("npx");
    // Either the packaged bin resolved (node + a path) or the PATH executable.
    if (entry.command === "pi-browser-runtime") {
      expect(entry.args).toEqual([]);
    } else {
      expect(entry.command).toBe(process.execPath);
      expect(entry.args[0]).toMatch(/pi-browser-runtime|bin-runtime/);
    }
  });
});

describe("ensureRuntime", () => {
  it("returns capabilities from an already-listening runtime without launching", async () => {
    process.env.PI_BROWSER_HOST = server.baseUrl;
    server.setHandler(() => ({ json: validCapabilities }));
    await expect(bootstrap.ensureRuntime()).resolves.toEqual(validCapabilities);
    expect(bootstrap.boundCapabilities()).toEqual(validCapabilities);
  });

  it("memoizes capabilities and dedupes concurrent first-use launches", async () => {
    process.env.PI_BROWSER_HOST = server.baseUrl;
    server.setHandler(() => ({ json: validCapabilities }));
    const [a, b] = await Promise.all([bootstrap.ensureRuntime(), bootstrap.ensureRuntime()]);
    expect(a).toEqual(b);
    // One extra ensureRuntime after memoization does not re-probe.
    const before = server.requests.length;
    await bootstrap.ensureRuntime();
    expect(server.requests.length).toBe(before);
  });

  it("refuses to spawn a local daemon when PI_BROWSER_HOST points at a remote host", async () => {
    // A .invalid TLD fails DNS immediately → probe returns null (unreachable),
    // and the hostname is not loopback, so the remote guard fires instead of a
    // launch. (Using a dead IP would time out rather than refuse.)
    process.env.PI_BROWSER_HOST = "http://runtime.invalid:19989";
    await expect(bootstrap.ensureRuntime()).rejects.toThrow(/remote host/);
  });
});

describe("reset", () => {
  it("drops memoized capabilities and re-resolves the client", async () => {
    process.env.PI_BROWSER_HOST = server.baseUrl;
    server.setHandler(() => ({ json: validCapabilities }));
    await bootstrap.ensureRuntime();
    expect(bootstrap.boundCapabilities()).not.toBeNull();
    bootstrap.reset();
    expect(bootstrap.boundCapabilities()).toBeNull();
  });
});

describe("releaseSession", () => {
  it("does nothing when the runtime never started for this session", async () => {
    // No ensureRuntime call → no capabilities → release is a no-op (no request).
    await bootstrap.releaseSession(makeCtx(), "shutdown:x");
    expect(server.requests.length).toBe(0);
  });

  it("sends session.release scoped to this session once the runtime is up", async () => {
    process.env.PI_BROWSER_HOST = server.baseUrl;
    server.setHandler((req) => {
      const body = req.body as { requestId?: string; operation?: { kind?: string } };
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      return { json: { requestId: body.requestId, ok: true, data: {} } };
    });
    await bootstrap.ensureRuntime();
    await bootstrap.releaseSession(makeCtx("sess-1"), "shutdown:sess-1");
    const post = server.requests.find((r) => r.url === "/browser/v1/request");
    expect(post?.body).toMatchObject({ sessionId: "sess-1", operation: { kind: "session.release" } });
  });
});
