"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PortalHeader } from "./portal-nav";

type DashboardState = {
  watch: { total: number; completed: number };
  textTube: { total: number; latest: { id: string; title: string; channel_name: string } | null };
  assets: { totalUsd: number; totalJpy: number; latestAt: string | null; sourceCount: number };
  todo: { total: number; completed: number };
};

const yen = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function PortalHome({
  initial = null,
}: {
  // Passed by app/page.tsx (a Server Component) after fetching this directly
  // from D1 -- see app/lib/queries/portal.ts. Optional so this component
  // still works exactly as before (client-side fetch on mount) if ever
  // rendered without it; that keeps a rollback to the old page.tsx a
  // one-line change, not a two-sided one.
  initial?: DashboardState | null;
} = {}) {
  const [state, setState] = useState<DashboardState | null>(initial);
  const [error, setError] = useState("");
  useEffect(() => {
    // The server already fetched this once for the initial render; only
    // fall back to a client-side fetch when it didn't produce anything --
    // either this component was rendered without server data at all (the
    // pre-RSC path), or the server-side fetch itself failed (see
    // app/page.tsx's catch). Either way the client attempts the exact same
    // fetch the pre-RSC page always made, so a transient SSR-side failure
    // gets a second, independent chance to succeed instead of being shown
    // to the user as a hard error.
    if (initial) return;
    fetch("/api/portal/summary").then(async (response) => { if (!response.ok) throw new Error("データを読み込めませんでした。"); setState(await response.json()); }).catch((reason) => setError(reason instanceof Error ? reason.message : "読み込みに失敗しました。"));
    // `initial` is intentionally omitted below: this effect only reads it
    // once to decide whether to fetch at all (a prop from the server that
    // cannot meaningfully change after the initial render), and this page
    // has no filters or params to react to, so there is nothing to re-fetch
    // on -- matching the pre-RSC behavior of fetching exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <main className="portal-shell dashboard-shell">
    <PortalHeader title="Dashboard" active="/" />
    {error && <p className="notice" role="alert">{error}</p>}
    {/* prefetch={false}: see the comment in portal-nav.tsx -- these Links
        point at the same pages this dashboard is migrating to Server
        Components one at a time, and an unprefetched Link only fetches its
        target when actually clicked instead of for every card shown here on
        every portal visit. */}
    <section className="portal-cards" aria-label="機能一覧">
      <Link className="portal-card portal-card-watch" href="/watch-list" prefetch={false}><h2>Watch List</h2><strong>{state?.watch.total ?? "—"}<small> 件</small></strong><p>{state ? `${state.watch.completed}件完了` : "読み込み中"}</p></Link>
      <Link className="portal-card portal-card-text" href="/text-tube" prefetch={false}><h2>TextTube</h2><strong>{state?.textTube.total ?? "—"}<small> 本</small></strong><p>{state?.textTube.latest?.title ?? (state ? "" : "読み込み中")}</p></Link>
      <Link className="portal-card portal-card-asset" href="/manage-asset" prefetch={false}><h2>Manage Asset</h2><strong>{state ? usd.format(state.assets.totalUsd) : "—"}</strong><p>{state ? `${yen.format(state.assets.totalJpy)}円` : "読み込み中"}</p></Link>
      <Link className="portal-card portal-card-todo" href="/todo" prefetch={false}><h2>To Do</h2><strong>{state?.todo.total ?? "—"}<small> 件</small></strong><p>{state ? `${state.todo.completed}件完了` : "読み込み中"}</p></Link>
      <Link className="portal-card" href="/settings/storage" prefetch={false}><h2>使用量</h2><strong>R2 / D1</strong><p>保存容量・DB利用量・TextTube字幕API</p></Link>
    </section>
  </main>;
}
