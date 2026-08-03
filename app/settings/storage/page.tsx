"use client";

import { useEffect, useState } from "react";
import { PortalHeader } from "../../portal-nav";

type StorageData = {
  usage?: { bytes?: number };
  softLimitBytes?: number;
  categories?: Array<{ category: string; bytes: number; count: number }>;
  watchListItemCount?: number;
  transcriptUsage?: {
    month: string;
    credits: number;
    attempts: number;
    lastUsedAt: string | null;
  };
  d1?: {
    configured: boolean;
    storageBytes?: number;
    period?: { start: string; end: string };
    readQueries?: number;
    writeQueries?: number;
    rowsRead?: number;
    rowsWritten?: number;
  };
};

export default function StoragePage() {
  const [data, setData] = useState<StorageData | null>(null);
  useEffect(() => {
    fetch("/api/settings/storage")
      .then((response) => response.json())
      .then(setData);
  }, []);
  const used = Number(data?.usage?.bytes ?? 0);
  const limit = Number(data?.softLimitBytes ?? 1);
  const pct = Math.min(100, (used / limit) * 100);
  const transcript = data?.transcriptUsage;
  const d1 = data?.d1;
  const count = new Intl.NumberFormat("ja-JP");
  const d1StorageLimit = 5 * 1024 * 1024 * 1024;
  const d1StoragePct = Math.min(
    100,
    ((d1?.storageBytes ?? 0) / d1StorageLimit) * 100,
  );
  const transcriptLimit = 100;
  const transcriptPct = Math.min(
    100,
    ((transcript?.credits ?? 0) / transcriptLimit) * 100,
  );
  const storageCategoryName = (category: string) => {
    if (category === "manage-asset/raw") return "Manage Assetの取得原本";
    if (category === "text-tube/videos") return "TextTubeの保存済み本文";
    return category;
  };

  return (
    <main className="portal-shell">
      <PortalHeader title="使用量・上限" active="/settings/storage" />
      <div className="usage-page-stack">
      <section className="settings-panel usage-panel">
        <div className="panel-heading">
          <div>
            <p className="app-kicker">CLOUDFLARE · R2</p>
            <h2>保存容量</h2>
          </div>
          <span>安全上限 8 GB</span>
        </div>
        <div className="usage-primary">
          <strong>{(used / 1024 / 1024 / 1024).toFixed(2)} GB</strong>
          <span>使用率 {pct.toFixed(2)}%</span>
        </div>
        <div className="usage-meter" aria-label={`R2保存容量 ${pct.toFixed(2)}%`}>
          <div className="usage-bar"><span style={{ width: `${pct}%` }} /></div>
          <p>ファイルを保存する領域です。Watch Listはファイルを持たず、D1に記録します。</p>
        </div>
        <div className="usage-breakdown">
          <div className="usage-section-label">保存しているファイル</div>
        {data?.categories?.map((row) => (
          <div className="usage-row" key={row.category}>
            <span>{storageCategoryName(row.category)}</span>
            <strong>
              {(Number(row.bytes) / 1024 / 1024).toFixed(2)} MB · {row.count}{" "}
              件
            </strong>
          </div>
        ))}
        </div>
      </section>
      <section className="settings-panel usage-panel d1-usage-panel">
        <div className="panel-heading">
          <div>
            <p className="app-kicker">CLOUDFLARE · D1</p>
            <h2>データベース使用量</h2>
          </div>
          <span>{d1?.configured ? "直近30日" : "未設定"}</span>
        </div>
        {d1?.configured ? (
          <>
            <div className="usage-primary">
              <strong>
                {((d1.storageBytes ?? 0) / 1024 / 1024).toFixed(2)} MB
              </strong>
              <span>使用率 {d1StoragePct.toFixed(2)}%</span>
            </div>
            <div className="usage-meter" aria-label={`D1データベース容量 ${d1StoragePct.toFixed(2)}%`}>
              <div className="usage-bar"><span style={{ width: `${d1StoragePct}%` }} /></div>
              <p>保存対象: Watch List、Manage Asset、TextTubeのデータと履歴。</p>
              <p>無料枠: 5 GB · 読取500万行/日 · 書込10万行/日</p>
            </div>
            <div className="usage-metrics-grid">
              <div><span>読み取り行数</span><strong>{count.format(d1.rowsRead ?? 0)}</strong></div>
              <div><span>書き込み行数</span><strong>{count.format(d1.rowsWritten ?? 0)}</strong></div>
              <div><span>読み取りクエリ</span><strong>{count.format(d1.readQueries ?? 0)}</strong></div>
              <div><span>書き込みクエリ</span><strong>{count.format(d1.writeQueries ?? 0)}</strong></div>
            </div>
            <div className="usage-row usage-watch-list-row"><span>Watch Listに保存中</span><strong>{count.format(data?.watchListItemCount ?? 0)} 件</strong></div>
          </>
        ) : (
          <p className="muted-copy">Cloudflare Analyticsの読み取り専用トークンを設定すると、D1容量と直近30日の読み書き量を表示します。</p>
        )}
      </section>
      <section className="settings-panel usage-panel transcript-usage-panel">
        <div className="panel-heading">
          <div>
            <p className="app-kicker">TEXTTUBE · SUPADATA</p>
            <h2>字幕API使用量</h2>
          </div>
          <a
            className="secondary-button"
            href="https://dash.supadata.ai"
            target="_blank"
            rel="noreferrer"
          >
            Supadataで確認
          </a>
        </div>
        <div className="usage-primary">
          <strong>{transcript?.credits ?? 0} 回</strong>
          <span>無料枠の目安 100回/月</span>
        </div>
        <div className="usage-meter" aria-label={`字幕API使用量 ${transcriptPct.toFixed(2)}%`}>
          <div className="usage-bar"><span style={{ width: `${transcriptPct}%` }} /></div>
          <p>{transcript?.month ?? "今月"}の実消費。字幕取得は通常1回=1クレジットです。</p>
        </div>
        <div className="usage-breakdown">
          <div className="usage-row"><span>取得試行</span><strong>{transcript?.attempts ?? 0} 回</strong></div>
          <div className="usage-row"><span>最終取得</span><strong>
            {transcript?.lastUsedAt
              ? new Intl.DateTimeFormat("ja-JP", {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(transcript.lastUsedAt))
              : "まだありません"}
          </strong></div>
        </div>
      </section>
      </div>
    </main>
  );
}
