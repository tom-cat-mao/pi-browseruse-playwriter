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

/** A managed tab whose profile is the one the extract gate inspects. */
const extractTab = {
  tabId: "tab-1",
  groupId: "grp-1",
  sessionId: "s",
  profileId: "profile-1",
  url: "https://example.com/article",
  title: "Example article",
  state: "ready",
  browserEpoch: "e",
  revision: 1,
  chromeTabId: 7,
};

/** A profile advertising exactly the given page operations (or none at all). */
function profileWith(supportedOperations: string[] | undefined, browser = "chrome") {
  return {
    ...validProfile,
    browser,
    capabilities: {
      ...validCapabilities,
      ...(supportedOperations ? { supportedOperations } : {}),
    },
  };
}

/**
 * A webextension (Firefox) profile advertising the given asset modes; with no
 * `assetModes` it advertises no features at all, like a peer that predates the
 * matrix. Its page operations are advertised unless `supportedOperations` says
 * otherwise.
 */
function firefoxProfile({
  assetModes,
  supportedOperations = ["page.snapshot", "page.extract"],
}: {
  assetModes?: string[];
  supportedOperations?: string[];
}) {
  return {
    ...validProfile,
    browser: "firefox",
    capabilities: {
      ...validCapabilities,
      backend: "webextension",
      inputMode: "dom",
      snapshotMode: "dom-aria",
      executeMode: "dom-compatible",
      evaluateWorld: "isolated",
      supportedOperations,
      ...(assetModes ? { features: { extract: ["markdown"], assets: assetModes } } : {}),
    },
  };
}

describe("extension factory registration", () => {
  it("registers the 13 managed tools and no browser_save_as_pdf", () => {
    const { pi, tools } = makeMockPi();
    factory(pi as never);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "browser_profiles",
        "browser_groups",
        "browser_tabs",
        "browser_navigate",
        "browser_snapshot",
        "browser_extract",
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

  it("declares browser_extract with tabId plus the extraction window, images and export options", () => {
    const { pi, tools } = makeMockPi();
    factory(pi as never);
    const extract = tools.find((t) => t.name === "browser_extract")!;
    expect(Object.keys(extract.parameters.properties ?? {}).sort()).toEqual(
      ["format", "images", "limit", "offset", "path", "search", "tabId"].sort(),
    );
    const properties = extract.parameters.properties as Record<string, { enum?: readonly string[] }>;
    expect(properties.format.enum).toEqual(["markdown", "text", "html", "assets-manifest"]);
    expect(properties.images.enum).toEqual(["none", "urls", "save"]);
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
  it("puts Firefox backend capabilities and limitations in model-visible profile content", async () => {
    const capabilities = {
      ...validCapabilities,
      existingTabControl: true,
      backend: "webextension",
      inputMode: "dom",
      snapshotMode: "dom-aria",
      executeMode: "dom-compatible",
      evaluateWorld: "isolated",
      supportedOperations: ["page.snapshot", "page.evaluate"],
      limitations: ["DOM input cannot create trusted user events."],
    };
    runtimeHandler(() => {
      return { profiles: [{ ...validProfile, browser: "firefox", capabilities }] };
    });
    const profiles = toolByName("browser_profiles");
    const result = await profiles.execute("call-firefox-profile", {}, undefined, undefined, makeCtx());
    const content = JSON.parse(textOf(result.content));
    expect(content.profiles[0].capabilities).toEqual(capabilities);
    expect(renderResultText(profiles, result, { expanded: false })).toContain("DOM input");
  });
  it("bounds long capability limitations while retaining backend modes and profile identity", async () => {
    runtimeHandler(() => {
      return {
        profiles: [{
          ...validProfile,
          browser: "firefox",
          capabilities: {
            ...validCapabilities,
            backend: "webextension",
            inputMode: "dom",
            limitations: Array.from({ length: 32 }, () => { return "限制".repeat(800); }),
          },
        }],
      };
    });
    const profiles = toolByName("browser_profiles");
    const result = await profiles.execute("call-firefox-bounded", {}, undefined, undefined, makeCtx());
    const text = textOf(result.content);
    const content = JSON.parse(text);
    expect(content.profiles[0].profileId).toBe(validProfile.profileId);
    expect(content.profiles[0].capabilities).toMatchObject({
      backend: "webextension",
      inputMode: "dom",
      limitationsTruncated: true,
    });
    expect(Buffer.byteLength(text)).toBeLessThan(24_000);
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

  it("sends page.extract for the given tab and defaults the format to markdown", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [profileWith(["page.snapshot", "page.extract"])] } };
      const body = req.body as { requestId: string; operation: { kind: string } };
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [extractTab] } } };
      }
      return {
        json: {
          requestId: body.requestId,
          ok: true,
          data: { text: "# Example\n\nline two", value: { format: "markdown", truncated: false, totalBytes: 15 } },
        },
      };
    });
    const extract = toolByName("browser_extract");
    const result = await extract.execute("call-extract", { tabId: "tab-1" }, undefined, undefined, makeCtx());
    const operations = server.requests
      .filter((r) => r.url === "/browser/v1/request")
      .map((r) => (r.body as { operation: { kind: string } }).operation);
    expect(operations.map((op) => op.kind)).toEqual(["tabs.list", "page.extract"]);
    expect(operations[1]).toEqual({ kind: "page.extract", tabId: "tab-1", format: "markdown" });
    expect(textOf(result.content)).toContain("line two");
  });

  it("refuses browser_extract up front when the tab's profile does not advertise page.extract", async () => {
    const operations: string[] = [];
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) {
        return { json: { profiles: [profileWith(["page.snapshot", "page.evaluate"], "firefox")] } };
      }
      const body = req.body as { requestId: string; operation: { kind: string } };
      operations.push(body.operation.kind);
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [extractTab] } } };
      }
      return { json: { requestId: body.requestId, ok: true, data: { text: "reached the browser" } } };
    });
    const extract = toolByName("browser_extract");
    await expect(
      extract.execute("call-gate", { tabId: "tab-1" }, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/does not advertise page\.extract/);
    // The gate is a read-only precheck: the extraction itself is never sent.
    expect(operations).toEqual(["tabs.list"]);
  });

  it("does not block browser_extract when the profile advertises no operation list", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [profileWith(undefined)] } };
      const body = req.body as { requestId: string; operation: { kind: string } };
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [extractTab] } } };
      }
      return {
        json: {
          requestId: body.requestId,
          ok: true,
          data: { text: "extracted anyway", value: { format: "markdown", truncated: false, totalBytes: 16 } },
        },
      };
    });
    const extract = toolByName("browser_extract");
    const result = await extract.execute("call-no-list", { tabId: "tab-1" }, undefined, undefined, makeCtx());
    expect(textOf(result.content)).toContain("extracted anyway");
  });

  it("leaves an unknown tabId to the runtime instead of the capability gate", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [profileWith(["page.extract"])] } };
      const body = req.body as { requestId: string; operation: { kind: string } };
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [] } } };
      }
      return {
        json: {
          requestId: body.requestId,
          ok: false,
          error: { code: "resource-not-found", message: "tab tab-1 not found", outcome: "not-started" },
        },
      };
    });
    const extract = toolByName("browser_extract");
    await expect(
      extract.execute("call-missing-tab", { tabId: "tab-1" }, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/code=resource-not-found/);
  });

  it("reports the extract window, page metadata and the written artifact in model content", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [profileWith(["page.extract"])] } };
      const body = req.body as { requestId: string; operation: { kind: string } };
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [extractTab] } } };
      }
      return {
        json: {
          requestId: body.requestId,
          ok: true,
          data: {
            text: "# Example\n\nline two",
            value: {
              format: "markdown",
              truncated: true,
              totalBytes: 52_311,
              title: "Example article",
              metadata: { siteName: "example.com", author: "A. Writer" },
            },
            artifacts: [
              {
                path: "/tmp/ex-artifacts/example-article.md",
                mimeType: "text/markdown",
                bytes: 52_311,
                label: "Example article",
              },
            ],
          },
        },
      };
    });
    const extract = toolByName("browser_extract");
    const result = await extract.execute(
      "call-extract-artifact",
      {
        tabId: "tab-1",
        format: "markdown",
        search: "line",
        offset: 10,
        limit: 20,
        path: "/tmp/ex-artifacts/example-article.md",
      },
      undefined,
      undefined,
      makeCtx(),
    );
    const post = server.requests
      .filter((r) => r.url === "/browser/v1/request")
      .map((r) => (r.body as { operation: unknown }).operation)
      .find((operation) => (operation as { kind: string }).kind === "page.extract");
    expect(post).toEqual({
      kind: "page.extract",
      tabId: "tab-1",
      format: "markdown",
      search: "line",
      offset: 10,
      limit: 20,
      path: "/tmp/ex-artifacts/example-article.md",
    });

    const text = textOf(result.content);
    expect(text).toContain("# Example");
    expect(text).toContain("format=markdown");
    expect(text).toContain('title="Example article"');
    expect(text).toContain("site=example.com");
    expect(text).toContain("author=A. Writer");
    expect(text).toContain("52311 bytes of extracted content");
    expect(text).toContain('window search="line" offset=10 limit=20');
    expect(text).toContain("truncated=true");
    expect(text).toContain("a window of the extraction, not the whole document");
    expect(text).toContain("artifacts: /tmp/ex-artifacts/example-article.md (text/markdown, 52311 bytes)");

    const folded = renderResultText(extract, result, { expanded: false, args: { tabId: "tab-1" } });
    expect(folded).toContain("markdown · 3 line(s)");
    expect(folded).toContain("# Example");
    expect(folded).toContain('"Example article"');
    expect(folded).toContain("site=example.com");
    expect(folded).toContain("truncated");
    expect(folded).toContain("/tmp/ex-artifacts/example-article.md (52311 bytes)");
    const expanded = renderResultText(extract, result, { expanded: true, args: { tabId: "tab-1" } });
    expect(expanded).toContain("line two");
  });

  it("marks a complete extraction as not truncated", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [profileWith(["page.extract"])] } };
      const body = req.body as { requestId: string; operation: { kind: string } };
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [extractTab] } } };
      }
      return {
        json: {
          requestId: body.requestId,
          ok: true,
          data: { text: "whole document", value: { format: "text", truncated: false, totalBytes: 14 } },
        },
      };
    });
    const extract = toolByName("browser_extract");
    const result = await extract.execute(
      "call-complete",
      { tabId: "tab-1", format: "text" },
      undefined,
      undefined,
      makeCtx(),
    );
    const text = textOf(result.content);
    expect(text).toContain("format=text");
    expect(text).toContain("truncated=false");
    expect(text).not.toContain("a window of the extraction");
  });

  it("sends format assets-manifest with the requested images mode", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [profileWith(["page.extract"])] } };
      const body = req.body as { requestId: string; operation: { kind: string } };
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [extractTab] } } };
      }
      return {
        json: {
          requestId: body.requestId,
          ok: true,
          data: { value: { format: "assets-manifest", truncated: false, totalBytes: 0, assets: [] } },
        },
      };
    });
    const extract = toolByName("browser_extract");
    await extract.execute(
      "call-assets-manifest",
      { tabId: "tab-1", format: "assets-manifest", images: "urls" },
      undefined,
      undefined,
      makeCtx(),
    );
    const post = server.requests
      .filter((r) => r.url === "/browser/v1/request")
      .map((r) => (r.body as { operation: unknown }).operation)
      .find((operation) => (operation as { kind: string }).kind === "page.extract");
    expect(post).toEqual({ kind: "page.extract", tabId: "tab-1", format: "assets-manifest", images: "urls" });
  });

  it("omits the images mode on the wire when it is none", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [profileWith(["page.extract"])] } };
      const body = req.body as { requestId: string; operation: { kind: string } };
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [extractTab] } } };
      }
      return {
        json: {
          requestId: body.requestId,
          ok: true,
          data: { text: "no images", value: { format: "markdown", truncated: false, totalBytes: 10 } },
        },
      };
    });
    const extract = toolByName("browser_extract");
    await extract.execute(
      "call-images-none",
      { tabId: "tab-1", images: "none" },
      undefined,
      undefined,
      makeCtx(),
    );
    const post = server.requests
      .filter((r) => r.url === "/browser/v1/request")
      .map((r) => (r.body as { operation: unknown }).operation)
      .find((operation) => (operation as { kind: string }).kind === "page.extract");
    expect(post).toEqual({ kind: "page.extract", tabId: "tab-1", format: "markdown" });
  });

  it("refuses an images mode the Firefox profile does not advertise, before anything is downloaded", async () => {
    const operations: string[] = [];
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [firefoxProfile({ assetModes: ["urls"] })] } };
      const body = req.body as { requestId: string; operation: { kind: string } };
      operations.push(body.operation.kind);
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [extractTab] } } };
      }
      return { json: { requestId: body.requestId, ok: true, data: { text: "reached the browser" } } };
    });
    const extract = toolByName("browser_extract");
    const failure = await extract
      .execute("call-gate-save", { tabId: "tab-1", images: "save" }, undefined, undefined, makeCtx())
      .then(
        () => undefined,
        (error: Error) => error,
      );
    expect(failure?.message).toContain('does not advertise the asset mode "save"');
    // The profile is named so the model can tell which browser build to fix.
    expect(failure?.message).toContain("Default (firefox, profile-1)");
    expect(failure?.message).toContain("advertised asset modes: urls");
    // The gate is a read-only precheck: nothing is downloaded, nothing is sent.
    expect(operations).toEqual(["tabs.list"]);
  });

  it("sends the images mode to a Firefox profile that advertises it", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) {
        return { json: { profiles: [firefoxProfile({ assetModes: ["urls", "save"] })] } };
      }
      const body = req.body as { requestId: string; operation: { kind: string } };
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [extractTab] } } };
      }
      return {
        json: {
          requestId: body.requestId,
          ok: true,
          data: {
            text: "saved",
            value: { format: "markdown", truncated: false, totalBytes: 5, failedAssets: [] },
          },
        },
      };
    });
    const extract = toolByName("browser_extract");
    const result = await extract.execute(
      "call-gate-ok",
      { tabId: "tab-1", images: "save" },
      undefined,
      undefined,
      makeCtx(),
    );
    const post = server.requests
      .filter((r) => r.url === "/browser/v1/request")
      .map((r) => (r.body as { operation: unknown }).operation)
      .find((operation) => (operation as { kind: string }).kind === "page.extract");
    expect(post).toEqual({ kind: "page.extract", tabId: "tab-1", format: "markdown", images: "save" });
    // An empty failedAssets is a report, not a warning: nothing to warn about.
    expect(textOf(result.content)).not.toContain("failed assets");
  });

  it("leaves images:none ungated on a Firefox profile that advertises no features", async () => {
    const operations: string[] = [];
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [firefoxProfile({})] } };
      const body = req.body as { requestId: string; operation: { kind: string } };
      operations.push(body.operation.kind);
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [extractTab] } } };
      }
      return {
        json: {
          requestId: body.requestId,
          ok: true,
          data: { text: "extracted", value: { format: "markdown", truncated: false, totalBytes: 9 } },
        },
      };
    });
    const extract = toolByName("browser_extract");
    await extract.execute("call-none-ungated", { tabId: "tab-1" }, undefined, undefined, makeCtx());
    expect(operations).toEqual(["tabs.list", "page.extract"]);
  });

  it("leaves the images mode to the runtime when the tab's profile is not listed", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [] } };
      const body = req.body as { requestId: string; operation: { kind: string } };
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [extractTab] } } };
      }
      return {
        json: {
          requestId: body.requestId,
          ok: false,
          error: {
            code: "unsupported-capability",
            message: "images save is not supported by this backend",
            outcome: "not-started",
          },
        },
      };
    });
    const extract = toolByName("browser_extract");
    // No capabilities to judge from: the request goes out and the runtime's own
    // unsupported-capability answer is what the model sees.
    await expect(
      extract.execute("call-relay-fallback", { tabId: "tab-1", images: "save" }, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/code=unsupported-capability/);
  });

  it("reports the image manifest for format assets-manifest and for images:urls", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [profileWith(["page.extract"])] } };
      const body = req.body as { requestId: string; operation: { kind: string; format?: string } };
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [extractTab] } } };
      }
      if (body.operation.format === "assets-manifest") {
        return {
          json: {
            requestId: body.requestId,
            ok: true,
            data: {
              value: {
                format: "assets-manifest",
                truncated: false,
                totalBytes: 0,
                assetCount: 2,
                // The manifest entries carry the intrinsic size under the wire
                // names both workers emit (collectPageAssets in the Chrome
                // worker, readAssetManifest in the Firefox worker).
                assets: [
                  {
                    src: "https://example.com/a.png",
                    currentSrc: "https://example.com/a.png",
                    srcset: "",
                    alt: "Chart",
                    naturalWidth: 640,
                    naturalHeight: 480,
                  },
                  {
                    src: "https://example.com/b.png",
                    currentSrc: "",
                    srcset: "",
                    alt: "",
                    naturalWidth: 0,
                    naturalHeight: 0,
                  },
                ],
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
            text: "# Example\n\n![Chart](https://example.com/img-0.png)",
            value: {
              format: "markdown",
              truncated: false,
              totalBytes: 41,
              assetCount: 8,
              assets: Array.from({ length: 8 }, (_, i) => {
                return { src: `https://example.com/img-${i}.png`, naturalWidth: 0, naturalHeight: 0 };
              }),
            },
          },
        },
      };
    });
    const extract = toolByName("browser_extract");

    const manifest = await extract.execute(
      "call-manifest",
      { tabId: "tab-1", format: "assets-manifest" },
      undefined,
      undefined,
      makeCtx(),
    );
    const manifestText = textOf(manifest.content);
    expect(manifestText).toContain("format=assets-manifest");
    expect(manifestText).toContain(
      'assets: 2 image(s) · https://example.com/a.png alt="Chart" 640x480 · https://example.com/b.png',
    );
    // naturalWidth/naturalHeight are what the runtime sends: reading width/height
    // instead left every entry without a size. A zero pair means the image
    // reported no loaded dimensions, so no size is printed at all.
    expect(manifestText).not.toContain("0x0");
    const manifestRow = renderResultText(extract, manifest, {
      expanded: false,
      args: { tabId: "tab-1", format: "assets-manifest" },
    });
    // The manifest IS the payload here, so the row carries the listing.
    expect(manifestRow).toContain("assets-manifest · assets: 2 image(s) · https://example.com/a.png");

    const urls = await extract.execute(
      "call-urls",
      { tabId: "tab-1", images: "urls" },
      undefined,
      undefined,
      makeCtx(),
    );
    const urlsText = textOf(urls.content);
    expect(urlsText).toContain("images=urls");
    expect(urlsText).toContain("assets: 8 image(s) · https://example.com/img-0.png");
    expect(urlsText).toContain("… 3 more");
    const urlsRow = renderResultText(extract, urls, { expanded: false, args: { tabId: "tab-1", images: "urls" } });
    expect(urlsRow).toContain("markdown · 3 line(s)");
    expect(urlsRow).toContain("8 image(s)");
  });

  it("says a truncated manifest is truncated instead of presenting the listing as the whole page", async () => {
    runtimeHandler(() => ({
      text: "3 images found (listing the first ones)",
      value: {
        format: "assets-manifest",
        truncated: false,
        totalBytes: 120,
        assetCount: 3,
        assetsTruncated: true,
        assets: [
          { src: "https://example.com/img-0.png", alt: "Hero", naturalWidth: 1200, naturalHeight: 630 },
          { src: "https://example.com/img-1.png", alt: "", naturalWidth: 0, naturalHeight: 0 },
          { src: "https://example.com/img-2.png", alt: "", naturalWidth: 0, naturalHeight: 0 },
        ],
      },
    }));
    const extract = toolByName("browser_extract");
    const result = await extract.execute(
      "call-truncated-manifest",
      { tabId: "tab-1", format: "assets-manifest" },
      undefined,
      undefined,
      makeCtx(),
    );
    const text = textOf(result.content);
    expect(text).toContain(
      'assets: 3 image(s) (manifest truncated at 3 — the page has more images than this listing) · ' +
        'https://example.com/img-0.png alt="Hero" 1200x630 · https://example.com/img-1.png · https://example.com/img-2.png',
    );
    // The raw counters stay in the structured value for the model to read.
    expect(JSON.stringify(result.details.value)).toContain('"assetsTruncated":true');

    const row = renderResultText(extract, result, {
      expanded: false,
      args: { tabId: "tab-1", format: "assets-manifest" },
    });
    expect(row).toContain("manifest truncated at 3");
  });

  it("reports how many images a save run left over the per-request limit when it returns no manifest", async () => {
    // The Chrome save shape: the relay writes the bytes, drops savedAssets and
    // hands the model the counters only — no `assets` array to read.
    runtimeHandler(() => ({
      text: "# Example\n\n![Hero](/home/u/.pi-browser-use/artifacts/hero.png)",
      value: {
        format: "markdown",
        truncated: false,
        totalBytes: 60,
        assetCount: 40,
        assetsNotFetched: 20,
      },
      artifacts: [
        {
          path: "/home/u/.pi-browser-use/artifacts/hero.png",
          mimeType: "image/png",
          bytes: 1024,
          label: "Hero",
          sourceUrl: "https://example.com/img-0.png",
        },
      ],
    }));
    const extract = toolByName("browser_extract");
    const result = await extract.execute(
      "call-save-limit",
      { tabId: "tab-1", images: "save" },
      undefined,
      undefined,
      makeCtx(),
    );
    const text = textOf(result.content);
    expect(text).toContain("images=save");
    expect(text).toContain(
      "assets: 40 image(s) (20 image(s) not attempted — over the per-request save limit)",
    );
    expect(text).not.toContain("failed assets");

    const row = renderResultText(extract, result, { expanded: false, args: { tabId: "tab-1", images: "save" } });
    expect(row).toContain("40 image(s)");
  });

  it("lists saved image artifacts with their alt text and warns about failed images", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) {
        return { json: { profiles: [firefoxProfile({ assetModes: ["urls", "save"] })] } };
      }
      const body = req.body as { requestId: string; operation: { kind: string } };
      if (body.operation.kind === "tabs.list") {
        return { json: { requestId: body.requestId, ok: true, data: { tabs: [extractTab] } } };
      }
      return {
        json: {
          requestId: body.requestId,
          ok: true,
          data: {
            text: "# Example\n\n![Chart](/home/u/.pi-browser-use/artifacts/chart.png)",
            value: {
              format: "markdown",
              truncated: false,
              totalBytes: 120,
              assetCount: 1,
              assets: [
                {
                  src: "https://example.com/a.png",
                  currentSrc: "https://example.com/a.png",
                  srcset: "",
                  alt: "Chart",
                  naturalWidth: 640,
                  naturalHeight: 480,
                },
              ],
              failedAssets: [{ src: "https://example.com/broken.png", reason: "HTTP 403" }],
            },
            artifacts: [
              {
                path: "/home/u/.pi-browser-use/artifacts/chart.png",
                mimeType: "image/png",
                bytes: 2048,
                label: "Chart",
                sourceUrl: "https://example.com/a.png",
              },
            ],
          },
        },
      };
    });
    const extract = toolByName("browser_extract");
    const result = await extract.execute(
      "call-save",
      { tabId: "tab-1", images: "save" },
      undefined,
      undefined,
      makeCtx(),
    );
    const text = textOf(result.content);
    expect(text).toContain("images=save");
    expect(text).toContain('assets: 1 image(s) · https://example.com/a.png alt="Chart" 640x480');
    expect(text).toContain(
      'artifacts: /home/u/.pi-browser-use/artifacts/chart.png (image/png, 2048 bytes) "Chart"',
    );
    expect(text).toContain(
      "failed assets: 1 image(s) not saved · https://example.com/broken.png (HTTP 403) — the text keeps their original remote URLs",
    );
    expect(text).toContain("![Chart](/home/u/.pi-browser-use/artifacts/chart.png)");

    const folded = renderResultText(extract, result, { expanded: false, args: { tabId: "tab-1", images: "save" } });
    expect(folded).toContain("markdown · 3 line(s)");
    expect(folded).toContain("1 image(s)");
    expect(folded).toContain("chart.png (2048 bytes)");
    expect(folded).toContain("1 failed");

    const expanded = renderResultText(extract, result, { expanded: true, args: { tabId: "tab-1", images: "save" } });
    expect(expanded).toContain(
      'artifact: /home/u/.pi-browser-use/artifacts/chart.png (image/png, 2048 bytes) "Chart"',
    );
  });

  it("bounds the artifact descriptors printed in model content", async () => {
    runtimeHandler(() => ({
      text: "saved",
      value: { format: "markdown", truncated: false, totalBytes: 5 },
      artifacts: Array.from({ length: 12 }, (_, i) => {
        return { path: `/artifacts/img-${i}.png`, mimeType: "image/png", bytes: 100 + i, label: `image ${i}` };
      }),
    }));
    const extract = toolByName("browser_extract");
    const result = await extract.execute("call-many-artifacts", { tabId: "tab-1" }, undefined, undefined, makeCtx());
    const text = textOf(result.content);
    expect(text).toContain("/artifacts/img-9.png");
    expect(text).toContain("… 2 more");
    expect(text).not.toContain("img-10.png");
  });

  it("projects the extract and assets feature matrix into profile content and hides unrelated keys", async () => {
    runtimeHandler(() => ({
      profiles: [
        {
          ...validProfile,
          browser: "firefox",
          capabilities: {
            ...validCapabilities,
            supportedOperations: ["page.snapshot", "page.extract"],
            features: { extract: ["markdown", "text"], assets: ["urls"], unknownFeature: ["v2"] },
          },
        },
      ],
    }));
    const profiles = toolByName("browser_profiles");
    const result = await profiles.execute("call-features", {}, undefined, undefined, makeCtx());
    const content = JSON.parse(textOf(result.content)) as {
      profiles: Array<{ capabilities: Record<string, unknown> }>;
    };
    expect(content.profiles[0].capabilities.features).toEqual({
      extract: ["markdown", "text"],
      assets: ["urls"],
    });
    expect(content.profiles[0].capabilities.supportedOperations).toEqual(["page.snapshot", "page.extract"]);
  });

  it("keeps the compact profile shape when a peer advertises no features", async () => {
    runtimeHandler(() => ({ profiles: [profileWith(["page.snapshot"])] }));
    const profiles = toolByName("browser_profiles");
    const result = await profiles.execute("call-no-features", {}, undefined, undefined, makeCtx());
    const content = JSON.parse(textOf(result.content)) as {
      profiles: Array<{ capabilities: Record<string, unknown> }>;
    };
    expect(content.profiles[0].capabilities).not.toHaveProperty("features");
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
