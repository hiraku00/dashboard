/**
 * TextTube articles with HTML parts: Markdown prose mixed with a
 * fixed set of HTML parts (table of contents, chapter heads, speech bubbles,
 * term tips, figure boxes -- including numbered steps --, key insights, stat cards, summary). Only articles that contain those parts
 * are rendered with raw HTML enabled; every other article keeps going through
 * the plain Markdown path, where raw HTML is shown as text.
 */
import { defaultSchema } from "rehype-sanitize";
import type { Options as SanitizeSchema } from "rehype-sanitize";

/** Class names of the top-level parts, which only the article prompt emits. */
const PART_CLASSES = [
  "article-meta",
  "article-lead",
  "article-toc",
  "chapter-head",
  "bubble-group",
  "figure-box",
  "tip",
  "insight-card",
  "stats-row",
  "summary",
];

const PART_PATTERN = new RegExp(
  `<(?:p|div|nav|section|span)\\b[^>]*\\bclass="(?:[^"]*\\s)?(?:${PART_CLASSES.join("|")})(?:\\s[^"]*)?"`,
);

export function isPartsArticle(content: string): boolean {
  return PART_PATTERN.test(content);
}

/**
 * Allow-list for raw HTML in articles with HTML parts. Tags are the ones the
 * parts use plus what react-markdown already emits for Markdown prose and GFM; nothing
 * else (script, style, iframe, img with on* handlers, ...) survives.
 * Attributes are limited to class / id / href / target / rel / tabindex /
 * data-seconds, plus the few Markdown itself needs (code language class,
 * GFM table alignment and task-list checkboxes).
 */
export const partsSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    // Article parts
    "div", "span", "section", "nav", "p", "h1", "h2", "h3", "ol", "ul", "li", "a",
    "strong", "em", "table", "thead", "tbody", "tr", "th", "td", "br",
    // Markdown / GFM output
    "h4", "h5", "h6", "blockquote", "pre", "code", "hr", "del", "input", "sup", "sub",
  ],
  attributes: {
    "*": ["className", "id", "tabIndex"],
    a: ["href", "target", "rel", "dataSeconds"],
    th: ["align"],
    td: ["align"],
    input: [["type", "checkbox"], ["disabled", true], "checked"],
  },
  // Keep id="section-N" as written: the table of contents links to it.
  // The prefix exists to stop ids from clobbering globals such as
  // `window.foo`; the allow-list above already removes anything that could
  // read them (no scripts, no on* handlers), so the remaining risk is a
  // duplicated id, which the article controls anyway.
  clobberPrefix: "",
  clobber: [],
  protocols: { href: ["http", "https", "mailto"] },
  required: {},
  strip: ["script", "style", "iframe", "object", "embed", "template", "noscript"],
};

/** Seconds from `#t=106`, `#t=106s`, or a YouTube `t=` query value. */
export function parseSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^(\d+)s?$/);
  return match ? Number(match[1]) : null;
}

/**
 * YouTube watch URL starting at `seconds`, from the article's video URL.
 * Returns null when the video URL is not a YouTube URL.
 */
export function youtubeUrlAt(videoUrl: string | null | undefined, seconds: number): string | null {
  if (!videoUrl) return null;
  let url: URL;
  try {
    url = new URL(videoUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0] || null;
  else if (host === "youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = url.pathname.match(/^\/(?:live|shorts|embed)\/([\w-]+)/);
      id = m?.[1] ?? null;
    }
  }
  if (!id || !/^[\w-]{6,}$/.test(id)) return null;
  return `https://www.youtube.com/watch?v=${id}&t=${seconds}s`;
}
