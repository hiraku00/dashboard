import { Suspense, cache, type ReactNode } from "react";
import { PortalHeader } from "../../portal-nav";
import { dailyResetWindows } from "../../lib/usage-window";
import { R2_SOFT_LIMIT_BYTES } from "@/app/lib/r2-storage";
import { cloudflareAnalyticsUsage, d1BackedUsage, type D1BackedUsage } from "@/app/lib/queries/storage-usage";
import { TODO_TIMEZONE, todoDate } from "@/app/lib/todo-date";
import { MeasureButton } from "./measure-button";
import { WALLET2_TABLE_PREFIX, formatBytes, formatBytesDelta, type TableUsageSummary, type UsageGroupKey } from "@/app/lib/d1-table-usage";

const D1_DAILY_ROWS_READ_LIMIT = 5_000_000;
const D1_DAILY_ROWS_WRITTEN_LIMIT = 100_000;
const D1_STORAGE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
const TRANSCRIPT_LIMIT = 100;
const count = new Intl.NumberFormat("ja-JP");

// 上段の D1 のメーター3枚と、下段の「直近30日の合計」の両方が使う。cache() で1リクエスト1回にする
// (Cloudflare の外部 API で遅いので、2回呼ぶと画面がその分遅れる)。
const analytics = cache(cloudflareAnalyticsUsage);

function storageCategoryName(category: string) {
  if (category === "manage-asset/raw") return "Manage Asset 取得原本";
  if (category === "text-tube/videos") return "TextTube 保存済み本文";
  return category;
}

/** 主な保存データの行(D1)。名前は1行に収まる短さにする。records の無い行(台帳など)は件数を持たない。 */
const D1_ROWS: Array<{ group: UsageGroupKey; name: string; records?: keyof D1BackedUsage["databaseRecords"]; unit?: string }> = [
  { group: "watchList", name: "Watch List", records: "watchList" },
  { group: "manageAsset", name: "Manage Asset（ウォレット1）", records: "manageAsset" },
  { group: "manageAssetWallet2", name: "Manage Asset（ウォレット2）", records: "manageAssetWallet2" },
  { group: "textTube", name: "TextTube 動画", records: "textTube" },
  { group: "openchatNotes", name: "オプチャ ノート", records: "openchatNotes" },
  { group: "openchatComments", name: "オプチャ コメント", records: "openchatComments" },
  { group: "todoTasks", name: "To Do タスク", records: "todoTasks" },
  { group: "dailyReports", name: "作業日報", records: "dailyReports", unit: "日分" },
  { group: "system", name: "台帳・同期の記録など" },
];

// Server Component (Issue #72). d1BackedUsage() は D1 への直接クエリ(速い)なので
// ここで await し、R2・字幕API・主な保存データは最初の HTML に入れる。D1 の容量と
// 読み書き行数は Cloudflare の外部 Analytics API (一桁遅い) に依存するので、その部分
// だけ <Suspense> に分け、ページの残りを待たせない。
export default async function StoragePage() {
  const month = new Date().toISOString().slice(0, 7);
  const d1Query = await d1BackedUsage(month);
  const r2Used = d1Query.usage.bytes;
  const r2Growth = d1Query.categories.reduce((sum, row) => sum + Number(row.bytes) - Number(row.bytes_30d_ago ?? row.bytes), 0);
  const transcript = { month, ...d1Query.transcriptUsage };

  return (
    <main className="portal-shell">
      <PortalHeader title="使用量・上限" active="/settings/storage" />
      {!d1Query.ok && (
        <p className="notice usg-notice" role="alert">
          D1への直接クエリが失敗しています（{d1Query.error ?? "原因不明"}）。無料枠の日次上限を使い切っている可能性があります。D1の容量と読み書き行数（Cloudflare Analytics由来）は影響を受けません。
        </p>
      )}

      <section className="usg-overview" aria-labelledby="usg-overview-title">
        <h2 id="usg-overview-title" className="usg-section-title">上限に対する使用量</h2>
        <div className="usg-meters">
          <Meter
            className="r2-usage-panel"
            provider="R2"
            label="ファイル保存容量"
            value={formatBytes(r2Used)}
            max="8 GB"
            note="安全上限"
            pct={(r2Used / R2_SOFT_LIMIT_BYTES) * 100}
            sub={`30日で ${formatBytesDelta(r2Growth)}`}
          />
          <Suspense fallback={<><MeterSkeleton /><MeterSkeleton /><MeterSkeleton /></>}>
            <D1Meters />
          </Suspense>
          <Meter
            className="transcript-usage-panel"
            provider="Supadata"
            label={`字幕API（${Number(month.slice(5))}月）`}
            value={count.format(transcript.credits)}
            max={`${TRANSCRIPT_LIMIT}回`}
            note="毎月の目安"
            pct={(transcript.credits / TRANSCRIPT_LIMIT) * 100}
            sub={`取得試行 ${count.format(transcript.attempts)}回`}
          />
        </div>
      </section>

      <div className="usg-details">
        <section className="usg-card d1-usage-panel" aria-labelledby="usg-d1-title">
          <CardHeading provider="D1" title="データベースに保存しているもの" id="usg-d1-title" />
          <D1DataTable d1Query={d1Query} />
        </section>

        <div className="usg-side">
          <section className="usg-card" aria-labelledby="usg-r2-title">
            <CardHeading provider="R2" title="保存しているファイル" id="usg-r2-title" />
            {d1Query.categories.length ? (
              <table className="usg-table">
                <thead><tr><th scope="col">種類</th><th scope="col">件数</th><th scope="col">容量</th><th scope="col">30日の増加</th></tr></thead>
                <tbody>
                  {d1Query.categories.map((row) => (
                    <tr key={row.category as string}>
                      <th scope="row">{storageCategoryName(row.category as string)}</th>
                      <td>{count.format(Number(row.count))}</td>
                      <td>{formatBytes(Number(row.bytes))}</td>
                      <td className="usg-delta">{formatBytesDelta(Number(row.bytes) - Number(row.bytes_30d_ago ?? row.bytes))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="usg-empty">保存されたファイルはまだありません。</p>
            )}
          </section>

          <section className="usg-card" aria-labelledby="usg-transcript-title">
            <CardHeading
              provider="Supadata"
              title="字幕API"
              id="usg-transcript-title"
              action={<a className="usg-link" href="https://dash.supadata.ai" target="_blank" rel="noreferrer">Supadataで確認 ↗</a>}
            />
            <dl className="usg-facts">
              <div><dt>今月の消費</dt><dd>{count.format(transcript.credits)} クレジット</dd></div>
              <div><dt>取得試行</dt><dd>{count.format(transcript.attempts)} 回</dd></div>
              <div><dt>最終取得</dt><dd>
                {transcript.lastUsedAt
                  // サーバーで描くので timeZone を省くと Worker の UTC になる。ほかの日付表示と同じバンコク時間に固定して明記する。
                  ? `${new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: TODO_TIMEZONE }).format(new Date(transcript.lastUsedAt))}（バンコク）`
                  : "まだありません"}
              </dd></div>
            </dl>
          </section>

          <Suspense fallback={null}>
            <D1Last30Days />
          </Suspense>
        </div>
      </div>
    </main>
  );
}

function CardHeading({ provider, title, id, action }: { provider: string; title: string; id: string; action?: ReactNode }) {
  return (
    <header className="usg-card-heading">
      <div>
        <span className="usg-provider">{provider}</span>
        <h2 id={id}>{title}</h2>
      </div>
      {action}
    </header>
  );
}

/** 上段のメーター1枚。使用率で色を変える(50%未満=緑、80%未満=黄、それ以上=赤)。 */
/** 主数値の横に上限(max)を並べ、何に対する%かを同じ行で読めるようにする。note は上限の種類や戻る時刻などの補足。 */
function Meter({ provider, label, value, max, note, pct, sub, title, className }: {
  provider: string; label: string; value: string; max: string; note: string; pct: number; sub?: string; title?: string; className?: string;
}) {
  const clamped = Math.min(100, Math.max(0, pct));
  const level = pct >= 80 ? "is-danger" : pct >= 50 ? "is-warn" : "is-ok";
  const pctLabel = pct > 0 && pct < 0.01 ? "<0.01" : pct.toFixed(pct < 10 ? 2 : 1);
  return (
    <article className={`usg-meter ${level} ${className ?? ""}`} title={title}>
      <p className="usg-meter-label"><span className="usg-provider">{provider}</span>{label}</p>
      <p className="usg-meter-value"><strong>{value}</strong><span>/ {max}</span></p>
      <div className="usg-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(clamped.toFixed(2))} aria-label={`${label} ${pct.toFixed(2)}%`}>
        <span style={{ width: `${clamped}%` }} />
      </div>
      <p className="usg-meter-limit"><span>{note}</span><em>{pctLabel}%</em></p>
      {sub && <p className="usg-meter-sub">{sub}</p>}
    </article>
  );
}

function MeterSkeleton() {
  return <div className="usg-meter usg-skeleton" aria-hidden="true" />;
}

/** D1 の容量と、本日(UTC)の読み取り・書き込み行数を、それぞれの上限と並べる。 */
async function D1Meters() {
  const d1 = await analytics();
  if (!d1.configured) {
    return (
      <article className="usg-meter usg-meter-wide">
        <p className="usg-meter-label"><span className="usg-provider">D1</span>データベース（Analytics未設定）</p>
        <p className="usg-empty">Cloudflare Analyticsの読み取り専用トークンを設定すると、D1の容量と本日の読み書き行数を表示します。</p>
      </article>
    );
  }
  // 日次上限は UTC 0時に戻る。こちらの朝(日本9時・バンコク7時)より前の分は前日に数えられるので、期間をツールチップで示す。
  const windows = dailyResetWindows(d1.today.date).map((window) => `${window.label} ${window.start}〜${window.end}`).join("\n");
  const windowTitle = `本日の集計期間（UTC ${d1.today.date}）\n${windows}\nコレクタの同期もUTC基準（00:00〜02:30）なので、必ずこの期間に入ります。`;
  const avgRead = Math.round(d1.last30Days.rowsRead / 30);
  const avgWritten = Math.round(d1.last30Days.rowsWritten / 30);
  return (
    <>
      <Meter
        provider="D1"
        label="データベース容量"
        value={formatBytes(d1.storageBytes)}
        max="5 GB"
        note="無料枠"
        pct={(d1.storageBytes / D1_STORAGE_LIMIT_BYTES) * 100}
      />
      <Meter
        provider="D1"
        label="本日の読み取り"
        value={count.format(d1.today.rowsRead)}
        max="500万行"
        note="UTC 0時に戻る"
        pct={(d1.today.rowsRead / D1_DAILY_ROWS_READ_LIMIT) * 100}
        sub={`30日平均 ${count.format(avgRead)}行/日（${((avgRead / D1_DAILY_ROWS_READ_LIMIT) * 100).toFixed(1)}%）`}
        title={windowTitle}
      />
      <Meter
        provider="D1"
        label="本日の書き込み"
        value={count.format(d1.today.rowsWritten)}
        max="10万行"
        note="UTC 0時に戻る"
        pct={(d1.today.rowsWritten / D1_DAILY_ROWS_WRITTEN_LIMIT) * 100}
        sub={`30日平均 ${count.format(avgWritten)}行/日（${((avgWritten / D1_DAILY_ROWS_WRITTEN_LIMIT) * 100).toFixed(1)}%）`}
        title={windowTitle}
      />
    </>
  );
}

/** 直近30日の読み書きの合計(参考値)。日次上限との比較は上段のメーターでする。 */
async function D1Last30Days() {
  const d1 = await analytics();
  if (!d1.configured) return null;
  return (
    <section className="usg-card" aria-labelledby="usg-30d-title">
      <CardHeading provider="D1" title="直近30日の合計" id="usg-30d-title" />
      <dl className="usg-facts">
        <div><dt>読み取り行数</dt><dd>{count.format(d1.last30Days.rowsRead)}</dd></div>
        <div><dt>書き込み行数</dt><dd>{count.format(d1.last30Days.rowsWritten)}</dd></div>
        <div><dt>読み取りクエリ</dt><dd>{count.format(d1.last30Days.readQueries)}</dd></div>
        <div><dt>書き込みクエリ</dt><dd>{count.format(d1.last30Days.writeQueries)}</dd></div>
      </dl>
    </section>
  );
}

/** 主な保存データ。件数は今の D1、容量と増え方は1日1回の計測(app/lib/d1-table-usage.ts)。
 *  件数は Analytics の設定と無関係に出す(Issue #100)。 */
function D1DataTable({ d1Query }: { d1Query: D1BackedUsage }) {
  const usage: TableUsageSummary = d1Query.tableUsage;
  const measured = Boolean(usage.date);
  const growthHeader = usage.baseDate ? `${usage.days}日の増加` : null;
  return (
    <>
      <table className="usg-table">
        <caption className="usg-visually-hidden">主な保存データ</caption>
        <thead>
          <tr><th scope="col">データ</th><th scope="col">件数</th>{measured && <th scope="col">容量</th>}{growthHeader && <th scope="col">{growthHeader}</th>}</tr>
        </thead>
        <tbody>
          {D1_ROWS.filter((row) => row.records || measured).map((row) => {
            const entry = usage.groups.find((candidate) => candidate.key === row.group);
            const bytes = entry?.bytes ?? 0;
            return (
              <tr key={row.group}>
                <th scope="row">{row.name}</th>
                <td>{row.records ? `${count.format(d1Query.databaseRecords[row.records])}${row.unit ?? ""}` : "—"}</td>
                {measured && <td>{formatBytes(bytes)}</td>}
                {growthHeader && <td className="usg-delta">{entry?.baseBytes != null ? formatBytesDelta(bytes - entry.baseBytes) : "—"}</td>}
              </tr>
            );
          })}
        </tbody>
        {measured && (
          <tfoot>
            <tr>
              <th scope="row">合計</th>
              <td />
              <td>{formatBytes(usage.totalBytes)}</td>
              {growthHeader && <td className="usg-delta">{usage.baseTotalBytes !== null ? formatBytesDelta(usage.totalBytes - usage.baseTotalBytes) : "—"}</td>}
            </tr>
          </tfoot>
        )}
      </table>
      <div className="usg-measure-row">
        <p>{measured ? `容量は ${usage.date} 0時（バンコク）の計測` : "容量は毎日0時（バンコク）に計測します。まだ記録がありません。"}</p>
        {/* ウォレット2の計測がまだ無い日（足した日）は、今日の分をもう一度測れるようにする */}
        <MeasureButton measuredToday={usage.date === todoDate() && usage.groups.some((group) => group.key === "manageAssetWallet2")} />
      </div>
      {measured && (
        <details className="usg-more">
          <summary>テーブル別の内訳と計測のしかた</summary>
          <p>
            容量は毎日0時（バンコク）に、各テーブルの値の長さを足して出す概算です。索引やページの余白は含まないので、
            上のデータベース容量より小さく出ます。件数は今の値、容量と増加は計測した日の値です。
          </p>
          <table className="usg-table usg-table-raw">
            <thead><tr><th scope="col">テーブル</th><th scope="col">行数</th><th scope="col">容量</th>{growthHeader && <th scope="col">{growthHeader}</th>}</tr></thead>
            <tbody>
              {usage.groups.flatMap((group) => group.tables.map((table) => (
                <tr key={table.name}>
                  <th scope="row">{tableLabel(table.name)}</th>
                  <td>{count.format(table.rows)}</td>
                  <td>{formatBytes(table.bytes)}</td>
                  {growthHeader && <td className="usg-delta">{table.baseBytes === null ? "—" : formatBytesDelta(table.bytes - table.baseBytes)}</td>}
                </tr>
              )))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}

/** テーブル別の内訳の名前。ウォレット2の DB のテーブルは `wallet2.` を外して（ウォレット2）を付ける。 */
function tableLabel(name: string): string {
  return name.startsWith(WALLET2_TABLE_PREFIX) ? `${name.slice(WALLET2_TABLE_PREFIX.length)}（ウォレット2）` : name;
}
