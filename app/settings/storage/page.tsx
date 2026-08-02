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

  return (
    <main className="portal-shell">
      <PortalHeader title="使用量" active="/settings/storage" />
      <section className="settings-panel">
        <div className="panel-heading">
          <div>
            <h2>保存容量</h2>
          </div>
          <span>{pct.toFixed(2)}%</span>
        </div>
        <div className="usage-bar">
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="usage-values">
          <strong>{(used / 1024 / 1024 / 1024).toFixed(2)} GB</strong>
          <span>安全上限 8.00 GB</span>
        </div>
        <p className="muted-copy">
          R2の無料枠を守るため、アプリ側で8GBを上限にしています。上限に到達すると、Manage
          Assetの原本保存やTextTubeの新規本文保存を停止します。
        </p>
        {data?.categories?.map((row) => (
          <div className="usage-row" key={row.category}>
            <span>{row.category}</span>
            <strong>
              {(Number(row.bytes) / 1024 / 1024).toFixed(2)} MB · {row.count}{" "}
              objects
            </strong>
          </div>
        ))}
      </section>
      <section className="settings-panel transcript-usage-panel">
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
        <div className="usage-values">
          <strong>{transcript?.credits ?? 0} 回</strong>
          <span>{transcript?.month ?? "---- --"} の実消費クレジット</span>
        </div>
        <p className="muted-copy">
          Supadataのレスポンスヘッダーに含まれる実消費量を記録しています。請求と上限はSupadataの無料プラン設定が最終的に制御します。
        </p>
        <div className="usage-row">
          <span>取得試行</span>
          <strong>{transcript?.attempts ?? 0} 回</strong>
        </div>
        <div className="usage-row">
          <span>最終取得</span>
          <strong>
            {transcript?.lastUsedAt
              ? new Intl.DateTimeFormat("ja-JP", {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(transcript.lastUsedAt))
              : "まだありません"}
          </strong>
        </div>
      </section>
    </main>
  );
}
