import type { ReactNode } from "react";
import { PortalNavLinks } from "./portal-nav-links";

/** The link row. Prefetching stays off (see below), and the row itself is a
 *  client component (app/portal-nav-links.tsx) so a click can be acknowledged
 *  before the next page arrives.
 *
 *  Next.js prefetches a <Link> target as soon as it enters the viewport, not
 *  only on hover -- confirmed by watching network requests fire for every nav
 *  item the instant this bar rendered, with no interaction at all. Once a
 *  destination page becomes a Server Component that reads D1 (the RSC migration
 *  this nav is part of), that means every page view silently reads D1 once for
 *  each nav item shown, whether or not anyone ever clicks it. This dashboard's
 *  D1 read quota has been a repeated concern this project, so prefetching is
 *  turned off here rather than left to be discovered as a quota surprise once
 *  more pages are migrated. */
export function PortalNav({ active }: { active?: string }) {
  const links = [
    ["/", "ホーム"],
    ["/watch-list", "Watch List"],
    ["/text-tube", "TextTube"],
    ["/manage-asset", "Manage Asset"],
    ["/todo", "To Do"],
    ["/chikirin", "ちきりんオプチャ"],
    ["/settings/storage", "使用量"],
  ] as const;
  return (
    <nav className="portal-nav" aria-label="ポータルメニュー">
      <PortalNavLinks links={links} active={active} />
    </nav>
  );
}

export function PortalHeader({
  title,
  active,
  children,
}: {
  title: ReactNode;
  active?: string;
  children?: ReactNode;
}) {
  return (
    <div className="portal-chrome">
      <header className="portal-header">
        <h1>{title}</h1>
        <a className="logout-link" href="/cdn-cgi/access/logout">
          ログアウト
        </a>
      </header>
      <PortalNav active={active} />
      {children}
    </div>
  );
}
