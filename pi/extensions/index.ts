/**
 * pi browser-use extension for the Playwriter relay.
 *
 * Drives the user's real Chrome (their login sessions) through the Playwriter
 * browser extension + relay server on 127.0.0.1:19988. State (current page,
 * network capture) lives on the relay session (`state` in the sandbox), which
 * is bound 1:1 to the pi session as `pi-<id8>`.
 *
 * Design rules (see docs/exec/A-pi-package.md):
 *   - zero runtime dependencies (fetch + node built-ins; pi packages are peers)
 *   - all tool calls serialized through a promise chain (browser state is global)
 *   - capability probe degrades silently: stock relay has no /cli/capabilities
 *   - collapsed tool rows = title + one dim line + expand hint (webbridge-style)
 */

import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import * as relay from "./relay-client.ts";
import * as bootstrap from "./bootstrap.ts";
import {
  clickSnippet,
  evaluateSnippet,
  fillSnippet,
  navigateSnippet,
  networkListSnippet,
  networkStartSnippet,
  networkStopSnippet,
  pdfSnippet,
  rawSnippet,
  screenshotSnippet,
  snapshotSnippet,
  tabsCloseSessionSnippet,
  tabsCloseTabSnippet,
  tabsFindSnippet,
  tabsListSnippet,
} from "./snippets.ts";

type Json = Record<string, unknown>;
type Theme = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"]>>[1];
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const MAX_INLINE_IMAGES = 2;
const MAX_INLINE_IMAGE_BASE64 = 16 * 1024 * 1024; // ~12MB raw

// --- rendering helpers (webbridge-style) -----------------------------------

const preview = (v: unknown, limit = 96): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > limit ? `${one.slice(0, limit)}…` : one;
};

/** First `MARKER:` line value in execute text, or null. */
function marker(text: string | undefined, m: string): string | null {
  if (!text) return null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith(`${m}:`)) return t.slice(m.length + 1);
  }
  return null;
}

const okSummary = (d: Json | undefined): string => {
  const s = JSON.stringify(d ?? {});
  return s === "{}" ? "✓ OK" : `✓ ${preview(d)}`;
};

function makeRenderCall(label: string, summarize: (args: any) => string) {
  return (args: any, theme: Theme, _context: any) => {
    const title = theme.fg("toolTitle", theme.bold(label));
    if (!_context.expanded) {
      const s = summarize(args);
      return new Text(s ? `${title}\n${theme.fg("dim", s)}` : title, 0, 0);
    }
    return new Text(`${title}\n${theme.fg("muted", JSON.stringify(args, null, 2))}`, 0, 0);
  };
}

function makeRenderResult(summarize: (details: Json) => string) {
  return (result: any, options: { expanded: boolean }, theme: Theme) => {
    const details = (result?.details ?? {}) as Json;
    if (!options.expanded) {
      return new Text(theme.fg("dim", `${summarize(details)}\n${keyHint("app.tools.expand", "to inspect output")}`), 0, 0);
    }
    return new Text(theme.fg("toolOutput", JSON.stringify(details, null, 2)), 0, 0);
  };
}

const kb = (bytes?: number) => (bytes == null ? "" : `${(bytes / 1024).toFixed(1)} KB`);

// --- extension factory -------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Browser state is global to the relay session, so serialize every call to
  // avoid races from pi's parallel tool execution.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };

  const text = (t: string): ContentBlock => ({ type: "text" as const, text: t });

  async function run(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    snippet: string,
    opts: { timeoutMs?: number; groupTitle?: string } = {},
  ): Promise<{ content: ContentBlock[]; details: Json }> {
    return serialize(async () => {
      const s = await bootstrap.ensureSession(pi, ctx, { groupTitle: opts.groupTitle });
      let result: relay.ExecuteResult;
      try {
        result = await relay.execute({
          sessionId: s.id,
          code: snippet,
          timeoutMs: opts.timeoutMs,
          signal,
        });
      } catch (e) {
        if (e instanceof relay.RelayError && e.category === "session-invalid") {
          // Session died server-side: rebuild once and retry.
          bootstrap.invalidateSession();
          const s2 = await bootstrap.ensureSession(pi, ctx);
          result = await relay.execute({ sessionId: s2.id, code: snippet, timeoutMs: opts.timeoutMs, signal });
        } else {
          throw e;
        }
      }

      const caps = bootstrap.boundCapabilities();
      const screenshots = result.screenshots.map((sc) => ({ path: sc.path, labelCount: sc.labelCount }));
      const canSee = ctx.model?.input?.includes("image") ?? false;
      const content: ContentBlock[] = [text(result.text || "(no output)")];
      if (screenshots.length > 0) {
        content.push(text(`\nscreenshots: ${screenshots.map((s) => `${s.path} (${s.labelCount} labels)`).join(", ")}`));
      }
      if (canSee && result.images.length > 0) {
        for (const img of result.images.slice(0, MAX_INLINE_IMAGES)) {
          if (img.data.length <= MAX_INLINE_IMAGE_BASE64) {
            content.push({ type: "image" as const, data: img.data, mimeType: img.mimeType });
          }
        }
      }
      const details: Json = {
        sessionId: s.id,
        sessionName: s.name,
        capabilities: caps,
        text: result.text,
        url: relay.extractUrlLine(result.text),
        screenshots,
        imagesInlined: canSee ? Math.min(result.images.length, MAX_INLINE_IMAGES) : 0,
        imageCount: result.images.length,
      };
      return { content, details };
    });
  }

  // --- tools ----------------------------------------------------------------

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description:
      "Open a URL in the user's real Chrome (with their login sessions) via the Playwriter extension. " +
      "Reuses the session's current tab by default; pass newTab to open a separate tab. Returns the final URL.",
    promptSnippet: "Open URLs in the user's real browser",
    promptGuidelines: [
      "Use browser_navigate to open pages in the user's real Chrome. On the first browser_navigate of a task pass newTab so the task gets its own tab, and group_title (in the user's language) to label the tab group when the relay supports session groups. Always verify with browser_snapshot afterwards — pages redirect unexpectedly.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to open" }),
      newTab: Type.Optional(Type.Boolean({ description: "Open in a new tab (default: reuse the session's current tab)" })),
      group_title: Type.Optional(Type.String({ description: "Human-readable label for the session's tab group; used at session creation" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return run(ctx, signal, navigateSnippet({ url: params.url, newTab: params.newTab }), {
        groupTitle: params.group_title,
      });
    },
    renderCall: makeRenderCall("browser navigate", (a) =>
      `${a.url}${a.newTab ? " (new tab)" : ""}${a.group_title ? ` · group: ${a.group_title}` : ""}`,
    ),
    renderResult: makeRenderResult((d) => `✓ ${preview(d.url ?? "")}${d.sessionId ? ` · session ${d.sessionId}` : ""}`),
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "Read the current page as an accessibility tree with element refs. Primary way to read page content and get selectors for browser_click/browser_fill.",
    promptSnippet: "Read current page content as an accessibility tree",
    promptGuidelines: [
      "Use browser_snapshot to read page content and obtain element refs; prefer refs from the snapshot over hand-written CSS selectors with browser_click/browser_fill.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      return run(ctx, signal, snapshotSnippet());
    },
    renderCall: makeRenderCall("browser snapshot", () => ""),
    renderResult: makeRenderResult((d) => `✓ snapshot · ${(d.text as string)?.split("\n").length ?? 0} lines`),
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description:
      "Click an element on the current page by snapshot ref (aria-ref=eN or @eN) or CSS selector. " +
      "Uses .first() to tolerate duplicate matches.",
    promptSnippet: "Click an element by ref or CSS selector",
    promptGuidelines: [
      "Use browser_click with a ref from the most recent browser_snapshot (aria-ref=eN); refs are only valid against the latest snapshot, take a fresh one if the page changed.",
    ],
    parameters: Type.Object({
      selector: Type.String({ description: "aria-ref=eN, @eN or CSS selector" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return run(ctx, signal, clickSnippet({ selector: params.selector }));
    },
    renderCall: makeRenderCall("browser click", (a) => a.selector ?? ""),
    renderResult: makeRenderResult((d) => `✓ clicked · ${preview(d.url ?? "")}`),
  });

  pi.registerTool({
    name: "browser_fill",
    label: "Browser Fill",
    description:
      "Set text into an input/textarea/contenteditable on the current page by snapshot ref or CSS selector. " +
      "Clear-and-insert: existing content is replaced.",
    promptSnippet: "Fill inputs and rich text editors",
    promptGuidelines: [
      "Use browser_fill to type into inputs; it is clear-and-insert (existing content replaced). To append, read the current value with browser_evaluate, concatenate, then browser_fill.",
    ],
    parameters: Type.Object({
      selector: Type.String({ description: "aria-ref=eN, @eN or CSS selector" }),
      value: Type.String({ description: "Text to insert (replaces existing content)" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return run(ctx, signal, fillSnippet({ selector: params.selector, value: params.value }));
    },
    renderCall: makeRenderCall("browser fill", (a) => `${a.selector ?? ""} ← "${preview(a.value, 48)}"`),
    renderResult: makeRenderResult((d) => `✓ filled · ${preview(d.url ?? "")}`),
  });

  pi.registerTool({
    name: "browser_evaluate",
    label: "Browser Evaluate",
    description:
      "Run JavaScript inside the current page (DOM available, async/await supported). Wrapped in page.evaluate so const/let stay scoped. Returns the JSON-serializable result (RESULT: line). Sandbox scope (state/context) is not visible here — use browser_execute for that.",
    promptSnippet: "Run JavaScript in the current page",
    promptGuidelines: [
      "Use browser_evaluate only when browser_snapshot lacks the target or you need attributes/scrolling/complex events; prefer browser_snapshot for reading page state. browser_evaluate runs in the page (document/window available); end your code with `return <value>` — a bare expression like `document.title` returns undefined. Multi-statement code stays scoped in an async arrow. Results are compact JSON (RESULT: line). Use browser_execute when you need sandbox helpers (state/context/require).",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "JS code, async/await supported" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return run(ctx, signal, evaluateSnippet({ code: params.code }));
    },
    renderCall: makeRenderCall("browser evaluate", (a) => preview(a.code, 96)),
    renderResult: makeRenderResult((d) => {
      const res = marker(d.text as string | undefined, "RESULT");
      return res != null ? `✓ → ${preview(res, 96)}` : okSummary(d);
    }),
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Screenshot the current page. Returns a labeled image inline (when the model can see images) plus the saved file path and an aria snapshot.",
    promptSnippet: "Screenshot the current page",
    promptGuidelines: [
      "Use browser_screenshot when you need visual/spatial state; browser_snapshot is cheaper for reading text. Pass an absolute path to save the file (allowed dirs: relay session cwd, /tmp).",
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Absolute output path (allowed: session cwd, /tmp)" })),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return run(ctx, signal, screenshotSnippet({ path: params.path, fullPage: params.fullPage }));
    },
    renderCall: makeRenderCall("browser screenshot", (a) => [a.path ? `→ ${a.path}` : "", a.fullPage ? "full page" : ""].filter(Boolean).join(" · ")),
    renderResult: makeRenderResult((d) => {
      const shot = Array.isArray(d.screenshots) ? (d.screenshots[0] as { path?: string; labelCount?: number } | undefined) : undefined;
      return shot ? `✓ ${shot.path ?? "screenshot"} (${shot.labelCount ?? 0} labels)` : `✓ ${(d.imageCount ?? 0)} image(s)`;
    }),
  });

  pi.registerTool({
    name: "browser_tabs",
    label: "Browser Tabs",
    description:
      "Manage tabs of the relay session: list tabs, find (switch the session's current page to a tab by url or the most recent one), close current tab, close the session's opened tabs.",
    promptSnippet: "List/find/close browser tabs",
    promptGuidelines: [
      "Use browser_tabs list to enumerate the session's tabs, then find with the full url to switch back. Only use close_session when the user explicitly asks to close the tabs (it closes exactly the tabs this session opened, never other sessions' or the user's tabs).",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "find", "close_tab", "close_session"] as const),
      url: Type.Optional(Type.String({ description: "For find: full or prefix URL of the tab (from list or navigate result)" })),
      active: Type.Optional(Type.Boolean({ description: "For find without url: switch to the most recently attached tab" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.action === "close_session") {
        // NOTE: do not re-wrap in serialize() here — run() already serializes;
        // nesting would deadlock the promise queue.
        return (async () => {
          const s = await bootstrap.ensureSession(pi, ctx);
          const caps = bootstrap.boundCapabilities();
          if (caps?.closeTabs) {
            const ok = await relay.closeSessionTabs(s.id);
            if (ok) {
              return { content: [text("✓ session tabs closed")], details: { sessionId: s.id, closed: "all tabs" } };
            }
          }
          // Degraded path: close every page from inside the sandbox.
          return run(ctx, signal, tabsCloseSessionSnippet());
        })();
      }
      if (params.action === "list") {
        return run(ctx, signal, tabsListSnippet({}));
      }
      if (params.action === "close_tab") {
        return run(ctx, signal, tabsCloseTabSnippet());
      }
      return run(ctx, signal, tabsFindSnippet({ url: params.url, active: params.active }));
    },
    renderCall: makeRenderCall("browser tabs", (a) =>
      `${a.action}${a.url ? ` ${preview(a.url, 64)}` : ""}${a.active ? " (most recent tab)" : ""}`,
    ),
    renderResult: makeRenderResult((d) => {
      const t = marker(d.text as string | undefined, "TABS");
      if (t != null) {
        try {
          const arr = JSON.parse(t);
          return `✓ ${arr.length} tab(s)`;
        } catch {
          return `✓ ${preview(t, 48)}`;
        }
      }
      for (const m of ["SWITCHED", "CLOSED", "CLOSED_SESSION"]) {
        const v = marker(d.text as string | undefined, m);
        if (v != null) return `✓ ${m.toLowerCase()}: ${preview(v, 64)}`;
      }
      if (d.closed) return `✓ closed ${d.closed} tab(s)`;
      return okSummary(d);
    }),
  });

  pi.registerTool({
    name: "browser_network",
    label: "Browser Network",
    description:
      "Capture network responses of the session's current page: start/stop capture, list requests with an optional url substring filter. Captured data persists across calls in session state.",
    promptSnippet: "Capture and inspect page network requests",
    promptGuidelines: [
      "Use browser_network start before the action that triggers requests, then list to inspect API calls of the current page.",
    ],
    parameters: Type.Object({
      cmd: StringEnum(["start", "list", "stop"] as const),
      filter: Type.Optional(Type.String({ description: "URL substring filter for list" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.cmd === "start") return run(ctx, signal, networkStartSnippet());
      if (params.cmd === "stop") return run(ctx, signal, networkStopSnippet());
      return run(ctx, signal, networkListSnippet({ filter: params.filter }));
    },
    renderCall: makeRenderCall("browser network", (a) =>
      `${a.cmd}${a.filter ? ` filter:${a.filter}` : ""}`,
    ),
    renderResult: makeRenderResult((d) => {
      const net = marker(d.text as string | undefined, "NET");
      if (net != null) {
        try {
          const arr = JSON.parse(net) as unknown[];
          return `✓ ${arr.length} request(s)`;
        } catch {
          return `✓ ${preview(net, 64)}`;
        }
      }
      if (marker(d.text as string | undefined, "NET_START")) return "✓ capture started";
      if (marker(d.text as string | undefined, "NET_STOP")) return "✓ capture stopped";
      return okSummary(d);
    }),
  });

  pi.registerTool({
    name: "browser_save_as_pdf",
    label: "Browser Save as PDF",
    description:
      "Render the current page to PDF via Playwright page.pdf. Note: page.pdf only works in headless Chromium; on a headed extension session it errors — prefer browser_screenshot in that case.",
    promptSnippet: "Save current page as PDF",
    promptGuidelines: [
      "Use browser_save_as_pdf only for headless/direct-CDP sessions; in extension mode (headed Chrome) page.pdf is unsupported and will error.",
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Absolute output path (allowed: session cwd, /tmp)" })),
      format: Type.Optional(StringEnum(["letter", "a4", "legal", "a3", "tabloid"] as const)),
      landscape: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return run(ctx, signal, pdfSnippet({ path: params.path, format: params.format, landscape: params.landscape }));
    },
    renderCall: makeRenderCall("browser save as PDF", (a) => a.path ?? a.format ?? ""),
    renderResult: makeRenderResult((d) => `✓ PDF → ${preview(marker(d.text as string | undefined, "PDF_PATH") ?? "saved", 64)}`),
  });

  pi.registerTool({
    name: "browser_execute",
    label: "Browser Execute",
    description:
      "Escape hatch: run an arbitrary Playwright code snippet in the relay session's sandbox. Scope has page, context, state (persistent), snapshot, getLatestLogs, refToLocator. Errors and console output are returned verbatim.",
    promptSnippet: "Run an arbitrary Playwright snippet (escape hatch)",
    promptGuidelines: [
      "Use browser_execute when the typed tools are insufficient (custom waits, iframes, multi-step flows). The sandbox keeps `state` across calls; console.log output is returned. Never call browser.close()/context.close(); close tabs via browser_tabs.",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "Playwright JS code, async/await supported" }),
      timeout: Type.Optional(Type.Integer({ minimum: 1000, description: "Timeout in ms (default 120000)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return run(ctx, signal, rawSnippet(params.code), { timeoutMs: params.timeout });
    },
    renderCall: makeRenderCall("browser execute", (a) => preview(a.code, 96)),
    renderResult: makeRenderResult((d) => `✓ ${preview((d.text as string)?.split("\n")[0] ?? "ok", 96)}`),
  });

  // --- command ----------------------------------------------------------------

  pi.registerCommand("browser-status", {
    description: "Show Playwriter relay status, extension connection and the bound session",
    handler: async (_args, ctx) => {
      try {
        const url = relay.baseUrl();
        const version = await relay.getVersion(url);
        const status = await relay.getExtensionStatus(url);
        const s = await bootstrap.ensureSession(pi, ctx).catch(() => null);
        const caps = bootstrap.boundCapabilities();
        const lines = [
          `relay: ${version ?? "not reachable"} (${url})`,
          `browser extension: ${status?.connected ? `connected (${status.browser ?? "Chrome"})` : "NOT connected — open Chrome and click the Playwriter extension icon"}`,
          `session: ${s ? `${s.id} (${s.name})` : "not bound yet"}`,
          `capabilities: ${caps ? `groups=${caps.sessionGroups} consent=${caps.consent} audit=${caps.audit} closeTabs=${caps.closeTabs}` : "unknown"}`,
        ];
        ctx.ui.notify(lines.join("\n"), status?.connected ? "info" : "warning");
      } catch (e) {
        ctx.ui.notify(`browser-status unavailable: ${String(e)}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await bootstrap.closeSession();
  });
}
