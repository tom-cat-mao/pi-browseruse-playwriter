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
  "browser_profiles", "browser_groups", "browser_tabs", "browser_navigate", "browser_snapshot",
  "browser_click", "browser_fill", "browser_evaluate", "browser_screenshot", "browser_network",
  "browser_logs", "browser_execute",
];
const missing = expected.filter((n) => !tools.some((t) => t.name === n));
const forbidden = tools.filter((t) => t.name === "browser_save_as_pdf").map((t) => t.name);
if (
  missing.length > 0 ||
  forbidden.length > 0 ||
  !commands.includes("browser-status") ||
  !events.includes("session_shutdown") ||
  tools.some((t) => !t.hasExecute)
) {
  console.error(
    `MISMATCH — missing: ${missing.join(", ")}; forbidden: ${forbidden.join(", ")}; browser-status: ${commands.includes("browser-status")}; session_shutdown: ${events.includes("session_shutdown")}`,
  );
  process.exit(1);
}
console.log(`all ${expected.length} tools + /browser-status command + session_shutdown hook registered OK`);
