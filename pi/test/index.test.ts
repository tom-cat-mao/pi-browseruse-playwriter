import { describe, expect, it, vi } from "vitest";
import factory from "../extensions/index.ts";

type RegisteredTool = {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (...args: unknown[]) => unknown;
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
    exec: vi.fn(),
  };
  return { pi, tools, commands, events };
}

describe("extension factory registration", () => {
  it("registers 9 typed tools + browser_execute escape hatch", () => {
    const { pi, tools } = makeMockPi();
    factory(pi as never);

    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "browser_navigate",
        "browser_snapshot",
        "browser_click",
        "browser_fill",
        "browser_evaluate",
        "browser_screenshot",
        "browser_tabs",
        "browser_network",
        "browser_save_as_pdf",
        "browser_execute",
      ].sort(),
    );
  });

  it("gives every tool a promptSnippet and self-naming promptGuidelines", () => {
    const { pi, tools } = makeMockPi();
    factory(pi as never);

    for (const tool of tools) {
      expect(tool.promptSnippet, tool.name).toBeTruthy();
      for (const guideline of tool.promptGuidelines ?? []) {
        expect(guideline, `${tool.name} guideline must name its tool`).toContain(tool.name);
      }
      expect(typeof tool.execute).toBe("function");
      expect(typeof tool.renderCall).toBe("function");
      expect(typeof tool.renderResult).toBe("function");
    }
  });

  it("exposes a /browser-status command and session_shutdown hook", () => {
    const { pi, commands, events } = makeMockPi();
    factory(pi as never);

    expect(commands).toContain("browser-status");
    expect(events).toContain("session_shutdown");
  });

  it("defines browser_click parameters with selector only", () => {
    const { pi, tools } = makeMockPi();
    factory(pi as never);
    const click = tools.find((t) => t.name === "browser_click")!;
    const params = click.parameters as { properties?: Record<string, unknown> };
    expect(Object.keys(params.properties ?? {})).toEqual(["selector"]);
  });
});
