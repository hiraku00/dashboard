import Link from "next/link";
import type { ReactNode } from "react";

export function PortalNav({ active }: { active?: string }) {
  const links = [
    ["/", "ホーム"],
    ["/watch-list", "Watch List"],
    ["/text-tube", "TextTube"],
    ["/manage-asset", "Manage Asset"],
    ["/settings/storage", "使用量"],
  ];
  return <nav className="portal-nav" aria-label="ポータルメニュー">
    {links.map(([href, label]) => <Link key={href} className={active === href ? "active" : ""} href={href}>{label}</Link>)}
  </nav>;
}

export function PortalHeader({ title, active, children }: { title: string; active?: string; children?: ReactNode }) {
  return <div className="portal-chrome">
    <header className="portal-header">
      <h1>{title}</h1>
      <a className="logout-link" href="/cdn-cgi/access/logout">ログアウト</a>
    </header>
    <PortalNav active={active} />
    {children}
  </div>;
}
