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

export function PortalHome() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { fetch("/api/portal/summary").then(async (response) => { if (!response.ok) throw new Error("データを読み込めませんでした。"); setState(await response.json()); }).catch((reason) => setError(reason instanceof Error ? reason.message : "読み込みに失敗しました。")); }, []);
  return <main className="portal-shell dashboard-shell">
    <PortalHeader title="Dashboard" active="/" />
    {error && <p className="notice" role="alert">{error}</p>}
    <section className="portal-cards" aria-label="機能一覧">
      <Link className="portal-card portal-card-watch" href="/watch-list"><h2>Watch List</h2><strong>{state?.watch.total ?? "—"}<small> 件</small></strong><p>{state ? `${state.watch.completed}件完了` : "読み込み中"}</p></Link>
      <Link className="portal-card portal-card-text" href="/text-tube"><h2>TextTube</h2><strong>{state?.textTube.total ?? "—"}<small> 本</small></strong><p>{state?.textTube.latest?.title ?? (state ? "" : "読み込み中")}</p></Link>
      <Link className="portal-card portal-card-asset" href="/manage-asset"><h2>Manage Asset</h2><strong>{state ? usd.format(state.assets.totalUsd) : "—"}</strong><p>{state ? `${yen.format(state.assets.totalJpy)}円` : "読み込み中"}</p></Link>
      <Link className="portal-card portal-card-todo" href="/todo"><h2>To Do</h2><strong>{state?.todo.total ?? "—"}<small> 件</small></strong><p>{state ? `${state.todo.completed}件完了` : "読み込み中"}</p></Link>
      <Link className="portal-card" href="/settings/storage"><h2>使用量</h2><strong>R2 / D1</strong><p>保存容量・DB利用量・TextTube字幕API</p></Link>
    </section>
  </main>;
}
