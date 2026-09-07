import { Suspense } from "react";
import { PortalHeader } from "../../portal-nav";
import { dailyResetWindows } from "../../lib/usage-window";
import { R2_SOFT_LIMIT_BYTES } from "@/app/lib/portal";
import { cloudflareAnalyticsUsage, d1BackedUsage, type D1BackedUsage } from "@/app/lib/queries/storage-usage";

const D1_DAILY_ROWS_READ_LIMIT = 5_000_000;
const D1_DAILY_ROWS_WRITTEN_LIMIT = 100_000;
const D1_STORAGE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
const TRANSCRIPT_LIMIT = 100;
const count = new Intl.NumberFormat("ja-JP");

function storageCategoryName(category: string) {
  if (category === "manage-asset/raw") return "Manage Assetの取得原本";
  if (category === "text-tube/videos") return "TextTubeの保存済み本文";
  return category;
}

// Server Component (Issue #72). d1BackedUsage() is direct D1 I/O (fast) and
// is awaited here so the R2/Supadata panels and the D1 panel's own "主な保存
// データ" record counts are in the very first byte of HTML. The D1 panel's
// storage/read-write meters depend on Cloudflare's external Analytics API
// instead (an order of magnitude slower -- see
// app/lib/queries/storage-usage.ts), so that fetch is isolated inside
// <D1AnalyticsPanel> under its own <Suspense> boundary: the rest of the page
// does not wait on it, the same way it never waited on the R2/Supadata data
// either.
export default async function StoragePage() {
  const month = new Date().toISOString().slice(0, 7);
  const d1Query = await d1BackedUsage(month);
  const used = d1Query.usage.bytes;
  const pct = Math.min(100, (used / R2_SOFT_LIMIT_BYTES) * 100);
  const transcript = { month, ...d1Query.transcriptUsage };
  const transcriptPct = Math.min(100, (transcript.credits / TRANSCRIPT_LIMIT) * 100);

  return (
    <main className="portal-shell">
      <PortalHeader title="使用量・上限" active="/settings/storage" />
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
            {d1Query.categories.length ? (
              d1Query.categories.map((row) => (
                <div className="usage-row" key={row.category as string}>
                  <span>{storageCategoryName(row.category as string)}</span>
                  <strong>
                    {(Number(row.bytes) / 1024 / 1024).toFixed(2)} MB · {row.count as number} 件
                  </strong>
                </div>
              ))
            ) : (
              <div className="usage-row"><span>保存されたファイルはまだありません</span></div>
            )}
          </div>
        </section>

        <Suspense fallback={<D1PanelSkeleton />}>
          <D1AnalyticsPanel d1Query={d1Query} />
        </Suspense>

        <section className="settings-panel usage-panel transcript-usage-panel">
          <div className="panel-heading">
            <div>
              <p className="app-kicker usage-provider"><span>SUPADATA</span><span>TextTube</span></p>
              <h2>字幕API使用量</h2>
            </div>
            <a className="secondary-button" href="https://dash.supadata.ai" target="_blank" rel="noreferrer">
              Supadataで確認
            </a>
          </div>
          <div className="usage-primary">
            <strong>{transcript.credits} 回</strong>
            <span>無料枠の目安 100回/月</span>
          </div>
          <div className="usage-meter" aria-label={`字幕API使用量 ${transcriptPct.toFixed(2)}%`}>
            <div className="usage-bar"><span style={{ width: `${transcriptPct}%` }} /></div>
            <p>{transcript.month}の実消費。字幕取得は通常1回=1クレジットです。</p>
          </div>
          <div className="usage-breakdown">
            <div className="usage-row"><span>取得試行</span><strong>{transcript.attempts} 回</strong></div>
            <div className="usage-row"><span>最終取得</span><strong>
              {transcript.lastUsedAt
                // Rendered on the server now (Issue #72), so an unspecified
                // timeZone would use the Worker's own zone (UTC), not the
                // viewer's -- unlike the pre-RSC client-rendered version,
                // which always matched whichever timezone the viewer's own
                // device was set to. Pinned to Asia/Bangkok (this app's
                // other date displays -- todoDate(), dailyResetWindows() --
                // already assume it) and labeled explicitly so a viewer
                // reading this from a different timezone is not misled into
                // thinking it's their own local time.
                ? `${new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(transcript.lastUsedAt))}（バンコク時間）`
                : "まだありません"}
            </strong></div>
          </div>
        </section>
      </div>
    </main>
  );
}

function D1PanelSkeleton() {
  return (
    <section className="settings-panel usage-panel d1-usage-panel">
      <div className="panel-heading">
        <div>
          <p className="app-kicker usage-provider"><span>CLOUDFLARE</span><span>D1</span></p>
          <h2>データベース使用量</h2>
        </div>
      </div>
      <div className="usage-skeleton" aria-hidden="true" />
    </section>
  );
}

async function D1AnalyticsPanel({ d1Query }: { d1Query: D1BackedUsage }) {
  const d1 = await cloudflareAnalyticsUsage();
  const todayRowsRead = d1.configured ? d1.today.rowsRead : 0;
  const todayRowsWritten = d1.configured ? d1.today.rowsWritten : 0;
  const d1StoragePct = Math.min(100, ((d1.configured ? d1.storageBytes : 0) / D1_STORAGE_LIMIT_BYTES) * 100);
  const todayReadPct = Math.min(100, (todayRowsRead / D1_DAILY_ROWS_READ_LIMIT) * 100);
  const todayWrittenPct = Math.min(100, (todayRowsWritten / D1_DAILY_ROWS_WRITTEN_LIMIT) * 100);

  return (
    <section className="settings-panel usage-panel d1-usage-panel">
      <div className="panel-heading">
        <div>
          <p className="app-kicker usage-provider"><span>CLOUDFLARE</span><span>D1</span></p>
          <h2>データベース使用量</h2>
        </div>
        <span>{d1.configured ? `本日 ${d1.today.date}` : "未設定"}</span>
      </div>
      {d1.configured ? (
        <>
          {!d1Query.ok && (
            <p className="notice" role="alert">
              D1への直接クエリが失敗しています（{d1Query.error ?? "原因不明"}）。無料枠の日次上限を使い切っている可能性があります。以下のCloudflare Analytics由来の数値は影響を受けません。
            </p>
          )}
          <div className="usage-primary">
            <strong>{(d1.storageBytes / 1024 / 1024).toFixed(2)} MB</strong>
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
            集計期間: {d1.today.date}（UTC 00:00〜24:00）
            {dailyResetWindows(d1.today.date).map((window) => (
              <span key={window.label}>
                {window.label}時間（{window.offsetLabel}）{window.start} 〜 {window.end}
              </span>
            ))}
            <span className="usage-window-caveat">
              コレクタの同期もUTC基準（00:00〜02:50）で動くため、必ずこの集計期間の中に入ります。
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
            <div><span>読み取り行数（30日累計）</span><strong>{count.format(d1.configured ? d1.last30Days.rowsRead : 0)}</strong></div>
            <div><span>書き込み行数（30日累計）</span><strong>{count.format(d1.configured ? d1.last30Days.rowsWritten : 0)}</strong></div>
            <div><span>読み取りクエリ（30日累計）</span><strong>{count.format(d1.configured ? d1.last30Days.readQueries : 0)}</strong></div>
            <div><span>書き込みクエリ（30日累計）</span><strong>{count.format(d1.configured ? d1.last30Days.writeQueries : 0)}</strong></div>
          </div>
          <div className="usage-breakdown database-breakdown">
            <div className="usage-section-label">主な保存データ</div>
            <div className="usage-row"><span>Watch List</span><strong>{count.format(d1Query.databaseRecords.watchList)} 件</strong></div>
            <div className="usage-row"><span>Manage Assetのスナップショット</span><strong>{count.format(d1Query.databaseRecords.manageAsset)} 件</strong></div>
            <div className="usage-row"><span>TextTubeの動画</span><strong>{count.format(d1Query.databaseRecords.textTube)} 件</strong></div>
          </div>
        </>
      ) : (
        <p className="muted-copy">Cloudflare Analyticsの読み取り専用トークンを設定すると、D1容量と直近30日の読み書き量を表示します。</p>
      )}
    </section>
  );
}
