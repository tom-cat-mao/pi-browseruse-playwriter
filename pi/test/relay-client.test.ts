import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RelayError,
  baseUrl,
  execute,
  extractMarker,
  extractUrlLine,
  getCapabilities,
  createSession,
} from "../extensions/relay-client.ts";

const okExecute = { text: "URL: https://example.com\nok", images: [], screenshots: [], isError: false };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PLAYWRITER_TOKEN;
  delete process.env.PLAYWRITER_HOST;
  delete process.env.PLAYWRITER_PORT;
});

describe("baseUrl", () => {
  it("defaults to localhost relay port", () => {
    expect(baseUrl()).toBe("http://127.0.0.1:19988");
  });

  it("honors PLAYWRITER_HOST", () => {
    process.env.PLAYWRITER_HOST = "relay.example.com";
    expect(baseUrl()).toBe("http://relay.example.com:19988");
  });

  it("honors PLAYWRITER_HOST with protocol", () => {
    process.env.PLAYWRITER_HOST = "https://relay.example.com";
    expect(baseUrl()).toBe("https://relay.example.com");
  });
});

describe("getCapabilities degradation", () => {
  it("returns all-false when the endpoint 404s (stock relay)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })));
    expect(await getCapabilities("http://x")).toEqual({ sessionGroups: false, consent: false, audit: false, closeTabs: false });
  });

  it("returns all-false when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect(await getCapabilities("http://x")).toEqual({ sessionGroups: false, consent: false, audit: false, closeTabs: false });
  });

  it("merges partial capabilities from a future relay", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ sessionGroups: true, closeTabs: true })));
    const caps = await getCapabilities("http://x");
    expect(caps).toEqual({ sessionGroups: true, consent: false, audit: false, closeTabs: true });
  });
});

describe("execute error classification", () => {
  it("classifies network failure as relay-unreachable (retryable)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(execute({ sessionId: "1", code: "x" })).rejects.toMatchObject({
      category: "relay-unreachable",
      retryable: true,
    });
  });

  it("classifies HTTP 404 as session-invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "Session 9 not found. Run 'playwriter session new' first." }), { status: 404 })),
    );
    await expect(execute({ sessionId: "9", code: "x" })).rejects.toMatchObject({ category: "session-invalid", status: 404 });
  });

  it("classifies isError body as execute-error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ text: "ReferenceError: foo is not defined", images: [], screenshots: [], isError: true })),
    );
    await expect(execute({ sessionId: "1", code: "foo()" })).rejects.toMatchObject({
      category: "execute-error",
      message: expect.stringContaining("ReferenceError"),
    });
  });

  it("classifies aborted fetch as timeout", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
    await expect(execute({ sessionId: "1", code: "x" })).rejects.toMatchObject({ category: "timeout", retryable: true });
  });

  it("classifies HTTP 500 as http error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    await expect(execute({ sessionId: "1", code: "x" })).rejects.toMatchObject({ category: "http", status: 500 });
  });

  it("returns the execute result on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(okExecute)));
    const res = await execute({ sessionId: "1", code: "x" });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("URL: https://example.com");
  });
});

describe("auth + request shape", () => {
  it("sends Authorization Bearer when PLAYWRITER_TOKEN is set", async () => {
    process.env.PLAYWRITER_TOKEN = "sekret";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(okExecute));
    vi.stubGlobal("fetch", fetchMock);
    await execute({ sessionId: "1", code: "x" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sekret");
  });

  it("posts sessionId/code/timeout to /cli/execute", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(okExecute));
    vi.stubGlobal("fetch", fetchMock);
    await execute({ sessionId: "7", code: "await page.goto('x')", timeoutMs: 5000 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:19988/cli/execute");
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: "7", code: "await page.goto('x')", timeout: 5000 });
  });
});

describe("createSession", () => {
  it("parses the returned session id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "12", mode: "extension" })));
    const s = await createSession("http://x", { name: "pi-abc" });
    expect(s.id).toBe("12");
  });

  it("throws http error on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Extension not connected", { status: 404 })));
    await expect(createSession("http://x", {})).rejects.toMatchObject({ category: "http", status: 404 });
  });
});

describe("extractMarker / extractUrlLine", () => {
  it("extracts the first marker line", () => {
    expect(extractMarker("URL: https://a.com\nRESULT: 42", "RESULT")).toBe("42");
    expect(extractMarker("nothing here", "RESULT")).toBeNull();
  });

  it("extracts the URL line", () => {
    expect(extractUrlLine("URL: https://a.com\nTitle: x")).toBe("https://a.com");
  });
});
