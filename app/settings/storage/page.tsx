"use client";

import { useEffect, useState } from "react";
import { PortalHeader } from "../../portal-nav";

type StorageData = { usage?: { bytes?: number }; softLimitBytes?: number; categories?: Array<{ category: string; bytes: number; count: number }> };

export default function StoragePage() { const [data,setData]=useState<StorageData | null>(null); useEffect(()=>{fetch("/api/settings/storage").then(r=>r.json()).then(setData);},[]); const used=Number(data?.usage?.bytes??0); const limit=Number(data?.softLimitBytes??1); const pct=Math.min(100,used/limit*100); return <main className="portal-shell"><PortalHeader kicker="SYSTEM SETTINGS" title="Storage" active="/settings/storage" /><section className="settings-panel"><div className="panel-heading"><div><p className="app-kicker">R2 SAFETY LIMIT</p><h2>保存容量</h2></div><span>{pct.toFixed(2)}%</span></div><div className="usage-bar"><span style={{width:`${pct}%`}} /></div><div className="usage-values"><strong>{(used/1024/1024/1024).toFixed(2)} GB</strong><span>安全上限 8.00 GB</span></div><p className="muted-copy">R2の無料枠を守るため、アプリ側で8GBを上限にしています。上限に到達すると、Manage Assetの原本保存やTextTubeの新規本文保存を停止します。</p>{data?.categories?.map((row)=><div className="usage-row" key={row.category}><span>{row.category}</span><strong>{(Number(row.bytes)/1024/1024).toFixed(2)} MB · {row.count} objects</strong></div>)}</section></main>; }
