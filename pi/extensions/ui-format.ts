/**
 * Presentation helpers for the human-facing tool rows.
 *
 * Tool `content` is model-facing and must stay stable; everything here only
 * shapes what the TUI shows. Two rules matter:
 *
 *   - real terminal control sequences (CSI/SGR/OSC plus remaining C0/C1
 *     controls) are stripped BEFORE any shortening, so a page title or error
 *     containing raw ESC bytes can never corrupt the row or move the terminal
 *     cursor. Literal text such as `\u001b` (six characters) is not a control
 *     sequence and is preserved;
 *   - shortening is Unicode/wide-character safe (pi-tui's grapheme-aware
 *     truncation) so Chinese text and emoji are never split.
 *
 * Sanitizing display copies never damages opaque ids: `ptab-…` style ids only
 * lose real control bytes, and the full id always stays in model-visible
 * content and expanded detail.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const utf8 = new TextEncoder();

/** UTF-8 byte length — the budget unit for every cap in this package. */
export function byteLen(s: string): number {
  return utf8.encode(s).length;
}

/**
 * Slice a string down to at most `maxBytes` UTF-8 bytes on a code-point
 * boundary. Binary-searches by UTF-16 code unit, then drops a trailing lone
 * high surrogate so an astral char (emoji) is never split into a replacement
 * character. The result is always valid UTF-8 and within budget.
 */
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
  // If we cut right after a high surrogate, its low half is on the far side of
  // the boundary — drop the orphan so we never emit U+FFFD.
  if (lo > 0) {
    const last = s.charCodeAt(lo - 1);
    if (last >= 0xd800 && last <= 0xdbff) lo -= 1;
  }
  return s.slice(0, lo);
}

/** Clamp a free-form string to a byte budget, marking the cut with an ellipsis. */
export function clampBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLen(s) <= maxBytes) return s;
  const marker = "…";
  const markerBytes = byteLen(marker);
  if (maxBytes <= markerBytes) return sliceToBytes(s, maxBytes);
  return `${sliceToBytes(s, maxBytes - markerBytes)}${marker}`;
}

// OSC (ESC ] or C1 0x9d) up to BEL / ST, CSI (ESC [ or C1 0x9b), other escape
// sequences, then any remaining C0/C1 controls including DEL. `\n` and `\t` are
// not in the stripped ranges, so multiline error text survives.
const OSC_SEQUENCE = /(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g;
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const SINGLE_ESC_SEQUENCE = /\u001b[@-Z\\-_]/g;
const OTHER_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Remove real terminal control sequences. Newlines are normalized to `\n`;
 * every other control code is dropped. Unicode text is untouched.
 */
export function stripTerminalControls(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(SINGLE_ESC_SEQUENCE, "")
    .replace(OTHER_CONTROLS, "");
}

/** Shorten to a visible-column budget, Unicode/wide-char safe. */
export function clipToColumns(value: string, maxCols: number, ellipsis = "…"): string {
  if (maxCols <= 0) return "";
  if (visibleWidth(value) <= maxCols) return value;
  return truncateToWidth(value, maxCols, ellipsis);
}

/**
 * One-line, control-free preview of any value. Strips first, collapses
 * whitespace second, shortens last — never the other way around.
 */
export function preview(value: unknown, limit = 96): string {
  const raw = typeof value === "string" ? value : safeStringify(value);
  const one = stripTerminalControls(raw).replace(/\s+/g, " ").trim();
  return clipToColumns(one, limit);
}

/**
 * Display fallback for an opaque id when no human-friendly page context is
 * known: keep the tail (unique part) with a leading ellipsis. Returns the id
 * unchanged when it is already short. This is a display copy only.
 */
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

/**
 * Human label for an observed page: `title — host`, falling back to whichever
 * half is available. Never emits control sequences.
 */
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
