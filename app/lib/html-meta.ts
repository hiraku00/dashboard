/** Helpers for reading <meta>/<link> tags out of raw HTML without a DOM (the
 *  Worker has none). Shared by the watch-list YouTube preview route and the
 *  thumbnail resolver, which both scrape a page's head. No imports, so it
 *  loads under vitest's plain-Node "node" project. */

export function attribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

export function decodeHtml(value: string) {
  const named: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", "#39": "'" };
  return value.replace(/&#(x[\da-f]+|\d+);|&(quot|amp|lt|gt|#39);/gi, (match: string, numeric: string | undefined, entity: string | undefined) => {
    if (numeric) {
      const codePoint = numeric.toLowerCase().startsWith("x") ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    return named[(entity ?? "").toLowerCase()] ?? match;
  });
}

/** The `content` of the first <meta>/<link> tag that has one and satisfies
 *  `selector`. */
export function tagContent(html: string, selector: (tag: string) => boolean) {
  return html.match(/<(?:meta|link)\b[^>]*>/gi)?.map((tag) => ({ tag, content: attribute(tag, "content") })).find(({ tag, content }) => content && selector(tag))?.content ?? "";
}
