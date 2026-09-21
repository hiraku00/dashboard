"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type MouseEvent } from "react";

/** Gives a tab click an immediate response. Each tab is a Server Component page
 *  that reads D1, so the old page stays on screen, unchanged, until the server
 *  answers -- on production that is anywhere from 0.15s to over a second, and
 *  looked like the click had not registered.
 *
 *  This is deliberately client-only: it marks the clicked link and runs a bar
 *  along the top until the pathname changes. A route-level loading.tsx would
 *  show a skeleton instead, but in this app (vinext 0.0.50) it leaves a direct
 *  visit or reload stuck on the skeleton, never hydrating. Nothing here touches
 *  the server render.
 *
 *  The nav is rendered again by the page that loads, so the state below simply
 *  goes away with the old page; tying "pending" to the pathname it started on
 *  also ends it if the same nav instance survives the navigation. */
const GIVE_UP_MS = 20_000;

export function PortalNavLinks({ links, active }: { links: ReadonlyArray<readonly [string, string]>; active?: string }) {
  const pathname = usePathname();
  const [pending, setPending] = useState<{ href: string; from: string } | null>(null);
  const pendingHref = pending && pending.from === pathname ? pending.href : null;

  // A navigation that never lands (offline, the server erroring) must not leave
  // the bar running for good.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(null), GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const onClick = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    // Only a plain left click that stays in this tab is a navigation we wait for.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (href === pathname) return;
    setPending({ href, from: pathname });
  };

  return (
    <>
      {links.map(([href, label]) => (
        <Link
          key={href}
          className={[active === href ? "active" : "", pendingHref === href ? "pending" : ""].filter(Boolean).join(" ")}
          href={href}
          onClick={(event) => onClick(event, href)}
          // See the note in portal-nav.tsx: prefetching reads D1 for every nav item on every page view.
          prefetch={false}
        >
          {label}
        </Link>
      ))}
      <span className="sr-only" role="status">{pendingHref ? "読み込み中" : ""}</span>
      {pendingHref && <span className="nav-progress" aria-hidden="true" />}
    </>
  );
}
