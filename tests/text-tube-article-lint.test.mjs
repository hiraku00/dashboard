import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

import { lintArticle } from "../app/lib/text-tube-article-lint.ts";

// The test article from the article-prompt v3 hand-off: steps, four speakers,
// key insight, summary. It is well-formed, so it must give no warnings.
const article = readFileSync(new URL("./fixtures/text-tube-parts-article.md", import.meta.url), "utf8");
const codes = (md) => lintArticle(md).map((i) => i.code);

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
