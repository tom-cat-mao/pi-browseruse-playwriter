/**
 * Registration + end-to-end shaping tests for the extension factory. The
 * factory is invoked with a mock ExtensionAPI to capture tools/commands/hooks.
 * A real local HTTP server stands in for the runtime (via PI_BROWSER_HOST) so we
 * can assert that structured resources (groupId/tabId/snapshotId/evaluate value)
 * actually land in the tool `content` the LLM sees — not just in `details`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import factory from "../extensions/index.ts";
import * as bootstrap from "../extensions/bootstrap.ts";
import { startTestServer, validCapabilities, validProfile, type TestServer } from "./test-server.ts";

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type RegisteredTool = {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: { properties?: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: ContentBlock[]; details: Record<string, unknown> }>;
  renderCall?: (...args: unknown[]) => unknown;
  renderResult?: (...args: unknown[]) => unknown;
};

function makeMockPi() {
  const tools: RegisteredTool[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      tools.push(tool);
    }),
    registerCommand: vi.fn((name: string) => {
      commands.push(name);
    }),
    on: vi.fn((event: string) => {
      events.push(event);
    }),
  };
  return { pi, tools, commands, events };
}

function makeCtx(sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") {
  return { sessionManager: { getSessionId: () => sessionId }, cwd: "/tmp", model: { input: ["text"] } };
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("extension factory registration", () => {
  it("registers the 12 managed tools and no browser_save_as_pdf", () => {
    const { pi, tools } = makeMockPi();
    factory(pi as never);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "browser_profiles",
        "browser_groups",
        "browser_tabs",
        "browser_navigate",
        "browser_snapshot",
        "browser_click",
        "browser_fill",
        "browser_evaluate",
        "browser_screenshot",
        "browser_network",
        "browser_logs",
        "browser_execute",
      ].sort(),
    );
    expect(tools.some((t) => t.name === "browser_save_as_pdf")).toBe(false);
  });

  it("gives every tool a promptSnippet, self-naming guidelines, and renderers", () => {
    const { pi, tools } = makeMockPi();
    factory(pi as never);
    for (const tool of tools) {
      expect(tool.promptSnippet, tool.name).toBeTruthy();
      for (const guideline of tool.promptGuidelines ?? []) {
        expect(guideline, `${tool.name} guideline names its tool`).toContain(tool.name);
      }
      expect(typeof tool.execute).toBe("function");
      expect(typeof tool.renderCall).toBe("function");
      expect(typeof tool.renderResult).toBe("function");
    }
  });

  it("exposes a /browser-status command and a session_shutdown hook", () => {
    const { pi, commands, events } = makeMockPi();
    factory(pi as never);
    expect(commands).toContain("browser-status");
    expect(events).toContain("session_shutdown");
  });

  it("declares browser_click with selector + optional snapshotId (no auto .first ref)", () => {
    const { pi, tools } = makeMockPi();
    factory(pi as never);
    const click = tools.find((t) => t.name === "browser_click")!;
    expect(Object.keys(click.parameters.properties ?? {}).sort()).toEqual(["selector", "snapshotId", "tabId"].sort());
  });
});

describe("tool execution shaping (real HTTP runtime)", () => {
  let server: TestServer;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    server = await startTestServer();
    process.env.PI_BROWSER_HOST = server.baseUrl;
    bootstrap.reset();
  });
  afterEach(async () => {
    await server.close();
    process.env = { ...savedEnv };
    bootstrap.reset();
  });

  function toolByName(name: string): RegisteredTool {
    const { pi, tools } = makeMockPi();
    factory(pi as never);
    return tools.find((t) => t.name === name)!;
  }

  function runtimeHandler(dataFor: (op: { kind: string }) => Record<string, unknown>) {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [validProfile] } };
      const body = req.body as { requestId: string; operation: { kind: string } };
      return { json: { requestId: body.requestId, ok: true, data: dataFor(body.operation) } };
    });
  }

  it("puts a created group's id into content so the LLM can use it", async () => {
    runtimeHandler(() => ({
      group: {
        groupId: "grp-42",
        sessionId: "s",
        profileId: "profile-1",
        name: "work",
        state: "ready",
        browserEpoch: "e",
        revision: 1,
      },
    }));
    const groups = toolByName("browser_groups");
    const res = await groups.execute(
      "call-1",
      { action: "create", profileId: "profile-1", name: "work" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(textOf(res.content)).toContain("grp-42");
    expect(res.details.group).toBeTruthy();
  });

  it("puts a created tab's id into content", async () => {
    runtimeHandler(() => ({
      tab: {
        tabId: "tab-7",
        groupId: "grp-42",
        sessionId: "s",
        profileId: "profile-1",
        url: "https://example.com",
        title: "Example",
        state: "ready",
        browserEpoch: "e",
        revision: 1,
        chromeTabId: 99,
      },
    }));
    const tabs = toolByName("browser_tabs");
    const res = await tabs.execute(
      "call-2",
      { action: "create", groupId: "grp-42", url: "https://example.com" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(textOf(res.content)).toContain("tab-7");
  });

  it("surfaces snapshotId and the tree text from a snapshot", async () => {
    runtimeHandler(() => ({ text: "- button \"Login\" [aria-ref=e5]", snapshotId: "snap-1" }));
    const snap = toolByName("browser_snapshot");
    const res = await snap.execute("call-3", { tabId: "tab-7" }, undefined, undefined, makeCtx());
    const t = textOf(res.content);
    expect(t).toContain("snap-1");
    expect(t).toContain("aria-ref=e5");
  });

  it("surfaces an evaluate value into content", async () => {
    runtimeHandler(() => ({ value: { count: 3 } }));
    const evaluate = toolByName("browser_evaluate");
    const res = await evaluate.execute("call-4", { tabId: "tab-7", code: "return 3" }, undefined, undefined, makeCtx());
    expect(textOf(res.content)).toContain("\"count\":3");
  });

  it("injects the full session UUID and toolCallId into the wire request", async () => {
    runtimeHandler(() => ({ profiles: [validProfile] }));
    const profiles = toolByName("browser_profiles");
    await profiles.execute("call-5", {}, undefined, undefined, makeCtx("full-uuid-123"));
    const post = server.requests.find((r) => r.url === "/browser/v1/request");
    expect(post?.body).toMatchObject({ requestId: "call-5", sessionId: "full-uuid-123" });
  });

  it("does not launch the runtime when the caller signal is already aborted", async () => {
    runtimeHandler(() => ({}));
    const nav = toolByName("browser_navigate");
    const ac = new AbortController();
    ac.abort(new Error("cancelled"));
    await expect(
      nav.execute("call-6", { tabId: "tab-7", url: "https://x.com" }, ac.signal, undefined, makeCtx()),
    ).rejects.toThrow(/cancelled before it started/);
    expect(server.requests.length).toBe(0);
  });

  it("preserves runtime error code/outcome in the thrown message", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      const body = req.body as { requestId: string };
      return {
        json: {
          requestId: body.requestId,
          ok: false,
          error: { code: "resource-not-found", message: "no such tab", outcome: "not-started" },
        },
      };
    });
    const nav = toolByName("browser_navigate");
    await expect(
      nav.execute("call-7", { tabId: "missing", url: "https://x.com" }, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/resource-not-found/);
  });

  it("keeps snapshotId intact and emits an explicit truncation when an evaluate value is oversize", async () => {
    // A ~200k-char string value cannot fit the structured budget; the ids must
    // still be present + parseable and the value must be flagged as truncated
    // (never sliced into invalid JSON).
    const huge = "x".repeat(200_000);
    runtimeHandler(() => ({ snapshotId: "snap-keep", value: huge }));
    const evaluate = toolByName("browser_evaluate");
    const res = await evaluate.execute("call-8", { tabId: "t", code: "return big" }, undefined, undefined, makeCtx());
    const t = textOf(res.content);
    // snapshotId survives as valid JSON on its own line.
    const idsLine = t.split("\n").find((l) => l.startsWith("{"))!;
    expect(() => JSON.parse(idsLine)).not.toThrow();
    expect(JSON.parse(idsLine).snapshotId).toBe("snap-keep");
    expect(t).toContain("value truncated");
    expect(res.details.value).toBe(huge); // details keeps the full value for the UI
  });

  it("bounds total content text so a giant snapshot plus logs cannot overflow", async () => {
    runtimeHandler(() => ({
      text: "T".repeat(500_000),
      logs: Array.from({ length: 500 }, (_v, i) => `line ${i} ${"L".repeat(500)}`),
      snapshotId: "snap-big",
    }));
    const snap = toolByName("browser_snapshot");
    const res = await snap.execute("call-9", { tabId: "t" }, undefined, undefined, makeCtx());
    const t = textOf(res.content);
    // Total emitted text stays within the hard byte ceiling (plus small markers).
    expect(Buffer.byteLength(t, "utf8")).toBeLessThan(95_000);
    // The tiny structured id is never dropped.
    expect(t).toContain("snap-big");
  });

  it("measures the budget in UTF-8 bytes for multibyte (Chinese) content", async () => {
    // 60k Chinese chars = ~180KB UTF-8; a char-based budget would wrongly let
    // this through. Assert the true byte size stays under the ceiling.
    runtimeHandler(() => ({ text: "中".repeat(60_000), snapshotId: "snap-cn" }));
    const snap = toolByName("browser_snapshot");
    const res = await snap.execute("call-10", { tabId: "t" }, undefined, undefined, makeCtx());
    const t = textOf(res.content);
    expect(Buffer.byteLength(t, "utf8")).toBeLessThanOrEqual(90_000);
    expect(t).toContain("snap-cn");
  });

  it("truncates a huge group listing item-by-item into valid JSON with a count", async () => {
    // Thousands of groups with long Chinese names + long urls. The structured
    // block must stay parseable JSON, keep only what fits, and record how many
    // were dropped — never dump the full giant array or slice invalid JSON.
    const groups = Array.from({ length: 4000 }, (_v, i) => ({
      groupId: `g-${i}`,
      sessionId: "s",
      profileId: "profile-1",
      name: `分组名称非常长的中文测试${i}`,
      state: "ready",
      browserEpoch: "e",
      revision: 1,
    }));
    runtimeHandler(() => ({ groups }));
    const tool = toolByName("browser_groups");
    const res = await tool.execute("call-11", { action: "list" }, undefined, undefined, makeCtx());
    const t = textOf(res.content);
    const jsonLine = t.split("\n").find((l) => l.startsWith("{"))!;
    const parsed = JSON.parse(jsonLine) as { groups: unknown[]; groupsTruncated?: number };
    expect(Array.isArray(parsed.groups)).toBe(true);
    expect(parsed.groups.length).toBeLessThan(4000);
    expect(parsed.groupsTruncated).toBe(4000 - parsed.groups.length);
    expect(Buffer.byteLength(jsonLine, "utf8")).toBeLessThanOrEqual(24_000);
    // details keeps the full listing for the UI.
    expect((res.details.groups as unknown[]).length).toBe(4000);
  });

  it("keeps snapshotId intact even when a listing is truncated", async () => {
    const tabs = Array.from({ length: 3000 }, (_v, i) => ({
      tabId: `t-${i}`,
      groupId: "g",
      sessionId: "s",
      profileId: "profile-1",
      url: `https://example.com/very/long/path/segment/${i}/${"x".repeat(80)}`,
      title: `标签页标题${i}`,
      state: "ready",
      browserEpoch: "e",
      revision: 1,
      chromeTabId: i,
    }));
    runtimeHandler(() => ({ tabs, snapshotId: "keep-me" }));
    const tool = toolByName("browser_tabs");
    const res = await tool.execute("call-12", { action: "list" }, undefined, undefined, makeCtx());
    const jsonLine = textOf(res.content).split("\n").find((l) => l.startsWith("{"))!;
    const parsed = JSON.parse(jsonLine) as { snapshotId?: string; tabs: unknown[]; tabsTruncated?: number };
    expect(parsed.snapshotId).toBe("keep-me");
    expect(parsed.tabs.length).toBeLessThan(3000);
    expect(parsed.tabsTruncated).toBeGreaterThan(0);
  });

  it("does not split an emoji when byte-truncating primary text", async () => {
    // A wall of 4-byte emoji whose UTF-8 size far exceeds the text budget: the
    // truncated content must stay valid (no U+FFFD replacement char from a lone
    // surrogate) while still landing under the byte ceiling.
    runtimeHandler(() => ({ text: "😀".repeat(40_000), snapshotId: "snap-emoji" }));
    const snap = toolByName("browser_snapshot");
    const res = await snap.execute("call-13", { tabId: "t" }, undefined, undefined, makeCtx());
    const t = textOf(res.content);
    expect(Buffer.byteLength(t, "utf8")).toBeLessThanOrEqual(90_000);
    expect(t).not.toContain("\uFFFD");
    expect(t).toContain("snap-emoji");
  });

  it("keeps a single tab's ids parseable even with a huge title/url (clamps display fields)", async () => {
    // One tab whose title and url alone exceed the structured budget. The block
    // must still be valid JSON with tabId + snapshotId intact and stay <=24k.
    runtimeHandler(() => ({
      snapshotId: "snap-solo",
      tab: {
        tabId: "the-real-tab-id",
        groupId: "g",
        sessionId: "s",
        profileId: "profile-1",
        url: `https://example.com/${"路径".repeat(30_000)}`,
        title: "巨大标题".repeat(30_000),
        state: "ready",
        browserEpoch: "e",
        revision: 1,
        chromeTabId: 1,
      },
    }));
    const tool = toolByName("browser_tabs");
    const res = await tool.execute("call-14", { action: "create", groupId: "g", url: "https://x" }, undefined, undefined, makeCtx());
    const jsonLine = textOf(res.content).split("\n").find((l) => l.startsWith("{"))!;
    expect(Buffer.byteLength(jsonLine, "utf8")).toBeLessThanOrEqual(24_000);
    const parsed = JSON.parse(jsonLine) as { snapshotId?: string; tab: { tabId: string } };
    expect(parsed.tab.tabId).toBe("the-real-tab-id");
    expect(parsed.snapshotId).toBe("snap-solo");
  });

  it("stays within budget and parseable when profiles+groups+tabs are all huge together", async () => {
    const mk = (n: number, kind: string) =>
      Array.from({ length: n }, (_v, i) => ({
        sessionId: "s",
        profileId: `p-${kind}-${i}`,
        state: "ready",
        browserEpoch: "e",
        revision: 1,
      }));
    const profiles = mk(2000, "pf").map((b, i) => ({ ...b, profileId: `pf-${i}`, browser: "chrome", label: `标签${i}`, connected: true, capabilities: validCapabilities }));
    const groups = mk(2000, "g").map((b, i) => ({ ...b, groupId: `g-${i}`, name: `组名称${i}` }));
    const tabs = mk(2000, "t").map((b, i) => ({ ...b, tabId: `t-${i}`, groupId: "g", url: `https://e.com/${i}`, title: `标题${i}`, chromeTabId: i }));
    runtimeHandler(() => ({ profiles, groups, tabs, snapshotId: "combo" }));
    const tool = toolByName("browser_tabs");
    const res = await tool.execute("call-15", { action: "list" }, undefined, undefined, makeCtx());
    const jsonLine = textOf(res.content).split("\n").find((l) => l.startsWith("{"))!;
    // Whole combined structured block honors the byte budget and stays parseable.
    expect(Buffer.byteLength(jsonLine, "utf8")).toBeLessThanOrEqual(24_000);
    const parsed = JSON.parse(jsonLine) as Record<string, unknown>;
    expect(parsed.snapshotId).toBe("combo");
    // At least one list got truncated (they can't all fit) and JSON is valid.
    const truncatedKeys = Object.keys(parsed).filter((k) => k.endsWith("Truncated"));
    expect(truncatedKeys.length).toBeGreaterThan(0);
  });
  it("puts discovered existing tabs (with candidateId and window/active state) into content", async () => {
    runtimeHandler(() => ({
      text: "Discovered 2 existing tab(s) across 1 connected profile(s).",
      candidates: [
        {
          candidateId: "pcdt:profile-1:epoch-a:7",
          profileId: "profile-1",
          profileLabel: "work@example.com",
          browser: "chrome",
          browserEpoch: "epoch-a",
          windowId: 3,
          active: true,
          windowFocused: false,
          chromeTabId: 7,
          url: "https://billing.example.com/draft",
          title: "Invoice draft",
          managed: false,
          ownedByThisSession: false,
          attachable: true,
        },
        {
          candidateId: "pcdt:profile-1:epoch-a:9",
          profileId: "profile-1",
          profileLabel: "work@example.com",
          browser: "chrome",
          browserEpoch: "epoch-a",
          windowId: 4,
          active: true,
          windowFocused: true,
          chromeTabId: 9,
          url: "https://billing.example.com/archive",
          title: "Invoice archive",
          managed: false,
          ownedByThisSession: false,
          attachable: true,
        },
      ],
    }));
    const tool = toolByName("browser_tabs");
    const res = await tool.execute("call-16", { action: "discover", query: "invoice" }, undefined, undefined, makeCtx());
    const t = textOf(res.content);
    expect(t).toContain("pcdt:profile-1:epoch-a:7");
    expect(t).toContain("pcdt:profile-1:epoch-a:9");
    const jsonLine = t.split("\n").find((l) => l.startsWith("{"))!;
    const parsed = JSON.parse(jsonLine) as {
      candidates: Array<{ windowId: number; active: boolean; windowFocused: boolean; browser: string; profileLabel: string }>;
    };
    // Every window keeps its own active flag: nothing is collapsed into a
    // single "current tab".
    expect(parsed.candidates.map((c) => [c.windowId, c.active, c.windowFocused])).toEqual([
      [3, true, false],
      [4, true, true],
    ]);
    // Browser + profile label survive so two Chrome builds/profiles with the
    // same tab title can be told apart.
    expect(parsed.candidates.map((c) => [c.browser, c.profileLabel])).toEqual([
      ["chrome", "work@example.com"],
      ["chrome", "work@example.com"],
    ]);
    const post = server.requests.find((r) => r.url === "/browser/v1/request");
    expect(post?.body).toMatchObject({ operation: { kind: "tabs.discover", query: "invoice" } });
  });

  it("attach sends the candidateId and surfaces the real tabId it returns", async () => {
    runtimeHandler(() => ({
      tab: {
        tabId: "tab-existing-1",
        groupId: "grp-internal",
        sessionId: "s",
        profileId: "profile-1",
        url: "https://billing.example.com/draft",
        title: "Invoice draft",
        state: "ready",
        browserEpoch: "epoch-a",
        revision: 1,
        chromeTabId: 7,
        origin: "existing",
      },
    }));
    const tool = toolByName("browser_tabs");
    const res = await tool.execute(
      "call-17",
      { action: "attach", candidateId: "pcdt:profile-1:epoch-a:7" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(textOf(res.content)).toContain("tab-existing-1");
    const post = server.requests.find((r) => r.url === "/browser/v1/request");
    expect(post?.body).toMatchObject({ operation: { kind: "tabs.attach", candidateId: "pcdt:profile-1:epoch-a:7" } });
    await expect(
      tool.execute("call-18", { action: "attach" }, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/candidateId/);
  });

  it("sends page.back for history back and never a goto to the old url", async () => {
    runtimeHandler(() => ({ text: "Went back to https://example.com/list", value: { url: "https://example.com/list", wentBack: true } }));
    const nav = toolByName("browser_navigate");
    const res = await nav.execute("call-19", { tabId: "tab-7", action: "back" }, undefined, undefined, makeCtx());
    const post = server.requests.find((r) => r.url === "/browser/v1/request");
    expect(post?.body).toMatchObject({ operation: { kind: "page.back", tabId: "tab-7" } });
    expect((post?.body as { operation: Record<string, unknown> }).operation.url).toBeUndefined();
    expect(textOf(res.content)).toContain("Went back");
  });

  it("activates an existing tab and lists child tabs by their source tab", async () => {
    runtimeHandler(() => ({ tab: { tabId: "tab-7", groupId: "g", sessionId: "s", profileId: "profile-1", url: "https://x", title: "X", state: "ready", browserEpoch: "e", revision: 1, chromeTabId: 1, sourceTabId: "tab-1" } }));
    const tool = toolByName("browser_tabs");
    await tool.execute("call-20", { action: "activate", tabId: "tab-7" }, undefined, undefined, makeCtx());
    const activate = server.requests.find((r) => r.url === "/browser/v1/request");
    expect(activate?.body).toMatchObject({ operation: { kind: "tabs.activate", tabId: "tab-7" } });

    await tool.execute("call-21", { action: "list", sourceTabId: "tab-1" }, undefined, undefined, makeCtx());
    const list = server.requests.filter((r) => r.url === "/browser/v1/request").at(-1);
    expect(list?.body).toMatchObject({ operation: { kind: "tabs.list", sourceTabId: "tab-1" } });
    // The source link is part of what the model sees, not just details.
    expect(textOf((await tool.execute("call-22", { action: "list", sourceTabId: "tab-1" }, undefined, undefined, makeCtx())).content)).toContain("tab-1");
  });
});
