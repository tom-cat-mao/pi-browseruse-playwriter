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
import { PageContextStore } from "../extensions/page-context.ts";
import { startTestServer, validCapabilities, validProfile, type TestServer } from "./test-server.ts";

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Rendered = { render(width: number): string[] };
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
  renderCall?: (args: Record<string, unknown>, theme: unknown, context: { expanded: boolean }) => Rendered;
  renderResult?: (
    result: { content: ContentBlock[]; details: Record<string, unknown> },
    options: { expanded: boolean },
    theme: unknown,
    context: unknown,
  ) => Rendered;
};

// A theme that returns text unchanged, so renderer assertions read real content.
const renderTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function renderCallText(tool: RegisteredTool, args: Record<string, unknown>, expanded: boolean): string {
  return tool.renderCall!(args, renderTheme, { expanded }).render(220).join("\n");
}

function renderResultText(
  tool: RegisteredTool,
  result: { content: ContentBlock[]; details: Record<string, unknown> },
  options: { expanded: boolean; isError?: boolean; args?: Record<string, unknown> },
): string {
  return tool
    .renderResult!(result, { expanded: options.expanded }, renderTheme, {
      isError: options.isError === true,
      args: options.args ?? {},
    })
    .render(220)
    .join("\n");
}

function makeMockPi() {
  const tools: RegisteredTool[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      tools.push(tool);
    }),
    registerCommand: vi.fn((name: string) => {
      commands.push(name);
    }),
    on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      events.push(event);
      handlers.set(event, handler);
    }),
  };
  return { pi, tools, commands, events, handlers };
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
    // single "current tab". (Display order is active-first, focused-window
    // auxiliary — asserted by windowId, not array position.)
    const byWindow = new Map(parsed.candidates.map((c) => [c.windowId, c]));
    expect([byWindow.get(3)?.active, byWindow.get(3)?.windowFocused]).toEqual([true, false]);
    expect([byWindow.get(4)?.active, byWindow.get(4)?.windowFocused]).toEqual([true, true]);
    // Both are active; the focused window is the auxiliary tie-break.
    expect(parsed.candidates.map((c) => c.windowId)).toEqual([4, 3]);
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

  // --- Pi-only discover pagination -----------------------------------------

  function discoverCandidates(count: number, activeIndex = -1) {
    return Array.from({ length: count }, (_v, i) => ({
      candidateId: `pcdt:profile-1:epoch-a:${i}`,
      profileId: "profile-1",
      profileLabel: "work@example.com",
      browser: "chrome",
      browserEpoch: "epoch-a",
      windowId: 3,
      active: i === activeIndex,
      windowFocused: i === activeIndex,
      chromeTabId: i,
      url: `https://example.com/tab/${i}`,
      title: `Tab ${i}`,
      managed: false,
      ownedByThisSession: false,
      attachable: true,
    }));
  }

  function structuredLine(text: string): Record<string, unknown> {
    const line = text.split("\n").find((l) => l.startsWith("{"));
    expect(line).toBeTruthy();
    return JSON.parse(line!) as Record<string, unknown>;
  }

  it("paginates discover locally: active first, total/returned/nextOffset/truncated, no new wire fields", async () => {
    runtimeHandler(() => ({
      text: "Discovered 145 existing tab(s) across 1 connected profile(s).",
      candidates: discoverCandidates(145, 144),
    }));
    const tool = toolByName("browser_tabs");
    const res = await tool.execute(
      "call-discover-page-1",
      { action: "discover", query: "tab", profileId: "profile-1", windowId: 3, includeManaged: false },
      undefined,
      undefined,
      makeCtx(),
    );
    const t = textOf(res.content);
    expect(t).toContain("total=145 returned=20 nextOffset=20 truncated=true");
    const parsed = structuredLine(t) as { candidates: Array<{ candidateId: string; active: boolean }> };
    expect(parsed.candidates).toHaveLength(20);
    // The active tab (last in runtime order) is surfaced before the byte budget.
    expect(parsed.candidates[0]).toMatchObject({ candidateId: "pcdt:profile-1:epoch-a:144", active: true });
    expect(res.details.discover).toMatchObject({
      total: 145,
      offset: 0,
      returned: 20,
      nextOffset: 20,
      truncated: true,
    });
    // Existing discover semantics are forwarded; offset/limit are Pi-only.
    const post = server.requests.find((r) => r.url === "/browser/v1/request");
    const op = (post?.body as { operation: Record<string, unknown> }).operation;
    expect(op).toMatchObject({
      kind: "tabs.discover",
      query: "tab",
      profileId: "profile-1",
      windowId: 3,
      includeManaged: false,
    });
    expect("offset" in op).toBe(false);
    expect("limit" in op).toBe(false);
  });

  it("walks every discover page without losing a single candidate id", async () => {
    const candidates = discoverCandidates(145);
    runtimeHandler(() => ({ candidates }));
    const tool = toolByName("browser_tabs");
    const seen: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 20; guard++) {
      const res = await tool.execute(
        `call-walk-${offset}`,
        { action: "discover", offset, limit: 20 },
        undefined,
        undefined,
        makeCtx(),
      );
      const parsed = structuredLine(textOf(res.content)) as { candidates: Array<{ candidateId: string }> };
      seen.push(...parsed.candidates.map((c) => c.candidateId));
      const page = res.details.discover as { nextOffset: number | null; truncated: boolean };
      if (!page.truncated) break;
      offset = page.nextOffset!;
    }
    expect(seen).toHaveLength(145);
    expect(new Set(seen).size).toBe(145);
    expect(new Set(seen)).toEqual(new Set(candidates.map((c) => c.candidateId)));
  });

  it("cuts an oversized discover page on bytes and points nextOffset at the first unseen entry", async () => {
    const multibyte = "超长标题用于字节预算测试".repeat(5_000); // far beyond one field clamp
    // Every candidate carries the huge multibyte title, so the requested page
    // cannot fit the byte budget and must be cut mid-page.
    const candidates = discoverCandidates(40).map((candidate) => ({ ...candidate, title: multibyte }));
    runtimeHandler(() => ({ candidates }));
    const tool = toolByName("browser_tabs");
    const first = await tool.execute("call-cut-1", { action: "discover", limit: 20 }, undefined, undefined, makeCtx());
    const firstText = textOf(first.content);
    const parsed = structuredLine(firstText) as { candidates: Array<{ candidateId: string }> };
    const page = first.details.discover as { returned: number; nextOffset: number; truncated: boolean };
    expect(page.returned).toBeGreaterThan(0);
    expect(page.returned).toBeLessThan(20);
    // nextOffset counts what was actually returned, not the requested page size.
    expect(page.nextOffset).toBe(page.returned);
    expect(page.truncated).toBe(true);
    expect(Buffer.byteLength(firstText, "utf8")).toBeLessThan(95_000);
    // The next page begins exactly at the first candidate that did not fit.
    expect(parsed.candidates.at(-1)!.candidateId).toBe(candidates[page.returned - 1].candidateId);
    const next = await tool.execute(
      "call-cut-2",
      { action: "discover", offset: page.nextOffset, limit: 20 },
      undefined,
      undefined,
      makeCtx(),
    );
    const nextParsed = structuredLine(textOf(next.content)) as { candidates: Array<{ candidateId: string }> };
    expect(nextParsed.candidates[0].candidateId).toBe(candidates[page.nextOffset].candidateId);
  });

  // --- human-facing renderers (invoked, not just present) -------------------

  function allTools(): RegisteredTool[] {
    const { pi, tools } = makeMockPi();
    factory(pi as never);
    return tools;
  }

  function toolOf(tools: RegisteredTool[], name: string): RegisteredTool {
    const tool = tools.find((t) => t.name === name);
    expect(tool, name).toBeTruthy();
    return tool!;
  }

  it("renders a compact call line and bounds expanded call arguments", () => {
    const { pi, tools } = makeMockPi();
    factory(pi as never);
    const nav = tools.find((t) => t.name === "browser_navigate")!;
    const folded = renderCallText(nav, { tabId: "ptab-mtwn3svh-5illhh1cdkl18", action: "back" }, false);
    expect(folded).toContain("back");
    expect(folded).not.toContain("ptab-mtwn3svh-5illhh1cdkl18");
    const expanded = renderCallText(
      nav,
      { tabId: "tab-1", action: "goto", url: `https://example.com/${"x".repeat(20_000)}` },
      true,
    );
    expect(Buffer.byteLength(expanded, "utf8")).toBeLessThan(6_000);

    // Raw values interpolated by a call summary are sanitized too.
    const groups = tools.find((t) => t.name === "browser_groups")!;
    const groupCall = renderCallText(
      groups,
      { action: "create", name: "\u001b[31mwork\u001b[0m\nsecond line" },
      false,
    );
    expect(groupCall).not.toContain("\u001b");
    expect(groupCall).toContain("work second line");
    const groupCallExpanded = renderCallText(groups, { action: "create", name: "\u001b[31mwork" }, true);
    expect(groupCallExpanded).not.toContain("\u001b");
    expect(groupCallExpanded).toContain("work");
  });

  it("sanitizes raw group/profile values at the folded-summary choke point", async () => {
    runtimeHandler((op) => {
      if (op.kind === "groups.create") {
        return {
          group: {
            groupId: "grp-1",
            sessionId: "s",
            profileId: "p",
            name: "\u001b[31mwork\u001b[0m\nsecond line",
            state: "ready",
            browserEpoch: "e",
            revision: 1,
          },
        };
      }
      return {
        profiles: [
          {
            profileId: "p",
            browser: "\u001b[32mchrome\u001b[0m",
            label: "Work \u001b]0;x\u0007profile",
            connected: true,
            browserEpoch: "e",
            capabilities: validCapabilities,
          },
        ],
      };
    });
    const tools = allTools();
    const groups = toolOf(tools, "browser_groups");
    const group = await groups.execute(
      "call-g",
      { action: "create", profileId: "p", name: "work" },
      undefined,
      undefined,
      makeCtx(),
    );
    const groupLines = renderResultText(groups, group, { expanded: false });
    expect(groupLines).not.toContain("\u001b");
    expect(groupLines).toContain("work second line");
    expect(groupLines.split("\n")).toHaveLength(2);

    const hugeGroup = {
      content: [{ type: "text" as const, text: "ok" }],
      details: { group: { groupId: "grp-2", name: "名".repeat(3_000), profileId: "p", state: "ready" } },
    };
    const hugeLine = renderResultText(groups, hugeGroup, { expanded: false });
    expect(Buffer.byteLength(hugeLine.split("\n")[0], "utf8")).toBeLessThan(700);

    const profiles = toolOf(tools, "browser_profiles");
    const profile = await profiles.execute("call-p", {}, undefined, undefined, makeCtx());
    const profileLine = renderResultText(profiles, profile, { expanded: false });
    expect(profileLine).not.toContain("\u001b");
    expect(profileLine).toContain("chrome");
  });

  it("shows complete bounded multiline errors expanded and an affordance collapsed", () => {
    const { pi, tools } = makeMockPi();
    factory(pi as never);
    const nav = tools.find((t) => t.name === "browser_navigate")!;
    const errorText = [
      "strict mode violation: selector header resolved to 2 elements",
      "\u001b[31msecond line with raw ESC\u001b[0m",
      "native select failed",
      "code=timeout · outcome=unknown",
    ].join("\n");
    const result = { content: [{ type: "text" as const, text: errorText }], details: {} };
    const expanded = renderResultText(nav, result, { expanded: true, isError: true });
    expect(expanded).not.toContain("\u001b");
    expect(expanded).toContain("second line with raw ESC");
    expect(expanded).toContain("native select failed");
    expect(expanded).toContain("outcome=unknown");
    const collapsed = renderResultText(nav, result, { expanded: false, isError: true });
    expect(collapsed).toContain("strict mode violation");
    expect(collapsed).not.toContain("native select failed");
    expect(collapsed).toMatch(/inspect output/);

    const huge = { content: [{ type: "text" as const, text: `head line\n${"E".repeat(300_000)}` }], details: {} };
    const hugeExpanded = renderResultText(nav, huge, { expanded: true, isError: true });
    expect(Buffer.byteLength(hugeExpanded, "utf8")).toBeLessThan(20_000);
    expect(hugeExpanded).toContain("head line");
  });

  it("strips real ANSI/control sequences and keeps opaque ids intact", async () => {
    runtimeHandler(() => ({
      text: `- button "Save" [aria-ref=e5]\n\u001b[31mred\u001b[0m warning \u001b]0;injected title\u0007 tail\nliteral \\u001b stays text`,
      snapshotId: "managed:ptab-mtwn3svh-5illhh1cdkl18:2:3:uuid",
    }));
    const snapshot = toolByName("browser_snapshot");
    const result = await snapshot.execute(
      "call-ansi",
      { tabId: "ptab-mtwn3svh-5illhh1cdkl18" },
      undefined,
      undefined,
      makeCtx(),
    );
    const expanded = renderResultText(snapshot, result, { expanded: true });
    expect(expanded).not.toContain("\u001b");
    expect(expanded).not.toContain("injected title");
    expect(expanded).toContain("red warning");
    expect(expanded).toContain("literal \\u001b stays text");
    expect(expanded).toContain("managed:ptab-mtwn3svh-5illhh1cdkl18:2:3:uuid");
    const folded = renderResultText(snapshot, result, { expanded: false });
    expect(folded).not.toContain("\u001b");
    expect(folded).toMatch(/…/);
  });

  it("sanitizes value string leaves before serializing so raw ESC is not shown as \\u001b junk", () => {
    const { pi, tools } = makeMockPi();
    factory(pi as never);
    const evaluate = tools.find((t) => t.name === "browser_evaluate")!;
    const rawEsc = {
      content: [{ type: "text" as const, text: "ok" }],
      details: { value: { nested: "\u001b[31mred\u001b[0m" } },
    };
    const folded = renderResultText(evaluate, rawEsc, { expanded: false, args: { tabId: "t" } });
    expect(folded).not.toContain("\u001b");
    expect(folded).toContain("red");
    const expanded = renderResultText(evaluate, rawEsc, { expanded: true, args: { tabId: "t" } });
    expect(expanded).not.toContain("\u001b");
    expect(expanded).toContain("red");

    // A literal backslash-u string is data, not a control sequence: preserved.
    const literal = {
      content: [{ type: "text" as const, text: "ok" }],
      details: { value: { lit: "\\u001b" } },
    };
    const literalOut = renderResultText(evaluate, literal, { expanded: true, args: { tabId: "t" } });
    expect(literalOut).toContain("\\\\u001b");
    expect(literalOut).not.toContain("\u001b");
  });

  it("bounds expanded success detail instead of dumping unlimited raw details", async () => {
    runtimeHandler(() => ({ text: "X".repeat(500_000), snapshotId: "snap-bounded" }));
    const snapshot = toolByName("browser_snapshot");
    const result = await snapshot.execute("call-big", { tabId: "tab-1" }, undefined, undefined, makeCtx());
    const expanded = renderResultText(snapshot, result, { expanded: true });
    expect(Buffer.byteLength(expanded, "utf8")).toBeLessThan(20_000);
    expect(expanded).toContain("snap-bounded");
  });

  it("shows browser_execute value and logs instead of a bare ok", async () => {
    runtimeHandler(() => ({ value: { rows: 3 }, logs: ["[log] one", "[error] boom"] }));
    const execute = toolByName("browser_execute");
    const result = await execute.execute(
      "call-exec",
      { tabId: "tab-1", code: "return { rows: 3 }" },
      undefined,
      undefined,
      makeCtx(),
    );
    const folded = renderResultText(execute, result, { expanded: false, args: { tabId: "tab-1" } });
    expect(folded).toContain("value");
    expect(folded).toContain("rows");
    expect(folded).toContain("2 log line(s)");
    expect(textOf(result.content)).toContain("\"rows\":3");
  });

  it("labels a filtered network list with matches and total retained, and keeps list a bare array", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      const body = req.body as { requestId: string; operation: { kind: string; action?: string } };
      if (body.operation.action === "stop") {
        return {
          json: {
            requestId: body.requestId,
            ok: true,
            data: {
              value: { captureId: "cap-1", entries: [{ url: "https://a.example" }] },
              networkCapture: {
                status: "stopped",
                captureId: "cap-1",
                retainedCount: 7,
                droppedCount: 2,
                reason: "worker-interrupted",
              },
            },
          },
        };
      }
      return {
        json: {
          requestId: body.requestId,
          ok: true,
          data: {
            value: [{ url: "https://a.example" }],
            networkCapture: { status: "active", retainedCount: 5, droppedCount: 0 },
          },
        },
      };
    });
    const tools = allTools();
    const network = toolOf(tools, "browser_network");
    const stopped = await network.execute(
      "call-stop",
      { tabId: "tab-1", action: "stop" },
      undefined,
      undefined,
      makeCtx(),
    );
    const stopFolded = renderResultText(network, stopped, { expanded: false, args: { action: "stop" } });
    expect(stopFolded).toContain("stopped");
    expect(stopFolded).toContain("7 retained");
    expect(stopFolded).toContain("2 dropped");
    expect(textOf(stopped.content)).toContain("network capture: status=stopped");
    expect(stopped.details.networkCapture).toMatchObject({ status: "stopped", retainedCount: 7, droppedCount: 2 });

    const listed = await network.execute(
      "call-list",
      { tabId: "tab-1", action: "list", filter: "a.example" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(Array.isArray(listed.details.value)).toBe(true);
    expect(textOf(listed.content)).toContain("\"value\":[");
    const listFolded = renderResultText(network, listed, { expanded: false, args: { action: "list" } });
    // One matching entry, five retained: the row must not claim five matches.
    expect(listFolded).toContain("1 request(s)");
    expect(listFolded).toContain("of 5 retained");
    expect(listFolded).not.toContain("5 request(s)");
  });

  it("shows the legacy network stop object count without metadata", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      const body = req.body as { requestId: string };
      return {
        json: {
          requestId: body.requestId,
          ok: true,
          data: {
            value: {
              captureId: "cap-legacy",
              entries: [{ url: "https://a.example" }, { url: "https://b.example" }, { url: "https://c.example" }],
            },
          },
        },
      };
    });
    const network = toolByName("browser_network");
    const result = await network.execute(
      "call-stop-legacy",
      { tabId: "tab-1", action: "stop" },
      undefined,
      undefined,
      makeCtx(),
    );
    const folded = renderResultText(network, result, { expanded: false, args: { action: "stop" } });
    expect(folded).toContain("stopped");
    expect(folded).toContain("3 retained");
  });

  it("caches observed page context per Pi session and never shows another session's title", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      const body = req.body as { requestId: string; operation: { kind: string } };
      if (body.operation.kind === "tabs.create") {
        return {
          json: {
            requestId: body.requestId,
            ok: true,
            data: {
              tab: {
                tabId: "tab-ctx",
                groupId: "g",
                sessionId: "s",
                profileId: "p",
                url: "https://billing.example.com/draft",
                title: "Invoice draft",
                state: "ready",
                browserEpoch: "e",
                revision: 1,
                chromeTabId: 7,
              },
            },
          },
        };
      }
      return { json: { requestId: body.requestId, ok: true, data: {} } };
    });
    const tools = allTools();
    const tabs = toolOf(tools, "browser_tabs");
    const click = toolOf(tools, "browser_click");
    await tabs.execute(
      "call-create",
      { action: "create", groupId: "g", url: "https://billing.example.com/draft" },
      undefined,
      undefined,
      makeCtx("session-a"),
    );
    const clickA = await click.execute(
      "call-click-a",
      { tabId: "tab-ctx", selector: "#go" },
      undefined,
      undefined,
      makeCtx("session-a"),
    );
    const foldedA = renderResultText(click, clickA, {
      expanded: false,
      args: { tabId: "tab-ctx", selector: "#go" },
    });
    expect(foldedA).toContain("Invoice draft");
    expect(foldedA).toContain("billing.example.com");

    const clickB = await click.execute(
      "call-click-b",
      { tabId: "tab-ctx", selector: "#go" },
      undefined,
      undefined,
      makeCtx("session-b"),
    );
    const foldedB = renderResultText(click, clickB, {
      expanded: false,
      args: { tabId: "tab-ctx", selector: "#go" },
    });
    expect(foldedB).not.toContain("Invoice draft");
    expect(foldedB).not.toContain("billing.example.com");
  });

  it("session_shutdown drops only the shutting-down session's page context", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      const body = req.body as { requestId: string; sessionId: string; operation: { kind: string } };
      if (body.operation.kind === "tabs.create") {
        return {
          json: {
            requestId: body.requestId,
            ok: true,
            data: {
              tab: {
                tabId: "tab-shared",
                groupId: "g",
                sessionId: body.sessionId,
                profileId: "p",
                url: `https://${body.sessionId}.example/`,
                title: body.sessionId === "session-a" ? "A title" : "B title",
                state: "ready",
                browserEpoch: "e",
                revision: 1,
                chromeTabId: 7,
              },
            },
          },
        };
      }
      return { json: { requestId: body.requestId, ok: true, data: {} } };
    });
    const { pi, tools, handlers } = makeMockPi();
    factory(pi as never);
    const tabs = tools.find((t) => t.name === "browser_tabs")!;
    const click = tools.find((t) => t.name === "browser_click")!;
    for (const sessionId of ["session-a", "session-b"]) {
      await tabs.execute(
        `call-create-${sessionId}`,
        { action: "create", groupId: "g", url: `https://${sessionId}.example/` },
        undefined,
        undefined,
        makeCtx(sessionId),
      );
    }
    const clickArgs = { tabId: "tab-shared", selector: "#go" };
    const clickA = await click.execute("call-click-a", clickArgs, undefined, undefined, makeCtx("session-a"));
    const clickB = await click.execute("call-click-b", clickArgs, undefined, undefined, makeCtx("session-b"));
    expect(renderResultText(click, clickA, { expanded: false, args: clickArgs })).toContain("A title");
    expect(renderResultText(click, clickB, { expanded: false, args: clickArgs })).toContain("B title");

    const shutdown = handlers.get("session_shutdown");
    expect(shutdown).toBeTruthy();
    await shutdown!({}, makeCtx("session-a"));

    // A's context is gone; B's title is retained.
    const afterA = renderResultText(click, clickA, { expanded: false, args: clickArgs });
    expect(afterA).not.toContain("A title");
    expect(afterA).not.toContain("session-a.example");
    expect(renderResultText(click, clickB, { expanded: false, args: clickArgs })).toContain("B title");
  });

  it("prefers the row's own page facts over cached context and updates the cache", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      const body = req.body as { requestId: string; operation: { kind: string } };
      if (body.operation.kind === "tabs.create") {
        return {
          json: {
            requestId: body.requestId,
            ok: true,
            data: {
              tab: {
                tabId: "tab-p",
                groupId: "g",
                sessionId: "s",
                profileId: "p",
                url: "https://old.example/",
                title: "Old title",
                state: "ready",
                browserEpoch: "e",
                revision: 1,
                chromeTabId: 1,
              },
            },
          },
        };
      }
      if (body.operation.kind === "page.snapshot") {
        return {
          json: {
            requestId: body.requestId,
            ok: true,
            data: {
              text: "tree",
              snapshotId: "snap-p",
              pageInfo: { tabId: "tab-p", url: "https://new.example/", title: "New title" },
            },
          },
        };
      }
      return { json: { requestId: body.requestId, ok: true, data: {} } };
    });
    const { pi, tools } = makeMockPi();
    factory(pi as never);
    const tabs = tools.find((t) => t.name === "browser_tabs")!;
    const snapshot = tools.find((t) => t.name === "browser_snapshot")!;
    const click = tools.find((t) => t.name === "browser_click")!;
    await tabs.execute(
      "call-create-p",
      { action: "create", groupId: "g", url: "https://old.example/" },
      undefined,
      undefined,
      makeCtx("session-p"),
    );
    const snap = await snapshot.execute("call-snap-p", { tabId: "tab-p" }, undefined, undefined, makeCtx("session-p"));
    const snapRow = renderResultText(snapshot, snap, { expanded: false, args: { tabId: "tab-p" } });
    expect(snapRow).toContain("New title");
    expect(snapRow).not.toContain("Old title");
    // The observation also refreshed the cache for later rows without page facts.
    const clickResult = await click.execute(
      "call-click-p",
      { tabId: "tab-p", selector: "#go" },
      undefined,
      undefined,
      makeCtx("session-p"),
    );
    const clickRow = renderResultText(click, clickResult, {
      expanded: false,
      args: { tabId: "tab-p", selector: "#go" },
    });
    expect(clickRow).toContain("New title");
  });

  it("uses pageInfo for later rows without any extra browser request", async () => {
    let requestCount = 0;
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      const body = req.body as { requestId: string; operation: { kind: string } };
      requestCount++;
      if (body.operation.kind === "page.snapshot") {
        return {
          json: {
            requestId: body.requestId,
            ok: true,
            data: {
              text: "tree",
              snapshotId: "snap-pi",
              pageInfo: { tabId: "tab-pi", url: "https://news.example.com/a", title: "Latest news" },
            },
          },
        };
      }
      return { json: { requestId: body.requestId, ok: true, data: {} } };
    });
    const tools = allTools();
    const snapshot = toolOf(tools, "browser_snapshot");
    const click = toolOf(tools, "browser_click");
    const snap = await snapshot.execute("call-snap", { tabId: "tab-pi" }, undefined, undefined, makeCtx("session-pi"));
    expect(renderResultText(snapshot, snap, { expanded: false, args: { tabId: "tab-pi" } })).toContain("Latest news");
    const clickResult = await click.execute(
      "call-click",
      { tabId: "tab-pi", selector: "#go" },
      undefined,
      undefined,
      makeCtx("session-pi"),
    );
    const folded = renderResultText(click, clickResult, {
      expanded: false,
      args: { tabId: "tab-pi", selector: "#go" },
    });
    expect(folded).toContain("Latest news");
    expect(requestCount).toBe(2);
  });

  it("puts observed pageInfo into model-visible content and keeps value shape unchanged", async () => {
    runtimeHandler(() => ({
      value: { n: 1 },
      pageInfo: { tabId: "ptab-url", url: "https://news.example.com/a", title: "Latest news" },
    }));
    const evaluate = toolByName("browser_evaluate");
    const result = await evaluate.execute(
      "call-pageinfo",
      { tabId: "ptab-url", code: "return 1" },
      undefined,
      undefined,
      makeCtx(),
    );
    const parsed = structuredLine(textOf(result.content)) as {
      pageInfo?: { tabId: string; url: string; title?: string };
      value: unknown;
    };
    expect(parsed.pageInfo?.tabId).toBe("ptab-url");
    expect(parsed.pageInfo?.url).toBe("https://news.example.com/a");
    expect(parsed.value).toEqual({ n: 1 });
    expect(result.details.value).toEqual({ n: 1 });
  });

  it("shows the back action instead of an empty URL", async () => {
    runtimeHandler(() => ({ text: "Went back to https://example.com/list" }));
    const nav = toolByName("browser_navigate");
    const result = await nav.execute("call-back", { tabId: "tab-7", action: "back" }, undefined, undefined, makeCtx());
    const folded = renderResultText(nav, result, { expanded: false, args: { tabId: "tab-7", action: "back" } });
    expect(folded).toContain("✓ back");
  });

  it("keeps the screenshot image block and shows the saved path", async () => {
    runtimeHandler(() => ({
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
      artifacts: [{ path: "/tmp/shot.png", mimeType: "image/png" }],
    }));
    const screenshot = toolByName("browser_screenshot");
    const ctx = { ...makeCtx(), model: { input: ["text", "image"] } };
    const result = await screenshot.execute(
      "call-shot",
      { tabId: "tab-1", path: "/tmp/shot.png" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content.some((c) => c.type === "image")).toBe(true);
    const folded = renderResultText(screenshot, result, { expanded: false, args: { tabId: "tab-1" } });
    expect(folded).toContain("/tmp/shot.png");
  });

  it("falls back to a short opaque id when no page context is known", async () => {
    runtimeHandler(() => ({
      tab: {
        tabId: "ptab-mtwn3svh-5illhh1cdkl18",
        groupId: "g",
        sessionId: "s",
        profileId: "p",
        url: "",
        title: "",
        state: "ready",
        browserEpoch: "e",
        revision: 1,
        chromeTabId: 1,
      },
    }));
    const tabs = toolByName("browser_tabs");
    const result = await tabs.execute(
      "call-create",
      { action: "create", groupId: "g", url: "about:blank" },
      undefined,
      undefined,
      makeCtx(),
    );
    const folded = renderResultText(tabs, result, { expanded: false, args: { action: "create" } });
    expect(folded).toContain("created");
    expect(folded).toContain("…illhh1cdkl18");
    const expanded = renderResultText(tabs, result, { expanded: true, args: { action: "create" } });
    expect(expanded).toContain("ptab-mtwn3svh-5illhh1cdkl18");
  });
});

describe("PageContextStore bounds and isolation", () => {
  const page = (tabId: string) => ({ tabId, url: `https://example.com/${tabId}`, title: `T ${tabId}` });

  it("evicts the oldest tab at the per-session cap", () => {
    const store = new PageContextStore();
    for (let i = 0; i < 70; i++) store.observe("s1", page(`tab-${i}`));
    expect(store.lookup("s1", "tab-0")).toBeUndefined();
    expect(store.lookup("s1", "tab-5")).toBeUndefined();
    expect(store.lookup("s1", "tab-6")).toBeDefined();
    expect(store.lookup("s1", "tab-69")?.title).toBe("T tab-69");
  });

  it("caps the number of sessions and never crosses them", () => {
    const store = new PageContextStore();
    for (let i = 0; i < 20; i++) store.observe(`session-${i}`, page("tab"));
    expect(store.lookup("session-0", "tab")).toBeUndefined();
    expect(store.lookup("session-19", "tab")?.url).toContain("tab");
    expect(store.lookup("unrelated", "tab")).toBeUndefined();
  });

  it("clears one session without touching another", () => {
    const store = new PageContextStore();
    store.observe("a", page("tab"));
    store.observe("b", page("tab"));
    store.clear("a");
    expect(store.lookup("a", "tab")).toBeUndefined();
    expect(store.lookup("b", "tab")).toBeDefined();
  });
});
