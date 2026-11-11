import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MarkdownRenderer } from "@/app/text-tube/markdown-renderer";
import { isPartsArticle, youtubeUrlAt } from "@/app/text-tube/article-html";

// Mermaid needs a real layout engine; these tests only check what wraps it.
vi.mock("@/app/text-tube/mermaid-diagram", () => ({
  MermaidDiagram: ({ chart }: { chart: string }) => <div data-testid="mermaid">{chart}</div>,
}));

afterEach(cleanup);

const partsArticle = `# タイトル

<p class="article-lead">リード文</p>

<nav class="article-toc">
<p class="article-toc-title">この記事でわかること</p>
<ol>
<li><a href="#section-1"><span class="toc-no">01</span><span class="toc-title">章1</span><span class="toc-time">00:17</span></a></li>
</ol>
</nav>

<div class="chapter-head" id="section-1">
<span class="chapter-no">01</span>
<h2>章1</h2>
<div class="chapter-head-actions"><a class="timestamp-link" data-seconds="17" href="#t=17">▶ 00:17 から再生する</a></div>
</div>

地の文の **強調** と [外部リンク](https://example.com)。

<p>用語<span class="tip" tabindex="0"><span class="tip-term">トークン</span><span class="tip-pop"><strong>トークン</strong> ── 説明</span></span>です。</p>
`;

test("only articles with HTML parts take the raw-HTML path", () => {
  expect(isPartsArticle(partsArticle)).toBe(true);
  expect(isPartsArticle("## 見出し\n\n- 箇条書き\n\n| a | b |\n| - | - |\n| 1 | 2 |")).toBe(false);
  // A paragraph that merely mentions the markup in a code span is not one.
  expect(isPartsArticle("`div` や `span` の話")).toBe(false);
});

test("old-format articles render exactly as before: HTML stays text, slugged heading ids", () => {
  const { container } = render(<MarkdownRenderer content={'## 見出し A\n\n<b>raw</b>'} />);
  expect(container.querySelector(".markdown-body")).not.toBeNull();
  expect(container.querySelector(".tt-article")).toBeNull();
  expect(container.querySelector("h2")?.id).toBe("見出し-a");
  expect(container.querySelector("b")).toBeNull();
  expect(container.textContent).toContain("<b>raw</b>");
});

test("HTML parts keep their classes and ids, and the TOC link targets the chapter", () => {
  const { container } = render(<MarkdownRenderer content={partsArticle} />);
  const article = container.querySelector(".tt-article")!;
  expect(article).not.toBeNull();
  expect(article.querySelector("nav.article-toc a")?.getAttribute("href")).toBe("#section-1");
  expect(article.querySelector("div.chapter-head#section-1 h2")?.textContent).toBe("章1");
  expect(article.querySelector("span.tip[tabindex='0'] span.tip-pop strong")?.textContent).toBe("トークン");
  const external = article.querySelector("a[href='https://example.com']")!;
  expect(external.getAttribute("target")).toBe("_blank");
  expect(external.getAttribute("rel")).toContain("noopener");
});

test("key insight and stat cards are recognised and keep their structure", () => {
  const parts = `本文

<div class="insight-card">
<p class="insight-label">キーインサイト</p>
<p class="insight-text">引用</p>
<p class="insight-attr">── 話者</p>
</div>

<div class="stats-row">
<div class="stat-card"><div class="stat-number">100ページ</div><div class="stat-label">説明1</div></div>
<div class="stat-card"><div class="stat-number">業務委託</div><div class="stat-label">説明2</div></div>
</div>
`;
  // Each part alone is enough to switch to the raw-HTML path.
  expect(isPartsArticle(parts.slice(0, parts.indexOf("<div class=\"stats-row\">")))).toBe(true);
  expect(isPartsArticle(parts.slice(parts.indexOf("<div class=\"stats-row\">")))).toBe(true);
  const { container } = render(<MarkdownRenderer content={parts} />);
  const article = container.querySelector(".tt-article")!;
  expect(article.querySelector("div.insight-card > p.insight-label")?.textContent).toBe("キーインサイト");
  expect(article.querySelector("div.insight-card > p.insight-text")?.textContent).toBe("引用");
  expect(article.querySelector("div.insight-card > p.insight-attr")?.textContent).toBe("── 話者");
  const cards = article.querySelectorAll("div.stats-row > div.stat-card");
  expect(cards).toHaveLength(2);
  expect(cards[0].querySelector(".stat-number")?.textContent).toBe("100ページ");
  expect(cards[1].querySelector(".stat-label")?.textContent).toBe("説明2");
});

test("step figures keep every row and the empty step-line dividers between them", () => {
  const steps = `本文

<div class="figure-box">
<div class="figure-box-title"><span>手順</span></div>
<div class="steps-container">
<div class="step-row"><div class="step-num">1</div><div class="step-content"><div class="step-title">一</div><div class="step-desc">説明1</div></div></div>
<div class="step-line"></div>
<div class="step-row"><div class="step-num">2</div><div class="step-content"><div class="step-title">二</div><div class="step-desc">説明2</div></div></div>
<div class="step-line"></div>
<div class="step-row"><div class="step-num">3</div><div class="step-content"><div class="step-title">三</div><div class="step-desc">説明3</div></div></div>
</div>
</div>
`;
  expect(isPartsArticle(steps)).toBe(true);
  const { container } = render(<MarkdownRenderer content={steps} />);
  const box = container.querySelector(".tt-article div.figure-box > div.steps-container")!;
  const children = Array.from(box.children).map((el) => el.className);
  expect(children).toEqual(["step-row", "step-line", "step-row", "step-line", "step-row"]);
  // The dividers are empty divs; they must survive sanitizing as elements.
  box.querySelectorAll(".step-line").forEach((line) => expect(line.childNodes).toHaveLength(0));
  const rows = box.querySelectorAll("div.step-row");
  expect(rows[1].querySelector(":scope > div.step-num")?.textContent).toBe("2");
  expect(rows[1].querySelector(":scope > div.step-content > div.step-title")?.textContent).toBe("二");
  expect(rows[2].querySelector("div.step-desc")?.textContent).toBe("説明3");
});

test("the play button opens the article's YouTube video at that second", () => {
  const { container } = render(<MarkdownRenderer content={partsArticle} videoUrl="https://youtu.be/abcdefghijk" />);
  const link = container.querySelector("a.timestamp-link")!;
  expect(link.getAttribute("href")).toBe("https://www.youtube.com/watch?v=abcdefghijk&t=17s");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(link.getAttribute("data-seconds")).toBe("17");
});

test("without a YouTube URL the play button keeps #t=N", () => {
  const { container } = render(<MarkdownRenderer content={partsArticle} videoUrl="https://example.com/podcast" />);
  const link = container.querySelector("a.timestamp-link")!;
  expect(link.getAttribute("href")).toBe("#t=17");
  expect(link.hasAttribute("target")).toBe(false);
});

test("scripts, event handlers, style, iframes and javascript: URLs are removed", () => {
  const evil = `${partsArticle}
<script>window.__pwned = 1</script>
<img src="x" onerror="window.__pwned = 2">
<div class="figure-box" style="position:fixed" onclick="window.__pwned = 3"><span onmouseover="window.__pwned = 4">x</span></div>
<a href="javascript:window.__pwned=5">bad</a>
<iframe src="https://example.com"></iframe>
<a class="timestamp-link" data-seconds="1" href="javascript:alert(1)">▶</a>
`;
  const { container } = render(<MarkdownRenderer content={evil} />);
  const html = container.innerHTML;
  expect(container.querySelector("script, iframe, img, [style], [onclick], [onerror], [onmouseover]")).toBeNull();
  expect(html).not.toMatch(/javascript:/i);
  expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  // The allowed part around the bad attributes is still shown.
  expect(container.querySelector(".figure-box")).not.toBeNull();
});

test("tapping a term tip toggles it open and closed; tapping elsewhere closes it", () => {
  const { container } = render(<MarkdownRenderer content={partsArticle} />);
  const tip = container.querySelector(".tip")!;
  fireEvent.click(tip.querySelector(".tip-term")!);
  expect(tip.classList.contains("is-open")).toBe(true);
  fireEvent.click(tip.querySelector(".tip-term")!);
  expect(tip.classList.contains("is-open")).toBe(false);
  fireEvent.click(tip.querySelector(".tip-term")!);
  fireEvent.click(document.body);
  expect(tip.classList.contains("is-open")).toBe(false);
});

test("youtubeUrlAt understands the usual YouTube URL shapes", () => {
  expect(youtubeUrlAt("https://www.youtube.com/watch?v=abcdefghijk&list=x", 5)).toBe("https://www.youtube.com/watch?v=abcdefghijk&t=5s");
  expect(youtubeUrlAt("https://m.youtube.com/live/abcdefghijk", 5)).toBe("https://www.youtube.com/watch?v=abcdefghijk&t=5s");
  expect(youtubeUrlAt("https://open.spotify.com/episode/x", 5)).toBeNull();
  expect(youtubeUrlAt("not a url", 5)).toBeNull();
});
