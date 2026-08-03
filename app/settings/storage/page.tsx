"use client";

import { useEffect, useState } from "react";
import { PortalHeader } from "../../portal-nav";

type StorageData = {
  usage?: { bytes?: number };
  softLimitBytes?: number;
  categories?: Array<{ category: string; bytes: number; count: number }>;
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

  return (
    <main className="portal-shell">
      <PortalHeader title="使用量" active="/settings/storage" />
      <div className="usage-page-stack">
      <section className="settings-panel usage-panel">
        <div className="panel-heading">
          <div>
            <h2>保存容量</h2>
          </div>
          <span>{pct.toFixed(2)}%</span>
        </div>
        <div className="usage-bar">
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="usage-primary">
          <strong>{(used / 1024 / 1024 / 1024).toFixed(2)} GB</strong>
          <span>安全上限 8.00 GB</span>
        </div>
        <p className="muted-copy">
          R2の無料枠を守るため、アプリ側で8GBを上限にしています。上限に到達すると、Manage
          Assetの原本保存やTextTubeの新規本文保存を停止します。
        </p>
        <div className="usage-breakdown">
        {data?.categories?.map((row) => (
          <div className="usage-row" key={row.category}>
            <span>{row.category}</span>
            <strong>
              {(Number(row.bytes) / 1024 / 1024).toFixed(2)} MB · {row.count}{" "}
              objects
            </strong>
          </div>
        ))}
        </div>
      </section>
      <section className="settings-panel usage-panel d1-usage-panel">
        <div className="panel-heading">
          <div>
            <p className="app-kicker">CLOUDFLARE D1</p>
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
              <span>現在の D1 サイズ</span>
            </div>
            <div className="usage-metrics-grid">
              <div><span>読み取り行数</span><strong>{count.format(d1.rowsRead ?? 0)}</strong></div>
              <div><span>書き込み行数</span><strong>{count.format(d1.rowsWritten ?? 0)}</strong></div>
              <div><span>読み取りクエリ</span><strong>{count.format(d1.readQueries ?? 0)}</strong></div>
              <div><span>書き込みクエリ</span><strong>{count.format(d1.writeQueries ?? 0)}</strong></div>
            </div>
          </>
        ) : (
          <p className="muted-copy">Cloudflare Analyticsの読み取り専用トークンを設定すると、D1容量と直近30日の読み書き量を表示します。</p>
        )}
      </section>
      <section className="settings-panel usage-panel transcript-usage-panel">
        <div className="panel-heading">
          <div>
            <p className="app-kicker">TEXTTUBE</p>
            <h2>字幕API 使用量</h2>
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
          <span>{transcript?.month ?? "---- --"} の実消費クレジット</span>
        </div>
        <p className="muted-copy">
          Supadataのレスポンスヘッダーに含まれる実消費量を記録しています。請求と上限はSupadataの無料プラン設定が最終的に制御します。
        </p>
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
