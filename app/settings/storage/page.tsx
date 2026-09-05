"use client";

import { useEffect, useState } from "react";
import { PortalHeader } from "../../portal-nav";
import { dailyResetWindows } from "../../lib/usage-window";

type StorageData = {
  usage?: { bytes?: number };
  softLimitBytes?: number;
  categories?: Array<{ category: string; bytes: number; count: number }>;
  databaseRecords?: {
    watchList: number;
    manageAsset: number;
    textTube: number;
  };
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
    today?: { date: string; readQueries?: number; writeQueries?: number; rowsRead?: number; rowsWritten?: number };
    last30Days?: { readQueries?: number; writeQueries?: number; rowsRead?: number; rowsWritten?: number };
  };
  d1QueryOk?: boolean;
  d1QueryError?: string | null;
};

const D1_DAILY_ROWS_READ_LIMIT = 5_000_000;
const D1_DAILY_ROWS_WRITTEN_LIMIT = 100_000;

export default function StoragePage() {
  const [data, setData] = useState<StorageData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/settings/storage")
      .then(async (response) => {
        if (!response.ok) throw new Error("使用量を読み込めませんでした。");
        setData(await response.json());
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "読み込みに失敗しました。"));
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
  const todayRowsRead = d1?.today?.rowsRead ?? 0;
  const todayRowsWritten = d1?.today?.rowsWritten ?? 0;
  const todayReadPct = Math.min(100, (todayRowsRead / D1_DAILY_ROWS_READ_LIMIT) * 100);
  const todayWrittenPct = Math.min(100, (todayRowsWritten / D1_DAILY_ROWS_WRITTEN_LIMIT) * 100);
  const storageCategoryName = (category: string) => {
    if (category === "manage-asset/raw") return "Manage Assetの取得原本";
    if (category === "text-tube/videos") return "TextTubeの保存済み本文";
    return category;
  };

  return (
    <main className="portal-shell">
      <PortalHeader title="使用量・上限" active="/settings/storage" />
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="usage-page-stack">
      <section className="settings-panel usage-panel r2-usage-panel">
        <div className="panel-heading">
          <div>
            <p className="app-kicker usage-provider"><span>CLOUDFLARE</span><span>R2</span></p>
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
        <div className="usage-breakdown r2-breakdown">
          <div className="usage-section-label">保存しているファイル</div>
        {data?.categories?.length ? (
          data.categories.map((row) => (
            <div className="usage-row" key={row.category}>
              <span>{storageCategoryName(row.category)}</span>
              <strong>
                {(Number(row.bytes) / 1024 / 1024).toFixed(2)} MB · {row.count}{" "}
                件
              </strong>
            </div>
          ))
        ) : (
          <div className="usage-row"><span>保存されたファイルはまだありません</span></div>
        )}
        </div>
      </section>
      <section className="settings-panel usage-panel d1-usage-panel">
        <div className="panel-heading">
          <div>
            <p className="app-kicker usage-provider"><span>CLOUDFLARE</span><span>D1</span></p>
            <h2>データベース使用量</h2>
          </div>
          <span>{d1?.configured ? `本日 ${d1?.today?.date ?? ""}` : "未設定"}</span>
        </div>
        {d1?.configured ? (
          <>
            {data?.d1QueryOk === false && (
              <p className="notice" role="alert">
                D1への直接クエリが失敗しています（{data?.d1QueryError ?? "原因不明"}）。無料枠の日次上限を使い切っている可能性があります。以下のCloudflare Analytics由来の数値は影響を受けません。
              </p>
            )}
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
            <div className="usage-section-label">本日の利用状況（日次上限との対比）</div>
            {/* The counters reset at UTC 00:00, which is the middle of the
                morning here. Spelling the window out in local time is what
                makes a near-zero reading readable: just after the boundary
                almost nothing has been counted yet, and the overnight
                collector sync lands in the PREVIOUS day. */}
            <p className="usage-window-note">
              集計期間: {d1?.today?.date ?? ""}（UTC 00:00〜24:00）
              {dailyResetWindows(d1?.today?.date ?? "").map((window) => (
                <span key={window.label}>
                  {window.label}時間（{window.offsetLabel}）{window.start} 〜 {window.end}
                </span>
              ))}
              <span className="usage-window-caveat">
                コレクタの同期は 06:30〜07:50（バンコク）に走るため、07:00 より前の実行は前日分として計上されます。
              </span>
            </p>
            <div className="usage-meter" aria-label={`本日の読み取り行数 ${todayReadPct.toFixed(2)}%`}>
              <div className="usage-bar"><span style={{ width: `${todayReadPct}%` }} /></div>
              <p>読み取り {count.format(todayRowsRead)} / 5,000,000 行（{todayReadPct.toFixed(2)}%）</p>
            </div>
            <div className="usage-meter" aria-label={`本日の書き込み行数 ${todayWrittenPct.toFixed(2)}%`}>
              <div className="usage-bar"><span style={{ width: `${todayWrittenPct}%` }} /></div>
              <p>書き込み {count.format(todayRowsWritten)} / 100,000 行（{todayWrittenPct.toFixed(2)}%）</p>
            </div>
            <div className="usage-metrics-grid" aria-label="直近30日のD1利用状況（参考値・日次上限とは対比不可）">
              <div><span>読み取り行数（30日累計）</span><strong>{count.format(d1.last30Days?.rowsRead ?? 0)}</strong></div>
              <div><span>書き込み行数（30日累計）</span><strong>{count.format(d1.last30Days?.rowsWritten ?? 0)}</strong></div>
              <div><span>読み取りクエリ（30日累計）</span><strong>{count.format(d1.last30Days?.readQueries ?? 0)}</strong></div>
              <div><span>書き込みクエリ（30日累計）</span><strong>{count.format(d1.last30Days?.writeQueries ?? 0)}</strong></div>
            </div>
            <div className="usage-breakdown database-breakdown">
              <div className="usage-section-label">主な保存データ</div>
              <div className="usage-row"><span>Watch List</span><strong>{count.format(data?.databaseRecords?.watchList ?? 0)} 件</strong></div>
              <div className="usage-row"><span>Manage Assetのスナップショット</span><strong>{count.format(data?.databaseRecords?.manageAsset ?? 0)} 件</strong></div>
              <div className="usage-row"><span>TextTubeの動画</span><strong>{count.format(data?.databaseRecords?.textTube ?? 0)} 件</strong></div>
            </div>
          </>
        ) : (
          <p className="muted-copy">Cloudflare Analyticsの読み取り専用トークンを設定すると、D1容量と直近30日の読み書き量を表示します。</p>
        )}
      </section>
      <section className="settings-panel usage-panel transcript-usage-panel">
        <div className="panel-heading">
          <div>
            <p className="app-kicker usage-provider"><span>SUPADATA</span><span>TextTube</span></p>
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
