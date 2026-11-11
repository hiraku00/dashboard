import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import { KNOWN_CLASSES, lintArticle } from "../app/lib/text-tube-article-lint.ts";

// The test article from the article-prompt v3 hand-off: steps, four speakers,
// key insight, summary. It is well-formed, so it must give no warnings.
const article = readFileSync(new URL("./fixtures/text-tube-parts-article.md", import.meta.url), "utf8");
const codes = (md) => lintArticle(md).map((i) => i.code);

// Every class the article prompt's spec can output (76, from the Claude-side
// hand-off). The lint list is built from this, not from the CSS, because some
// of these have no CSS rule (compare-body, ba-text, ...).
const SPEC_CLASSES = [
  "after", "article-lead", "article-meta", "article-table", "article-toc", "article-toc-title",
  "ba-arrow", "ba-card", "ba-label", "ba-text", "before", "blue", "bubble", "bubble-avatar",
  "bubble-content", "bubble-group", "bubble-name", "bubble-row", "chapter-head",
  "chapter-head-actions", "chapter-no", "compare-body", "compare-grid", "compare-item",
  "compare-label", "figure-arrow", "figure-box", "figure-box-title", "figure-card", "figure-vs",
  "green", "highlight", "highlight-green", "insight-attr", "insight-card", "insight-label",
  "insight-text", "is-continued", "keyword-cloud", "keyword-tag", "last", "left", "mark", "orange",
  "right", "speaker1", "speaker2", "speaker3", "speaker4", "stat-card", "stat-label",
  "stat-number", "stats-row", "step-content", "step-desc", "step-line", "step-num", "step-row",
  "step-title", "steps-container", "summary", "summary-intro", "summary-list", "summary-title",
  "table-wrap", "timeline", "timeline-event", "timeline-item", "timeline-year", "timestamp-link",
  "tip", "tip-pop", "tip-term", "toc-no", "toc-time", "toc-title",
];

test("KNOWN_CLASSES is exactly the article prompt's class list", () => {
  expect(SPEC_CLASSES).toHaveLength(76);
  expect([...KNOWN_CLASSES].sort()).toEqual([...SPEC_CLASSES].sort());
});

test("a well-formed article has no issues", () => {
  expect(lintArticle(article)).toEqual([]);
});

test("old plain-Markdown articles are not checked at all", () => {
  expect(lintArticle("前置き\n\n```\n## 見出し\n<div>\n```")).toEqual([]);
  expect(lintArticle("")).toEqual([]);
});

test("seconds-mismatch: data-seconds that disagrees with the button label", () => {
  const issues = lintArticle(article.replace('data-seconds="65"', 'data-seconds="66"'));
  expect(issues.map((i) => i.code)).toEqual(["seconds-mismatch"]);
  expect(issues[0].level).toBe("error");
  // H:MM:SS labels are understood too.
  const long = article.replace('data-seconds="65" href="#t=65">▶ 01:05', 'data-seconds="3725" href="#t=3725">▶ 1:02:05');
  expect(codes(long)).toEqual([]);
});

test("seconds-order: play buttons that do not increase chapter by chapter", () => {
  const swapped = article
    .replace('data-seconds="10" href="#t=10">▶ 00:10', 'data-seconds="70" href="#t=70">▶ 01:10');
  expect(codes(swapped)).toEqual(["seconds-order"]);
});

test("toc-mismatch and toc-title-mismatch", () => {
  expect(codes(article.replace('id="section-2"', 'id="section-3"'))).toEqual(["toc-mismatch"]);
  expect(codes(article.replace('href="#section-2"', 'href="#section-5"'))).toEqual(["toc-mismatch"]);
  const retitled = article.replace("<h2>4人の話者の吹き出しは", "<h2>4人の吹き出しは");
  const issues = lintArticle(retitled);
  expect(issues.map((i) => i.code)).toEqual(["toc-title-mismatch"]);
  expect(issues[0].level).toBe("warn");
});

test("div-unbalanced: a missing </div>", () => {
  expect(codes(article.replace('<div class="step-line"></div>', '<div class="step-line">'))).toEqual(
    expect.arrayContaining(["div-unbalanced"]),
  );
});

test("unknown-class names the class", () => {
  const issues = lintArticle(article.replace('class="insight-card"', 'class="insight-card quote-card"'));
  expect(issues.map((i) => i.code)).toEqual(["unknown-class"]);
  expect(issues[0].message).toContain("quote-card");
});

test("unknown-class: compare-body inside a compare item is accepted", () => {
  const html = '\n<div class="compare-grid"><div class="compare-item left"><div class="compare-label">A</div><div class="compare-body"><p>a</p></div></div><div class="figure-vs">VS</div><div class="compare-item right"><div class="compare-label">B</div><div class="compare-body"><p>b</p></div></div></div>\n';
  expect(codes(article + html)).toEqual([]);
});

test("unknown-class: ba-text inside a BEFORE/AFTER card is accepted", () => {
  const html = '\n<div class="ba-card before"><div class="ba-label before">BEFORE</div><div class="ba-text">a</div></div>\n';
  expect(codes(article + html)).toEqual([]);
});

test("step-line-missing: one divider fewer than rows - 1", () => {
  expect(codes(article.replace('<div class="step-line"></div>\n', ""))).toEqual(["step-line-missing"]);
});

test("no-summary", () => {
  const withoutSummary = article.slice(0, article.indexOf('<section class="summary">'));
  expect(codes(withoutSummary)).toEqual(["no-summary"]);
});

test("code-fence: the whole article wrapped in ```, or not starting with #", () => {
  const wrapped = lintArticle("```markdown\n" + article + "```\n");
  // The fence is reported once; the article inside is still checked normally.
  expect(wrapped.map((i) => i.code)).toEqual(["code-fence"]);
  expect(codes("以下が記事です。\n\n" + article)).toEqual(["code-fence"]);
});

test("code blocks inside the article are ignored", () => {
  const withCode = article.replace("図の後に続く地の文です。", '図の後。\n\n```html\n<div class="foo">\n```\n');
  expect(codes(withCode)).toEqual([]);
});
