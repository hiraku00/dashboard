import Link from "next/link";

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

export function PortalHeader({ kicker = "HIRAKU PORTAL", title, active }: { kicker?: string; title: string; active?: string }) {
  return <div className="portal-chrome">
    <header className="portal-header">
      <div><p className="app-kicker">{kicker}</p><h1>{title}</h1></div>
      <a className="logout-link" href="/cdn-cgi/access/logout">ログアウト</a>
    </header>
    <PortalNav active={active} />
  </div>;
}
