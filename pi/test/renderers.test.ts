/**
 * Renderer tests: these invoke the real renderCall/renderResult renderers and
 * render the returned components, asserting what a human actually sees — not
 * merely that the functions exist.
 *
 * The extension factory gets a mocked ExtensionAPI and talks to a real local
 * HTTP server (no mocked fetch), like index.test.ts. No Chrome and no real
 * runtime are started.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import factory from "../extensions/index.ts";
import * as bootstrap from "../extensions/bootstrap.ts";
import { startTestServer, validCapabilities, validProfile, type TestServer } from "./test-server.ts";

type Json = Record<string, unknown>;
type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Rendered = { render(width: number): string[] };
type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Json,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: ContentBlock[]; details: Json }>;
  renderCall?: (args: Json, theme: unknown, context: { expanded: boolean }) => Rendered;
  renderResult?: (result: unknown, options: { expanded: boolean }, theme: unknown, context: unknown) => Rendered;
};

// A theme that leaves text unchanged so assertions read the real content.
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function registerTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
    registerCommand: () => {},
    on: () => {},
  };
  factory(pi as never);
  return tools;
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

const renderComponent = (component: Rendered, width = 220): string => component.render(width).join("\n");

function renderResultText(
  tool: RegisteredTool,
  result: { content: ContentBlock[]; details: Json },
  options: { expanded: boolean; isError?: boolean; args?: Json },
): string {
  const component = tool.renderResult!(
    result,
    { expanded: options.expanded },
    theme,
    { isError: options.isError === true, args: options.args ?? {} },
  );
  return renderComponent(component);
}

describe("human-facing renderers", () => {
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

  function runtimeHandler(dataFor: (op: { kind: string; action?: string }) => Json) {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [validProfile] } };
      const body = req.body as { requestId: string; operation: { kind: string; action?: string } };
      return { json: { requestId: body.requestId, ok: true, data: dataFor(body.operation) } };
    });
  }

  it("renders a compact call line with the action and a short id, and bounds expanded args", () => {
    const tools = registerTools();
    const nav = tools.get("browser_navigate")!;
    const folded = renderComponent(
      nav.renderCall!({ tabId: "ptab-mtwn3svh-5illhh1cdkl18", action: "back" }, theme, { expanded: false }),
    );
    expect(folded).toContain("back");
    expect(folded).not.toContain("ptab-mtwn3svh-5illhh1cdkl18");
    const expanded = renderComponent(
      nav.renderCall!(
        { tabId: "tab-1", action: "goto", url: `https://example.com/${"x".repeat(20_000)}` },
        theme,
        { expanded: true },
      ),
    );
    expect(Buffer.byteLength(expanded, "utf8")).toBeLessThan(6_000);
  });

  it("strips real ANSI/control sequences before shortening and keeps opaque ids intact", async () => {
    runtimeHandler(() => ({
      text: `- button "Save" [aria-ref=e5]\n\u001b[31mred\u001b[0m warning \u001b]0;injected title\u0007 tail\nliteral \\u001b stays text`,
      snapshotId: "managed:ptab-mtwn3svh-5illhh1cdkl18:2:3:uuid",
    }));
    const tools = registerTools();
    const snapshot = tools.get("browser_snapshot")!;
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
    // A literal backslash-u sequence is plain text, not a control sequence.
    expect(expanded).toContain("literal \\u001b stays text");
    // The full opaque id stays available in expanded detail.
    expect(expanded).toContain("managed:ptab-mtwn3svh-5illhh1cdkl18:2:3:uuid");
    const folded = renderResultText(snapshot, result, { expanded: false });
    expect(folded).not.toContain("\u001b");
    // Folded uses a short id tail for the snapshot, never a "corrupted id" claim.
    expect(folded).toMatch(/…/);
  });

  it("shows the complete bounded multiline error with outcome when expanded and an affordance when collapsed", () => {
    const tools = registerTools();
    const nav = tools.get("browser_navigate")!;
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

    // A runaway error is still bounded when expanded, with the first line kept.
    const huge = { content: [{ type: "text" as const, text: `head line\n${"E".repeat(300_000)}` }], details: {} };
    const hugeExpanded = renderResultText(nav, huge, { expanded: true, isError: true });
    expect(Buffer.byteLength(hugeExpanded, "utf8")).toBeLessThan(20_000);
    expect(hugeExpanded).toContain("head line");
  });

  it("bounds expanded success detail instead of dumping unlimited raw details", async () => {
    runtimeHandler(() => ({ text: "X".repeat(500_000), snapshotId: "snap-bounded" }));
    const tools = registerTools();
    const snapshot = tools.get("browser_snapshot")!;
    const result = await snapshot.execute("call-big", { tabId: "tab-1" }, undefined, undefined, makeCtx());
    const expanded = renderResultText(snapshot, result, { expanded: true });
    expect(Buffer.byteLength(expanded, "utf8")).toBeLessThan(20_000);
    expect(expanded).toContain("snap-bounded");
  });

  it("shows browser_execute value and logs instead of a bare ok", async () => {
    runtimeHandler(() => ({ value: { rows: 3 }, logs: ["[log] one", "[error] boom"] }));
    const tools = registerTools();
    const execute = tools.get("browser_execute")!;
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

  it("shows network stop retained count/state and keeps the list value a bare array", async () => {
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      if (req.url.endsWith("/profiles")) return { json: { profiles: [validProfile] } };
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
          data: { value: [{ url: "https://a.example" }, { url: "https://b.example" }] },
        },
      };
    });
    const tools = registerTools();
    const network = tools.get("browser_network")!;
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
    const stopText = textOf(stopped.content);
    expect(stopText).toContain("network capture: status=stopped");
    expect(stopText).toContain("\"networkCapture\"");
    expect(stopped.details.networkCapture).toMatchObject({ status: "stopped", retainedCount: 7, droppedCount: 2 });

    const listed = await network.execute(
      "call-list",
      { tabId: "tab-1", action: "list" },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(Array.isArray(listed.details.value)).toBe(true);
    expect(textOf(listed.content)).toContain("\"value\":[");
    const listFolded = renderResultText(network, listed, { expanded: false, args: { action: "list" } });
    expect(listFolded).toContain("2 request(s)");

    // Legacy runtime (no metadata): the stop value object still yields the
    // retained count and a stopped state instead of a bare "ok".
    server.setHandler((req) => {
      if (req.url.endsWith("/capabilities")) return { json: validCapabilities };
      const body = req.body as { requestId: string };
      return {
        json: {
          requestId: body.requestId,
          ok: true,
          data: { value: { captureId: "cap-legacy", entries: [{ url: "https://a.example" }, { url: "https://b.example" }, { url: "https://c.example" }] } },
        },
      };
    });
    const legacyStop = await network.execute(
      "call-stop-legacy",
      { tabId: "tab-1", action: "stop" },
      undefined,
      undefined,
      makeCtx(),
    );
    const legacyFolded = renderResultText(network, legacyStop, { expanded: false, args: { action: "stop" } });
    expect(legacyFolded).toContain("stopped");
    expect(legacyFolded).toContain("3 retained");
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
    const tools = registerTools();
    const tabs = tools.get("browser_tabs")!;
    const click = tools.get("browser_click")!;
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

  it("uses the frozen data.pageInfo observation for later rows without extra browser calls", async () => {
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
    const tools = registerTools();
    const snapshot = tools.get("browser_snapshot")!;
    const click = tools.get("browser_click")!;
    const snap = await snapshot.execute("call-snap", { tabId: "tab-pi" }, undefined, undefined, makeCtx("session-pi"));
    expect(renderResultText(snapshot, snap, { expanded: false, args: { tabId: "tab-pi" } })).toContain(
      "Latest news",
    );
    // The click result carries no page facts; the row still shows the observed
    // page from the session cache, and no extra request was made for it.
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

  it("shows the back action instead of an empty URL", async () => {
    runtimeHandler(() => ({ text: "Went back to https://example.com/list" }));
    const tools = registerTools();
    const nav = tools.get("browser_navigate")!;
    const result = await nav.execute(
      "call-back",
      { tabId: "tab-7", action: "back" },
      undefined,
      undefined,
      makeCtx(),
    );
    const folded = renderResultText(nav, result, { expanded: false, args: { tabId: "tab-7", action: "back" } });
    expect(folded).toContain("✓ back");
  });

  it("keeps the screenshot image block and shows the saved path", async () => {
    runtimeHandler(() => ({
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
      artifacts: [{ path: "/tmp/shot.png", mimeType: "image/png" }],
    }));
    const tools = registerTools();
    const screenshot = tools.get("browser_screenshot")!;
    const ctx = { ...makeCtx(), model: { input: ["text", "image"] } };
    const result = await screenshot.execute(
      "call-shot",
      { tabId: "tab-1", path: "/tmp/shot.png" },
      undefined,
      undefined,
      ctx,
    );
    // The framework renders images from content; the custom row must not
    // replace that path, only summarize it.
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
    const tools = registerTools();
    const tabs = tools.get("browser_tabs")!;
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
