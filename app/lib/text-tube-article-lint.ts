/**
 * Format checks for a TextTube article with HTML parts, run on the edit page
 * before saving. They only warn: the save button stays enabled, because a
 * slightly broken article is still better saved than lost.
 *
 * Only articles that contain `class="chapter-head"` are checked; anything
 * else is an older plain-Markdown article and gets no warnings.
 *
 * A quick regex scan is enough here (the article prompt writes the HTML in a
 * fixed shape), so there is no DOM parser, which the edit page and Workers
 * would otherwise both need.
 */

export type ArticleLintCode =
  | "toc-mismatch"
  | "toc-title-mismatch"
  | "seconds-mismatch"
  | "seconds-order"
  | "div-unbalanced"
  | "unknown-class"
  | "step-line-missing"
  | "no-summary"
  | "code-fence";

export type ArticleLintIssue = { level: "error" | "warn"; code: ArticleLintCode; message: string };

/** Class names the article parts use (keep in sync with `.tt-article` in app/globals.css). */
const KNOWN_CLASSES = new Set([
  // Meta, lead, table of contents
  "article-meta", "article-lead", "article-toc", "article-toc-title", "toc-no", "toc-title", "toc-time",
  // Chapter heads
  "chapter-head", "chapter-no", "chapter-head-actions", "timestamp-link",
  // Speech bubbles
  "bubble-group", "bubble-row", "bubble-avatar", "bubble-content", "bubble-name", "bubble",
  "speaker1", "speaker2", "speaker3", "speaker4", "is-continued",
  // Term tips, emphasis
  "tip", "tip-term", "tip-pop", "mark",
  // Figures
  "figure-box", "figure-box-title",
  "timeline", "timeline-item", "last", "timeline-year", "timeline-event",
  "ba-card", "figure-card", "ba-label", "before", "after", "ba-arrow", "figure-arrow", "highlight", "highlight-green",
  "compare-grid", "compare-item", "left", "right", "compare-label", "figure-vs",
  "keyword-cloud", "keyword-tag", "blue", "green", "orange",
  "table-wrap", "article-table",
  "steps-container", "step-row", "step-num", "step-content", "step-title", "step-desc", "step-line",
  // Key insight, stat cards, summary
  "insight-card", "insight-label", "insight-text", "insight-attr",
  "stats-row", "stat-card", "stat-number", "stat-label",
  "summary", "summary-title", "summary-intro", "summary-list",
]);

type Tag = { name: string; attrs: Record<string, string>; classes: string[]; start: number; end: number };

function openTags(html: string): Tag[] {
  const tags: Tag[] = [];
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1].toLowerCase()] = a[2];
    tags.push({
      name: m[1].toLowerCase(),
      attrs,
      classes: (attrs.class ?? "").split(/\s+/).filter(Boolean),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return tags;
}

/** Inner HTML of the element whose opening tag ends at `from`, matching same-name tags by depth. */
function innerOf(html: string, name: string, from: number): string {
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(from, m.index);
  }
  return html.slice(from);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/** Seconds from the first `MM:SS` or `H:MM:SS` in a button label. */
function labelSeconds(label: string): number | null {
  const m = label.match(/(\d+):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

const sectionNo = (value: string | undefined, prefix: string) =>
  value?.match(new RegExp(`^${prefix}section-(\\d+)$`))?.[1] ?? null;

export function lintArticle(markdown: string): ArticleLintIssue[] {
  if (!markdown.includes('class="chapter-head"')) return [];
  const issues: ArticleLintIssue[] = [];
  const add = (level: ArticleLintIssue["level"], code: ArticleLintCode, message: string) =>
    issues.push({ level, code, message });

  let body = markdown.trim();
  const fenced = body.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) {
    add("error", "code-fence", "本文全体が ``` で囲まれています。前後の ``` を消してください。");
    body = fenced[1].trim();
  } else if (!body.startsWith("#")) {
    add("error", "code-fence", "本文の1文字目が # ではありません。先頭の説明文や ``` を消して、# のタイトルから始めてください。");
  }
  // Code blocks inside the article (Mermaid and the like) are not HTML parts.
  const html = body.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, "");
  const tags = openTags(html);

  // Table of contents vs chapter heads
  const tocTitles = new Map<string, string>();
  for (const nav of tags.filter((t) => t.name === "nav" && t.classes.includes("article-toc"))) {
    const inner = innerOf(html, "nav", nav.end);
    for (const a of inner.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      const n = sectionNo(a[1].match(/href\s*=\s*"([^"]*)"/)?.[1], "#");
      if (!n) continue;
      const title = a[2].match(/<span\b[^>]*class="(?:[^"]*\s)?toc-title(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/span>/)?.[1];
      tocTitles.set(n, title != null ? textOf(title) : "");
    }
  }
  const chapters = tags
    .filter((t) => t.name === "div" && t.classes.includes("chapter-head"))
    .map((t) => {
      const inner = innerOf(html, "div", t.end);
      const h2 = inner.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/)?.[1];
      return { n: sectionNo(t.attrs.id, ""), id: t.attrs.id, title: h2 != null ? textOf(h2) : "", inner };
    });
  const chapterNos = new Set(chapters.map((c) => c.n).filter((n): n is string => n != null));
  const missingChapters = [...tocTitles.keys()].filter((n) => !chapterNos.has(n));
  const missingToc = [...chapterNos].filter((n) => !tocTitles.has(n));
  const badIds = chapters.filter((c) => c.n == null);
  if (missingChapters.length || missingToc.length || badIds.length) {
    const parts: string[] = [];
    if (missingChapters.length) parts.push(`目次にあって章が無い: ${missingChapters.map((n) => `section-${n}`).join(", ")}`);
    if (missingToc.length) parts.push(`章にあって目次に無い: ${missingToc.map((n) => `section-${n}`).join(", ")}`);
    if (badIds.length) parts.push(`id が section-N でない章: ${badIds.map((c) => c.id ?? "（id なし）").join(", ")}`);
    add("error", "toc-mismatch", `目次と章見出しが対応していません（${parts.join("／")}）。`);
  }
  for (const c of chapters) {
    if (c.n == null || !tocTitles.has(c.n)) continue;
    const tocTitle = tocTitles.get(c.n)!;
    if (tocTitle !== c.title)
      add("warn", "toc-title-mismatch", `section-${c.n} の目次の見出し「${tocTitle}」と、章の見出し「${c.title}」が違います。`);
  }

  // Play buttons
  const seconds: { label: string; value: number }[] = [];
  for (const a of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    if (!/class="(?:[^"]*\s)?timestamp-link(?:\s[^"]*)?"/.test(a[1])) continue;
    const raw = a[1].match(/data-seconds\s*=\s*"([^"]*)"/)?.[1];
    if (raw == null || !/^\d+$/.test(raw)) continue;
    const value = Number(raw);
    const label = textOf(a[2]);
    const fromLabel = labelSeconds(label);
    if (fromLabel != null && fromLabel !== value)
      add("error", "seconds-mismatch", `再生ボタン「${label}」の data-seconds が ${value} です（${fromLabel} のはず）。`);
    seconds.push({ label, value });
  }
  for (let i = 1; i < seconds.length; i++) {
    if (seconds[i].value <= seconds[i - 1].value)
      add("warn", "seconds-order", `再生ボタン「${seconds[i].label}」の秒数（${seconds[i].value}）が、前の章（${seconds[i - 1].value}）より大きくありません。`);
  }

  // Markup
  const opens = (html.match(/<div\b/gi) ?? []).length;
  const closes = (html.match(/<\/div>/gi) ?? []).length;
  if (opens !== closes)
    add("error", "div-unbalanced", `<div が ${opens} 個、</div> が ${closes} 個で、数が合いません。`);

  const unknown = new Set<string>();
  for (const t of tags) for (const c of t.classes) if (!KNOWN_CLASSES.has(c)) unknown.add(c);
  if (unknown.size)
    add("warn", "unknown-class", `表示に対応していないクラスがあります: ${[...unknown].join(", ")}`);

  for (const t of tags.filter((t) => t.name === "div" && t.classes.includes("steps-container"))) {
    const inner = innerOf(html, "div", t.end);
    const innerTags = openTags(inner);
    const rows = innerTags.filter((x) => x.classes.includes("step-row")).length;
    const lines = innerTags.filter((x) => x.classes.includes("step-line")).length;
    if (rows > 0 && lines !== rows - 1)
      add("warn", "step-line-missing", `ステップ図で、手順が ${rows} 個に対して間の線（step-line）が ${lines} 本です（${rows - 1} 本のはず）。`);
  }

  if (!tags.some((t) => t.name === "section" && t.classes.includes("summary")))
    add("warn", "no-summary", "まとめ（section.summary）がありません。");

  return issues;
}
