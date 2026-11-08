"use client";

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { useEffect, useRef } from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import { isPodyArticle, parseSeconds, podySanitizeSchema, youtubeUrlAt } from "./article-html";
import { MermaidDiagram } from "./mermaid-diagram";

function plainText(value: unknown): string {
  if (Array.isArray(value)) return value.map(plainText).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && "props" in value) {
    return plainText((value as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

/** Keep the same slug rules for headings and [目次](#...) links. */
export function markdownSlug(value: string): string {
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the original text when a stored link contains malformed encoding.
  }
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

/**
 * Some imported TextTube records contain a GFM table collapsed into one line:
 * `| a | b | | --- | --- | | c | d |`. Restore row boundaries before parsing.
 */
export function normalizeMarkdown(content: string): string {
  return content.replace(/\|\s+\|/g, "|\n|");
}

function ResponsiveTable({ children }: { children?: React.ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const table = container.current?.querySelector("table");
    if (!table) return;
    const labels = [...table.querySelectorAll("thead th")].map((header) => header.textContent?.trim() || "項目");
    table.querySelectorAll("tbody tr").forEach((row) => {
      row.querySelectorAll("td").forEach((cell, index) => cell.setAttribute("data-label", labels[index] || `項目 ${index + 1}`));
    });
  }, [children]);
  return <div ref={container} className="markdown-table-scroll"><table>{children}</table></div>;
}

function MermaidOrCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const language = className?.match(/language-([\w-]+)/)?.[1];
  const code = String(children).replace(/\n$/, "");
  if (language === "mermaid") return <MermaidDiagram chart={code} />;
  if (!className) return <code>{children}</code>;
  return <code className={className}>{children}</code>;
}

/**
 * Term tips (`span.tip`): hover on a pointer device, tap to toggle on a touch
 * device, and keep the popup inside the viewport near the screen edges.
 */
function useTermTips(container: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const place = (tip: Element) => {
      const pop = tip.querySelector<HTMLElement>(".tip-pop");
      if (!pop) return;
      const fit = () => {
        pop.style.transform = "";
        // Reading the box forces layout, so this sees the popup as currently
        // shown; a hidden one (display:none) has no width and is left alone.
        const rect = pop.getBoundingClientRect();
        if (!rect.width) return;
        const margin = 8;
        const width = document.documentElement.clientWidth;
        let shift = 0;
        if (rect.right > width - margin) shift = width - margin - rect.right;
        if (rect.left + shift < margin) shift = margin - rect.left;
        pop.style.transform = shift ? `translateX(${Math.round(shift)}px)` : "";
      };
      fit();
      // Once more after the browser applies :hover / :focus-visible, in case
      // the popup was not shown yet when the event fired.
      requestAnimationFrame(fit);
    };
    const closeAll = (except?: Element) => {
      root.querySelectorAll(".tip.is-open").forEach((tip) => {
        if (tip !== except) tip.classList.remove("is-open");
      });
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const tip = target?.closest(".tip");
      if (!tip || !root.contains(tip)) {
        closeAll();
        return;
      }
      // A tap inside an open popup (selecting its text, say) keeps it open.
      if (target?.closest(".tip-pop") && tip.classList.contains("is-open")) return;
      closeAll(tip);
      const open = tip.classList.toggle("is-open");
      if (open) place(tip);
      else (tip as HTMLElement).blur();
    };
    const onEnter = (event: Event) => {
      const tip = (event.target as Element | null)?.closest?.(".tip");
      if (tip && root.contains(tip)) place(tip);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAll();
    };
    document.addEventListener("click", onClick);
    root.addEventListener("mouseover", onEnter);
    root.addEventListener("focusin", onEnter);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      root.removeEventListener("mouseover", onEnter);
      root.removeEventListener("focusin", onEnter);
      document.removeEventListener("keydown", onKey);
    };
  }, [container]);
}

/**
 * Pody-format articles: raw HTML parts are kept, filtered through an
 * allow-list (podySanitizeSchema), and styled under `.tt-article` instead of
 * `.markdown-body` (whose pre-wrap paragraphs and card-style tables would
 * break the parts). Ids are kept as written (`section-N`), so the slug
 * rewriting used for old-format articles is not applied here.
 */
function PodyArticle({ content, videoUrl }: { content: string; videoUrl?: string | null }) {
  const container = useRef<HTMLDivElement>(null);
  useTermTips(container);
  const components: Components = {
    a: ({ href, children, className, target, ...rest }) => {
      const dataSeconds = (rest as Record<string, unknown>)["data-seconds"] as string | undefined;
      if (className?.split(/\s+/).includes("timestamp-link")) {
        // No player is embedded on the watch page, so the button opens the
        // video at that second in a new tab when the article's URL is a
        // YouTube one; otherwise the link stays as written (#t=N).
        const seconds = parseSeconds(dataSeconds) ?? parseSeconds(href?.match(/^#t=(\d+s?)$/)?.[1]);
        const external =
          href && /^https?:/i.test(href) ? href : seconds != null ? youtubeUrlAt(videoUrl, seconds) : null;
        return (
          <a
            href={external ?? href}
            className={className}
            data-seconds={dataSeconds}
            target={external ? "_blank" : undefined}
            rel={external ? "noopener noreferrer" : undefined}
          >
            {children}
          </a>
        );
      }
      const isInternal = href?.startsWith("#") ?? false;
      const finalTarget = target ?? (isInternal ? undefined : "_blank");
      return (
        <a
          href={href}
          className={className}
          target={finalTarget}
          rel={finalTarget === "_blank" ? "noopener noreferrer" : undefined}
        >
          {children}
        </a>
      );
    },
    code: ({ className, children }) => <MermaidOrCode className={className}>{children}</MermaidOrCode>,
  };
  return (
    <div ref={container} className="tt-article">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCjkFriendly]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, podySanitizeSchema]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function MarkdownRenderer({ content, videoUrl }: { content: string; videoUrl?: string | null }) {
  if (isPodyArticle(content)) return <PodyArticle content={content} videoUrl={videoUrl} />;
  return <LegacyMarkdown content={content} />;
}

function LegacyMarkdown({ content }: { content: string }) {
  const headingCounts = new Map<string, number>();
  const heading = (level: 1 | 2 | 3) => {
    // Named and given an explicit displayName rather than returned as a bare
    // arrow function: react/display-name's static analysis can attribute a
    // name to a function assigned directly to an object property (like the
    // other entries in `components` below), but not to one returned from
    // another function, so this particular shape needs to say its own name.
    function MarkdownHeading({ children }: { children?: React.ReactNode }) {
      const label = plainText(children);
      const base = markdownSlug(label);
      const count = headingCounts.get(base) ?? 0;
      headingCounts.set(base, count + 1);
      const id = count === 0 ? base : `${base}-${count + 1}`;
      const props = { id, tabIndex: -1, className: `markdown-heading markdown-h${level}` };
      if (level === 1) return <h1 {...props}>{children}</h1>;
      if (level === 2) return <h2 {...props}>{children}</h2>;
      return <h3 {...props}>{children}</h3>;
    }
    MarkdownHeading.displayName = `MarkdownHeading${level}`;
    return MarkdownHeading;
  };

  const components: Components = {
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    a: ({ href, children }) => {
      const isInternal = href?.startsWith("#") ?? false;
      const finalHref = isInternal && href ? `#${markdownSlug(href.slice(1))}` : href;
      return (
        <a
          href={finalHref}
          target={isInternal ? undefined : "_blank"}
          rel={isInternal ? undefined : "noopener noreferrer"}
          className={isInternal ? "markdown-anchor markdown-anchor-internal" : "markdown-anchor"}
        >
          {children}
        </a>
      );
    },
    p: ({ children }) => <p>{children}</p>,
    ul: ({ children }) => <ul>{children}</ul>,
    ol: ({ children }) => <ol>{children}</ol>,
    li: ({ children }) => <li>{children}</li>,
    blockquote: ({ children }) => <blockquote>{children}</blockquote>,
    table: ({ children }) => <ResponsiveTable>{children}</ResponsiveTable>,
    thead: ({ children }) => <thead>{children}</thead>,
    th: ({ children }) => <th>{children}</th>,
    td: ({ children }) => <td>{children}</td>,
    hr: () => <hr />,
    code: ({ className, children }) => <MermaidOrCode className={className}>{children}</MermaidOrCode>,
  };

  return (
    <div className="markdown-body">
      {/* remark-cjk-friendly: CommonMark rejects a closing ** between Japanese
          punctuation and a letter (`**「…」**と`), leaving the asterisks visible. */}
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]} components={components}>
        {normalizeMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
}
