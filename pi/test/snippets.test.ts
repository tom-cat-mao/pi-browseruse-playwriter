import { describe, expect, it } from "vitest";
import {
  clickSnippet,
  evaluateSnippet,
  fillSnippet,
  jsString,
  navigateSnippet,
  networkListSnippet,
  networkStartSnippet,
  networkStopSnippet,
  normalizeSelector,
  pdfSnippet,
  rawSnippet,
  screenshotSnippet,
  snapshotSnippet,
  tabsCloseSessionSnippet,
  tabsCloseTabSnippet,
  tabsFindSnippet,
  tabsListSnippet,
} from "../extensions/snippets.ts";

describe("normalizeSelector", () => {
  it("maps @eN to aria-ref=eN", () => {
    expect(normalizeSelector("@e12")).toBe("aria-ref=e12");
  });
  it("leaves aria-ref= and CSS selectors unchanged", () => {
    expect(normalizeSelector("aria-ref=e12")).toBe("aria-ref=e12");
    expect(normalizeSelector("button#save")).toBe("button#save");
  });
});

describe("jsString", () => {
  it("produces a valid JS literal for values with quotes and newlines", () => {
    const v = `say "hi"\nnext`;
    const lit = jsString(v);
    // eslint-disable-next-line no-eval
    expect(eval(`(${lit})`)).toBe(v);
  });
});

describe("navigateSnippet", () => {
  it("reuses the session page by default", () => {
    expect(navigateSnippet({ url: "https://example.com" })).toMatchInlineSnapshot(`
      "state.page = page;
      await state.page.goto("https://example.com", { waitUntil: 'domcontentloaded' });
      state._piOpened = state._piOpened ?? [];
      if (!state._piOpened.includes("https://example.com")) state._piOpened.push("https://example.com");
      console.log('URL:', state.page.url());
      console.log('TITLE:', await state.page.title());
      console.log('Page logs:', await getLatestLogs({ page: state.page, sinceLastCall: true }))"
    `);
  });

  it("opens a new tab when newTab is set", () => {
    expect(navigateSnippet({ url: "https://example.com", newTab: true })).toContain(
      "state.page = await context.newPage()",
    );
  });

  it("escapes quotes inside the url", () => {
    expect(navigateSnippet({ url: `https://x.test/?q="a"` })).toContain(`"https://x.test/?q=\\"a\\""`);
  });
});

describe("clickSnippet", () => {
  it("resolves aria-ref through refToLocator and clicks .first()", () => {
    expect(clickSnippet({ selector: "aria-ref=e3" })).toMatchInlineSnapshot(`
      "const __loc = (() => {
        const __ref = "e3";
        const __loc = refToLocator({ ref: __ref });
        if (!__loc) throw new Error('[pi] ref "e3" not found in the latest snapshot — call browser_snapshot first');
        return __loc;
      })();
      await state.page.locator(__loc).first().click();
      console.log('CLICKED:', "aria-ref=e3");
      console.log('URL:', state.page.url());
      console.log('Page logs:', await getLatestLogs({ page: state.page, sinceLastCall: true }))"
    `);
  });

  it("maps @eN to aria-ref resolution", () => {
    const code = clickSnippet({ selector: "@e9" });
    expect(code).toContain('const __ref = "e9";');
    expect(code).toContain("refToLocator({ ref: __ref })");
  });

  it("uses raw CSS selector for plain selectors", () => {
    expect(clickSnippet({ selector: "button#save" })).toContain('state.page.locator(__loc).first().click()');
  });
});

describe("fillSnippet", () => {
  it("fills with .fill() (clear-and-insert) and escapes the value", () => {
    const code = fillSnippet({ selector: "aria-ref=e7", value: `O'Reilly "quoted"\nline2` });
    expect(code).toContain('.fill("O\'Reilly \\"quoted\\"\\nline2")');
    // eslint-disable-next-line no-eval
    const lit = code.match(/\.fill\((\"(?:[^\"\\]|\\.)*\")\)/)?.[1] ?? "";
    expect(eval(`(${lit})`)).toBe(`O'Reilly "quoted"\nline2`);
  });
});

describe("evaluateSnippet", () => {
  it("wraps user code in an async page.evaluate and prints RESULT marker", () => {
    expect(evaluateSnippet({ code: "const x = 1; return x + 1;" })).toMatchInlineSnapshot(`
      "const __pi_result = await state.page.evaluate(async () => {
      const x = 1; return x + 1;
      });
      console.log('RESULT:' + JSON.stringify(__pi_result));"
    `);
  });

  it("exposes the DOM (document) inside page.evaluate", () => {
    const code = evaluateSnippet({ code: "return document.title" });
    expect(code).toContain("await state.page.evaluate(async () => {");
    expect(code).toContain("console.log('RESULT:' + JSON.stringify(__pi_result));");
  });
});

describe("screenshotSnippet", () => {
  it("screenshots with path/fullPage and feeds the labeled collector", () => {
    const code = screenshotSnippet({ path: "/tmp/s.png", fullPage: true });
    expect(code).toContain('page.screenshot({"path":"/tmp/s.png","fullPage":true,"scale":"css"})');
    expect(code).toContain("await screenshotWithAccessibilityLabels({ page: state.page })");
  });
});

describe("tabs snippets", () => {
  it("lists pages with TABS marker", () => {
    expect(tabsListSnippet({})).toContain("console.log('TABS:' + JSON.stringify(");
  });

  it("find by url switches state.page", () => {
    const code = tabsFindSnippet({ url: "https://example.com" });
    expect(code).toContain('p.url().startsWith("https://example.com")');
    expect(code).toContain("state.page = __target;");
  });

  it("find with active:true picks the most recent tab", () => {
    expect(tabsFindSnippet({ active: true })).toContain("__pages[__pages.length - 1]");
  });

  it("find without url/active throws", () => {
    expect(tabsFindSnippet({})).toContain("throw new Error");
  });

  it("close_tab closes the current page and resets state.page", () => {
    const code = tabsCloseTabSnippet();
    expect(code).toContain("await state.page.close();");
    expect(code).toContain("state.page = null;");
  });

  it("close_session closes only the tabs this session opened", () => {
    const code = tabsCloseSessionSnippet();
    expect(code).toContain("state._piOpened ?? []");
    expect(code).toContain("context.pages().filter((p) => __opened.some((u) => p.url().startsWith(u)))");
    expect(code).toContain("await Promise.all(__targets.map((p) => p.close()))");
  });
});

describe("network snippets", () => {
  it("start attaches a named response listener on state", () => {
    const code = networkStartSnippet();
    expect(code).toContain("state.page.on('response', state._piOnResponse)");
    expect(code).toContain("state._reqs");
  });

  it("list filters by substring when filter is given", () => {
    expect(networkListSnippet({ filter: "/api" })).toContain('r.url.includes("/api")');
    expect(networkListSnippet({})).toContain("(state._reqs ?? [])");
  });

  it("stop removes the listener and clears state", () => {
    const code = networkStopSnippet();
    expect(code).toContain("state.page.off('response', state._piOnResponse)");
    expect(code).toContain("state._reqs = [];");
  });
});

describe("pdfSnippet", () => {
  it("calls page.pdf with path/format/landscape", () => {
    const code = pdfSnippet({ path: "/tmp/a.pdf", format: "a4", landscape: true });
    expect(code).toContain('page.pdf({"path":"/tmp/a.pdf","format":"a4","landscape":true})');
  });
});

describe("misc", () => {
  it("snapshotSnippet logs the accessibility tree", () => {
    expect(snapshotSnippet()).toContain("console.log(await snapshot({ page: state.page }))");
  });

  it("rawSnippet passes code through unchanged", () => {
    expect(rawSnippet("await page.goto('x')")).toBe("await page.goto('x')");
  });
});
