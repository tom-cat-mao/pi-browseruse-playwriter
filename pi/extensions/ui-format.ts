/**
 * Presentation helpers for human-facing tool rows. Display copies only:
 * real terminal control sequences are stripped BEFORE any shortening and
 * string leaves are sanitized BEFORE serialization, so raw ESC bytes can never
 * reach the terminal (directly or as `\u001b` JSON junk). Literal backslash-u
 * text is not a control sequence and is preserved. Shortening is Unicode and
 * wide-character safe via pi-tui.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const utf8 = new TextEncoder();

/** UTF-8 byte length — the budget unit for every cap in this package. */
export function byteLen(s: string): number {
  return utf8.encode(s).length;
}

/** Slice to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function sliceToBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLen(s) <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLen(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0) {
    const last = s.charCodeAt(lo - 1);
    if (last >= 0xd800 && last <= 0xdbff) lo -= 1;
  }
  return s.slice(0, lo);
}

/** Clamp a string to a byte budget, marking the cut with an ellipsis. */
export function clampBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLen(s) <= maxBytes) return s;
  const marker = "…";
  const markerBytes = byteLen(marker);
  if (maxBytes <= markerBytes) return sliceToBytes(s, maxBytes);
  return `${sliceToBytes(s, maxBytes - markerBytes)}${marker}`;
}

// OSC (ESC ] or C1 0x9d), CSI (ESC [ or C1 0x9b), other escapes, then remaining
// C0/C1 controls including DEL. `\n` and `\t` survive for multiline text.
const OSC_SEQUENCE = /(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g;
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const SINGLE_ESC_SEQUENCE = /\u001b[@-Z\\-_]/g;
const OTHER_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Remove real terminal control sequences; newlines are normalized. */
export function stripTerminalControls(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(SINGLE_ESC_SEQUENCE, "")
    .replace(OTHER_CONTROLS, "");
}

const MAX_SANITIZE_DEPTH = 6;
const MAX_SANITIZE_ITEMS = 100;

/**
 * Recursively strip terminal controls from the string leaves of a display
 * copy, BEFORE serialization: otherwise JSON.stringify would turn a raw ESC
 * into visible `\u001b` junk. Literal backslash-u text is untouched.
 */
export function sanitizeValue(value: unknown): unknown {
  const walk = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return stripTerminalControls(item);
    if (Array.isArray(item)) {
      if (depth >= MAX_SANITIZE_DEPTH) return [];
      return item.slice(0, MAX_SANITIZE_ITEMS).map((entry) => walk(entry, depth + 1));
    }
    if (typeof item === "object" && item !== null) {
      if (depth >= MAX_SANITIZE_DEPTH) return {};
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item).slice(0, MAX_SANITIZE_ITEMS)) {
        out[key] = walk(entry, depth + 1);
      }
      return out;
    }
    return item;
  };
  return walk(value, 0);
}

/** Shorten to a visible-column budget, Unicode/wide-char safe. */
function clipToColumns(value: string, maxCols: number, ellipsis = "…"): string {
  if (maxCols <= 0) return "";
  if (visibleWidth(value) <= maxCols) return value;
  return truncateToWidth(value, maxCols, ellipsis);
}

/** One-line, control-free preview of any value (leaves sanitized first). */
export function preview(value: unknown, limit = 96): string {
  const raw =
    typeof value === "string" ? value : (JSON.stringify(sanitizeValue(value)) ?? String(value));
  const one = stripTerminalControls(raw).replace(/\s+/g, " ").trim();
  return clipToColumns(one, limit);
}

/** Display fallback for an opaque id: keep the unique tail. */
export function shortId(id: unknown, tail = 12): string {
  if (typeof id !== "string") return "";
  const clean = stripTerminalControls(id).trim();
  if (clean.length <= tail + 4) return clean;
  return `…${clean.slice(-tail)}`;
}

/** Host of a URL, or "" when it cannot be parsed. */
export function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(stripTerminalControls(url)).host;
  } catch {
    return "";
  }
}

/** Human label for an observed page: `title — host`. */
export function pageLabel(page: { url?: string; title?: string } | undefined | null): string {
  if (!page) return "";
  const title = page.title ? preview(page.title, 64) : "";
  const host = hostOf(page.url);
  if (title && host) return `${title} — ${host}`;
  if (title) return title;
  if (host) return host;
  return page.url ? preview(page.url, 64) : "";
}

/** JSON.stringify that never throws on odd values. */
export function safeStringify(value: unknown): string {
  try {
    const out = JSON.stringify(value);
    return out === undefined ? String(value) : out;
  } catch {
    try {
      return String(value);
    } catch {
      return "";
    }
  }
}
