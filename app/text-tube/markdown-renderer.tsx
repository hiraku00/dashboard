"use client";

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { useEffect, useRef } from "react";
import remarkGfm from "remark-gfm";
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

export function MarkdownRenderer({ content }: { content: string }) {
  const headingCounts = new Map<string, number>();
  const heading = (level: 1 | 2 | 3) => ({ children }: { children?: React.ReactNode }) => {
    const label = plainText(children);
    const base = markdownSlug(label);
    const count = headingCounts.get(base) ?? 0;
    headingCounts.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    const props = { id, tabIndex: -1, className: `markdown-heading markdown-h${level}` };
    if (level === 1) return <h1 {...props}>{children}</h1>;
    if (level === 2) return <h2 {...props}>{children}</h2>;
    return <h3 {...props}>{children}</h3>;
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
    code: ({ className, children }) => {
      const language = className?.match(/language-([\w-]+)/)?.[1];
      const code = String(children).replace(/\n$/, "");
      if (language === "mermaid") return <MermaidDiagram chart={code} />;
      if (!className) return <code>{children}</code>;
      return <code className={className}>{children}</code>;
    },
  };

  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {normalizeMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
}
