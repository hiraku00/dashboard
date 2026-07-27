"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PortalHeader } from "./portal-nav";

type PortalState = {
  watch: { total: number; completed: number };
  textTube: { total: number; latest: { id: string; title: string; channel_name: string } | null };
  assets: { totalUsd: number; totalJpy: number; latestAt: string | null; sourceCount: number };
};

const yen = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function PortalHome() {
  const [state, setState] = useState<PortalState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { fetch("/api/portal/summary").then(async (response) => { if (!response.ok) throw new Error("ポータル情報を読み込めませんでした。"); setState(await response.json()); }).catch((reason) => setError(reason instanceof Error ? reason.message : "読み込みに失敗しました。")); }, []);
  return <main className="portal-shell">
    <PortalHeader title="Personal Portal" active="/" />
    <section className="portal-intro"><div><p className="app-kicker">ONE PLACE FOR MY SYSTEMS</p><h2>今の状態を、ひと目で。</h2><p>鑑賞リスト、読むための動画、資産の最新スナップショットをここから開けます。</p></div><span className="portal-orb" aria-hidden="true" /></section>
    {error && <p className="notice" role="alert">{error}</p>}
    <section className="portal-cards" aria-label="サービス概要">
      <Link className="portal-card portal-card-watch" href="/watch-list"><span className="card-eyebrow">LIBRARY</span><h3>Watch List</h3><strong>{state?.watch.total ?? "—"}<small> 件</small></strong><p>{state ? `${state.watch.completed}件を完了` : "読み込み中"}</p><span className="card-arrow">開く →</span></Link>
      <Link className="portal-card portal-card-text" href="/text-tube"><span className="card-eyebrow">READING ROOM</span><h3>TextTube</h3><strong>{state?.textTube.total ?? "—"}<small> 本</small></strong><p>{state?.textTube.latest ? `最新：${state.textTube.latest.title}` : "動画の要約・スクリプト"}</p><span className="card-arrow">開く →</span></Link>
      <Link className="portal-card portal-card-asset" href="/manage-asset"><span className="card-eyebrow">PRIVATE LEDGER</span><h3>Manage Asset</h3><strong>{state ? usd.format(state.assets.totalUsd) : "—"}</strong><p>{state ? `${yen.format(state.assets.totalJpy)}円 / ${state.assets.sourceCount} sources` : "読み込み中"}</p><span className="card-arrow">開く →</span></Link>
    </section>
    <section className="portal-status"><div><span>最終資産同期</span><strong>{state?.assets.latestAt ? new Date(state.assets.latestAt).toLocaleString("ja-JP") : "未同期"}</strong></div><div><span>データの所在</span><strong>Cloudflare D1 / R2</strong></div><div><span>認証</span><strong>Cloudflare Access</strong></div></section>
  </main>;
}
