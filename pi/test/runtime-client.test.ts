/**
 * Wire-contract tests for the BrowserRuntimeClient against a real local HTTP
 * server (no mocked fetch). Covers serialization, status-code mapping, runtime
 * response validation, output bounds, and cancellation semantics.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrowserRuntimeClient,
  clampTimeout,
  MAX_REQUEST_TIMEOUT_MS,
  resolveRuntimeConfig,
  RuntimeRequestError,
} from "../extensions/runtime-client.ts";
import { startTestServer, validCapabilities, validProfile, type TestServer } from "./test-server.ts";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});
afterEach(async () => {
  await server.close();
});

function client(token?: string): BrowserRuntimeClient {
  return new BrowserRuntimeClient({ baseUrl: server.baseUrl, token });
}

describe("resolveRuntimeConfig", () => {
  it("defaults to loopback:19989", () => {
    expect(resolveRuntimeConfig({})).toEqual({ baseUrl: "http://127.0.0.1:19989", token: undefined });
  });
  it("honors PI_BROWSER_PORT and PI_BROWSER_TOKEN", () => {
    expect(resolveRuntimeConfig({ PI_BROWSER_PORT: "20000", PI_BROWSER_TOKEN: "t" })).toEqual({
      baseUrl: "http://127.0.0.1:20000",
      token: "t",
    });
  });
  it("accepts a full URL host and a bare ipv6 host", () => {
    expect(resolveRuntimeConfig({ PI_BROWSER_HOST: "http://10.0.0.5:8080" }).baseUrl).toBe("http://10.0.0.5:8080");
    expect(resolveRuntimeConfig({ PI_BROWSER_HOST: "::1", PI_BROWSER_PORT: "9000" }).baseUrl).toBe("http://[::1]:9000");
  });
  it("rejects an out-of-range or non-numeric port", () => {
    expect(() => resolveRuntimeConfig({ PI_BROWSER_PORT: "0" })).toThrow(/PI_BROWSER_PORT/);
    expect(() => resolveRuntimeConfig({ PI_BROWSER_PORT: "nope" })).toThrow(/PI_BROWSER_PORT/);
  });
});

describe("clampTimeout", () => {
  it("caps at the max and drops invalid values", () => {
    expect(clampTimeout(999_999)).toBe(MAX_REQUEST_TIMEOUT_MS);
    expect(clampTimeout(5000)).toBe(5000);
    expect(clampTimeout(0)).toBeUndefined();
    expect(clampTimeout(-1)).toBeUndefined();
    expect(clampTimeout(undefined)).toBeUndefined();
  });
});

describe("getCapabilities", () => {
  it("parses a valid v1 capabilities body", async () => {
    server.setHandler(() => ({ json: validCapabilities }));
    await expect(client().getCapabilities()).resolves.toEqual(validCapabilities);
  });
  it("rejects a mismatched protocol version as protocol error", async () => {
    server.setHandler(() => ({ json: { ...validCapabilities, protocolVersion: 2 } }));
    await expect(client().getCapabilities()).rejects.toMatchObject({ category: "protocol" });
  });
  it("rejects a runtime that omits managed capabilities", async () => {
    server.setHandler(() => ({ json: { ...validCapabilities, managedGroups: false } }));
    await expect(client().getCapabilities()).rejects.toMatchObject({ category: "protocol" });
  });
  it("maps 401 to unauthorized", async () => {
    server.setHandler(() => ({ status: 401, json: { error: "nope" } }));
    await expect(client().getCapabilities()).rejects.toMatchObject({ category: "unauthorized", status: 401 });
  });
  it("sends the bearer token when configured", async () => {
    server.setHandler(() => ({ json: validCapabilities }));
    await client("secret").getCapabilities();
    expect(server.requests[0].headers.authorization).toBe("Bearer secret");
  });
  it("maps a dead port to runtime-unreachable", async () => {
    const dead = new BrowserRuntimeClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(dead.getCapabilities()).rejects.toMatchObject({ category: "runtime-unreachable" });
  });
});

describe("listProfiles", () => {
  it("validates each profile including nested capabilities", async () => {
    server.setHandler(() => ({ json: { profiles: [validProfile] } }));
    const profiles = await client().listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].profileId).toBe("profile-1");
  });
  it("rejects a profile with broken nested capabilities", async () => {
    const bad = { ...validProfile, capabilities: { ...validCapabilities, explicitTabs: "yes" } };
    server.setHandler(() => ({ json: { profiles: [bad] } }));
    await expect(client().listProfiles()).rejects.toMatchObject({ category: "protocol" });
  });
});

describe("request", () => {
  it("POSTs a well-formed BrowserRequest and returns data on ok:true", async () => {
    server.setHandler((req) => ({
      json: { requestId: (req.body as { requestId: string }).requestId, ok: true, data: { group: group() } },
    }));
    const data = await client().request({
      requestId: "call-1",
      sessionId: "session-uuid",
      operation: { kind: "groups.create", profileId: "profile-1", name: "work" },
    });
    expect(data.group?.groupId).toBe("g1");
    const sent = server.requests[0];
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/browser/v1/request");
    expect(sent.body).toMatchObject({
      requestId: "call-1",
      sessionId: "session-uuid",
      operation: { kind: "groups.create", profileId: "profile-1", name: "work" },
    });
  });

  it("throws an operation error carrying code + outcome on ok:false", async () => {
    server.setHandler((req) => ({
      json: {
        requestId: (req.body as { requestId: string }).requestId,
        ok: false,
        error: { code: "stale-snapshot", message: "snapshot expired", outcome: "not-started" },
      },
    }));
    await expect(
      client().request({ requestId: "c", sessionId: "s", operation: { kind: "page.click", tabId: "t", selector: "#x" } }),
    ).rejects.toMatchObject({ category: "operation", code: "stale-snapshot", outcome: "not-started" });
  });

  it("rejects a response whose requestId does not echo the request", async () => {
    server.setHandler(() => ({ json: { requestId: "other", ok: true, data: {} } }));
    await expect(
      client().request({ requestId: "mine", sessionId: "s", operation: { kind: "profiles.list" } }),
    ).rejects.toMatchObject({ category: "protocol" });
  });

  it("rejects a success payload with a wrongly-typed images array", async () => {
    server.setHandler((req) => ({
      json: { requestId: (req.body as { requestId: string }).requestId, ok: true, data: { images: [{ data: 5 }] } },
    }));
    await expect(
      client().request({ requestId: "c", sessionId: "s", operation: { kind: "page.screenshot", tabId: "t" } }),
    ).rejects.toMatchObject({ category: "protocol" });
  });

  it("maps HTTP 400 to bad-request", async () => {
    server.setHandler(() => ({ status: 400, json: { error: "bad" } }));
    await expect(
      client().request({ requestId: "c", sessionId: "s", operation: { kind: "profiles.list" } }),
    ).rejects.toMatchObject({ category: "bad-request", status: 400 });
  });

  it("caps timeoutMs into the request body", async () => {
    server.setHandler((req) => ({
      json: { requestId: (req.body as { requestId: string }).requestId, ok: true, data: {} },
    }));
    await client().request({
      requestId: "c",
      sessionId: "s",
      operation: { kind: "profiles.list" },
      timeoutMs: 999_999,
    });
    expect((server.requests[0].body as { timeoutMs: number }).timeoutMs).toBe(MAX_REQUEST_TIMEOUT_MS);
  });

  it("surfaces outcome:unknown when a mutating request is aborted mid-flight", async () => {
    // Never respond, so the caller's signal aborts the in-flight POST.
    server.setHandler(() => new Promise<never>(() => {}) as never);
    const ac = new AbortController();
    const p = client().request({
      requestId: "c",
      sessionId: "s",
      operation: { kind: "page.navigate", tabId: "t", url: "https://example.com" },
      signal: ac.signal,
    });
    ac.abort(new Error("user cancelled"));
    await expect(p).rejects.toMatchObject({ category: "timeout", outcome: "unknown" });
  });

  it("surfaces outcome:unknown when a mutating request aborts mid-BODY (headers already sent)", async () => {
    // Send headers + a partial chunk, then hang. The abort fires while the body
    // stream is being read — the boundary must still classify it as timeout
    // + outcome:unknown, not a raw AbortError leaking out.
    server.setStreamHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"requestId":"c","ok":true,"da');
      // never end
    });
    const ac = new AbortController();
    const p = client().request({
      requestId: "c",
      sessionId: "s",
      operation: { kind: "page.click", tabId: "t", selector: "#go" },
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort(new Error("user cancelled mid-body"));
    await expect(p).rejects.toMatchObject({ category: "timeout", outcome: "unknown" });
  });

  it("does NOT attach an outcome when a read (capabilities) aborts mid-body", async () => {
    server.setStreamHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"protocolVersi');
    });
    const ac = new AbortController();
    const p = client().getCapabilities(ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort(new Error("cancelled"));
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeRequestError);
    expect((err as RuntimeRequestError).category).toBe("timeout");
    expect((err as RuntimeRequestError).outcome).toBeUndefined();
  });

  it("classifies a slow HTTP error body that aborts as timeout+unknown for a mutating request", async () => {
    // Non-2xx status, but the error body itself stalls; aborting during that
    // read must still be treated as mutating timeout (the action may have run).
    server.setStreamHandler((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.write("internal error deta");
    });
    const ac = new AbortController();
    const p = client().request({
      requestId: "c",
      sessionId: "s",
      operation: { kind: "page.fill", tabId: "t", selector: "#x", value: "v" },
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort(new Error("cancelled during error body"));
    await expect(p).rejects.toMatchObject({ category: "timeout", outcome: "unknown" });
  });
});

describe("cancel", () => {
  it("issues a request.cancel with a fresh id and swallows failures", async () => {
    server.setHandler((req) => ({
      json: { requestId: (req.body as { requestId: string }).requestId, ok: true, data: {} },
    }));
    await client().cancel({ sessionId: "s", requestId: "c:cancel", targetRequestId: "c" });
    expect(server.requests[0].body).toMatchObject({
      requestId: "c:cancel",
      operation: { kind: "request.cancel", targetRequestId: "c" },
    });
  });
});

function group() {
  return {
    groupId: "g1",
    sessionId: "s",
    profileId: "profile-1",
    name: "work",
    state: "ready",
    browserEpoch: "e1",
    revision: 1,
  };
}

// Type-only guard: RuntimeRequestError is exported and instanceof-checkable.
it("RuntimeRequestError is an Error subclass", () => {
  const e = new RuntimeRequestError("protocol", "x");
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe("RuntimeRequestError");
});
