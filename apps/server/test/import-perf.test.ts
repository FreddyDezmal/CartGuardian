import { describe, expect, it } from "vitest";
import { extractProduct } from "../src/import/extract.js";
import { cleanText } from "../src/import/html.js";

/**
 * Pages come from arbitrary websites, so a hostile page must not freeze the
 * server. Each case is ~2 MB (the fetch cap) and built to defeat backtracking parsers.
 */
describe("extraction stays fast on hostile pages", () => {
  const cases: Record<string, string> = {
    "unclosed quotes": ('<meta content="' + "a".repeat(200)).repeat(10_000),
    "many attribute-only tags": '<div itemprop="x" content="y">'.repeat(60_000),
    "unclosed JSON-LD script": '<script type="application/ld+json">' + "{".repeat(2_000_000),
    "endless '<a '": "<a ".repeat(600_000),
    "unclosed comments": "<!--".repeat(500_000),
    "deep JSON-LD nesting": '<script type="application/ld+json">' + "[".repeat(5_000) + "]".repeat(5_000) + "</script>",
    "JSON-LD description of 1M '<'": `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "x", description: "<".repeat(1_000_000) })}</script>`,
    "many entities": "<title>" + "&amp;".repeat(400_000) + "</title>",
    "ordinary large page": ("<p>" + "word ".repeat(40) + "</p>\n").repeat(9_000),
  };
  for (const [name, html] of Object.entries(cases)) {
    it(`${name} (${(html.length / 1e6).toFixed(1)} MB)`, () => {
      const t = Date.now();
      extractProduct(html, new URL("https://shop.example/"));
      expect(Date.now() - t).toBeLessThan(1500);
    });
  }
});

describe("text cleaning stays linear", () => {
  // Once took ~150 ms per call (quadratic tag stripping), which pushed the
  // 1M '<' page past the limit above on a busy laptop. Linear now: ~1 ms.
  it.each([
    ["all '<'", "<".repeat(1_000_000)],
    ["'<' then letters, no '>'", "<" + "a".repeat(1_000_000)],
    ["'<a ' repeated", "<a ".repeat(300_000)],
  ])("%s", (_name, text) => {
    const t = Date.now();
    cleanText(text);
    expect(Date.now() - t).toBeLessThan(100);
  });

  it("still strips tags and keeps a lone '<'", () => {
    expect(cleanText("Fast <b>boil</b> &lt; 3 min, 2 < 3")).toBe("Fast boil < 3 min, 2 < 3");
  });
});
