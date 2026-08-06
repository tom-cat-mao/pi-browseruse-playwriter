/**
 * Acceptance check #2 — "jiti 模拟加载":
 * load pi/extensions/index.ts through jiti, call the factory with a mocked
 * ExtensionAPI, and print the registered tools/commands. Run with:
 *
 *   node --experimental-strip-types node_modules/.bin/jiti ...  (see README)
 *   jiti ./test/load-check.ts  (with jiti in PATH)
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

const mod = (await jiti.import("../extensions/index.ts", { default: true })) as {
  default?: (pi: unknown) => void;
};
const factory: (pi: unknown) => void = typeof mod === "function" ? mod : (mod.default as (pi: unknown) => void);

const tools: Array<{ name: string; hasExecute: boolean; hasRenderCall: boolean; hasRenderResult: boolean }> = [];
const commands: string[] = [];
const events: string[] = [];

const mockPi = {
  registerTool: (tool: { name: string; execute: unknown; renderCall?: unknown; renderResult?: unknown }) => {
    tools.push({
      name: tool.name,
      hasExecute: typeof tool.execute === "function",
      hasRenderCall: typeof tool.renderCall === "function",
      hasRenderResult: typeof tool.renderResult === "function",
    });
  },
  registerCommand: (name: string) => {
    commands.push(name);
  },
  on: (event: string) => {
    events.push(event);
  },
  exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
};

factory(mockPi);

console.log(`jiti load OK — factory invoked with mocked ExtensionAPI`);
console.log(`tools (${tools.length}):`);
for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`  - ${t.name}${t.hasExecute ? " (execute)" : ""}${t.hasRenderCall ? " (renderCall)" : ""}${t.hasRenderResult ? " (renderResult)" : ""}`);
}
console.log(`commands (${commands.length}): ${commands.join(", ")}`);
console.log(`events: ${events.join(", ")}`);

const expected = [
  "browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_evaluate",
  "browser_screenshot", "browser_tabs", "browser_network", "browser_save_as_pdf", "browser_execute",
];
const missing = expected.filter((n) => !tools.some((t) => t.name === n));
if (missing.length > 0 || !commands.includes("browser-status") || tools.some((t) => !t.hasExecute)) {
  console.error(`MISMATCH — missing: ${missing.join(", ")}; browser-status: ${commands.includes("browser-status")}`);
  process.exit(1);
}
console.log("all 10 tools + /browser-status command registered OK");
