/** D1 のデータの容量を、テーブルごとに1日1回計測して d1_table_usage_daily に残す(使用量画面の「主な保存データ」)。
 *
 *  D1 は SQLite の dbstat(ページ単位の正確な容量)を使えない(2026-10-23に本番で確認: `no such table: dbstat`)。
 *  そこで各テーブルの全列の値の長さ(`length(CAST(列 AS BLOB))`)を足した**概算**を使う。索引・ページの余白・
 *  行の管理領域は含まないので、Cloudflare Analytics の D1 全体の容量より小さく出る。
 *
 *  全テーブルを全件読むので、画面を開くたびではなく、毎日0時(バンコク時間、UTC 17:00)の cron(worker/index.ts)、
 *  使用量画面の「今日の分を計測」ボタン(その日に計測済みなら測らない)、手動の /api/cron/reconcile-storage でだけ計測する。
 *  画面は記録を読むだけ(D1 の1日の読み取り上限を消費しないため)。記録の日付はアプリの1日の区切りと同じバンコク時間の日付。
 *
 *  worker/index.ts の scheduled からも呼ぶので、"cloudflare:workers" は import せず D1Database を受け取る
 *  (app/lib/storage-usage.ts と同じ理由)。グループ分けなどの純粋な部分は vitest の node project でテストする。 */

import { todoDate } from "./todo-date.ts";

export type TableUsageRow = { usageDate: string; tableName: string; rowCount: number; payloadBytes: number };

/** 計測しないテーブル: SQLite・D1 の内部表と、計測の記録そのもの */
function isMeasuredTable(name: string) {
  return /^[A-Za-z0-9_]+$/.test(name) && !name.startsWith("sqlite_") && !name.startsWith("_cf_") && name !== "d1_migrations";
}

/** 全テーブルの行数と値の長さの合計を測り、その日の行として記録する。D1 への呼び出しは3回+記録の1回。 */
export async function measureD1Tables(db: D1Database, now = new Date()): Promise<{ date: string; tables: TableUsageRow[] }> {
  const date = todoDate(now);
  const list = await db.prepare("PRAGMA table_list").all<{ schema: string; name: string; type: string }>();
  const tables = (list.results ?? []).filter((row) => row.schema === "main" && row.type === "table" && isMeasuredTable(row.name)).map((row) => row.name).sort();
  if (!tables.length) return { date, tables: [] };
  const infos = await db.batch<{ name: string }>(tables.map((table) => db.prepare(`PRAGMA table_info("${table}")`)));
  const sums = await db.batch<{ row_count: number; payload_bytes: number }>(
    tables.map((table, index) => {
      const columns = (infos[index].results ?? []).map((column) => column.name).filter((name) => /^[A-Za-z0-9_]+$/.test(name));
      const length = columns.length ? columns.map((column) => `COALESCE(length(CAST("${column}" AS BLOB)),0)`).join("+") : "0";
      return db.prepare(`SELECT COUNT(*) AS row_count, COALESCE(SUM(${length}),0) AS payload_bytes FROM "${table}"`);
    }),
  );
  const rows: TableUsageRow[] = tables.map((tableName, index) => ({
    usageDate: date,
    tableName,
    rowCount: Number(sums[index].results?.[0]?.row_count ?? 0),
    payloadBytes: Number(sums[index].results?.[0]?.payload_bytes ?? 0),
  }));
  const measuredAt = now.toISOString();
  await db.batch(rows.map((row) => db
    .prepare("INSERT INTO d1_table_usage_daily (usage_date,table_name,row_count,payload_bytes,measured_at) VALUES (?,?,?,?,?) ON CONFLICT(usage_date,table_name) DO UPDATE SET row_count=excluded.row_count,payload_bytes=excluded.payload_bytes,measured_at=excluded.measured_at")
    .bind(row.usageDate, row.tableName, row.rowCount, row.payloadBytes, measuredAt)));
  return { date, tables: rows };
}

/** 今日(バンコク時間の日付)の計測がもう記録されているか。「今日の分を計測」ボタンの可否に使う。 */
export async function measuredToday(db: D1Database, now = new Date()): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS found FROM d1_table_usage_daily WHERE usage_date = ? LIMIT 1").bind(todoDate(now)).first<{ found: number }>();
  return Boolean(row);
}

// ---- 画面用のまとめ(純粋) ----

/** 使用量画面の「主な保存データ」の行。行ごとに、どのテーブルの容量を足すかを決める。
 *  オプチャはノートとコメントの2行に分け、コメントの表だけをコメントの行に入れる。どれにも当たらない表は「台帳・管理」。 */
export type UsageGroupKey = "watchList" | "manageAsset" | "textTube" | "openchatNotes" | "openchatComments" | "todoTasks" | "dailyReports" | "system";

export const USAGE_GROUP_ORDER: UsageGroupKey[] = ["watchList", "manageAsset", "textTube", "openchatNotes", "openchatComments", "todoTasks", "dailyReports", "system"];

export function usageGroupOf(table: string): UsageGroupKey {
  if (table === "items" || table === "item_links" || table === "import_runs") return "watchList";
  if (table.startsWith("asset_")) return "manageAsset";
  if (table.startsWith("text_tube_")) return "textTube";
  if (table === "openchat_comments") return "openchatComments";
  if (table.startsWith("openchat_")) return "openchatNotes";
  if (table.startsWith("todo_")) return "todoTasks";
  if (table.startsWith("daily_report")) return "dailyReports";
  return "system";
}

export type UsageGroup = {
  key: UsageGroupKey;
  /** 最新の計測の容量の合計 */
  bytes: number;
  /** 比べる日の容量の合計(比べる日が無ければ null) */
  baseBytes: number | null;
  tables: { name: string; rows: number; bytes: number; baseBytes: number | null }[];
};

export type TableUsageSummary = {
  /** 最新の計測日。1回も計測していなければ null */
  date: string | null;
  /** 増え方を比べる日(最新の30日前以前で一番新しい日。無ければ最初の計測日)。最新と同じなら null */
  baseDate: string | null;
  days: number;
  totalBytes: number;
  baseTotalBytes: number | null;
  groups: UsageGroup[];
};

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** 最新の計測日と比べる日の行(どちらも d1_table_usage_daily)から、画面の行の形にまとめる。 */
export function summarizeTableUsage(rows: TableUsageRow[]): TableUsageSummary {
  const dates = [...new Set(rows.map((row) => row.usageDate))].sort();
  const date = dates.at(-1) ?? null;
  const base = dates.length > 1 ? dates[0] : null;
  const latestRows = rows.filter((row) => row.usageDate === date);
  const baseByTable = new Map(rows.filter((row) => row.usageDate === base).map((row) => [row.tableName, row.payloadBytes]));
  const groups = new Map<UsageGroupKey, UsageGroup>();
  for (const row of latestRows) {
    const key = usageGroupOf(row.tableName);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { key, bytes: 0, baseBytes: base ? 0 : null, tables: [] }));
    const baseBytes = base ? (baseByTable.get(row.tableName) ?? 0) : null;
    group.bytes += row.payloadBytes;
    if (baseBytes !== null) group.baseBytes = (group.baseBytes ?? 0) + baseBytes;
    group.tables.push({ name: row.tableName, rows: row.rowCount, bytes: row.payloadBytes, baseBytes });
  }
  for (const group of groups.values()) group.tables.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const ordered = USAGE_GROUP_ORDER.filter((key) => groups.has(key)).map((key) => groups.get(key)!);
  const totalBytes = ordered.reduce((sum, group) => sum + group.bytes, 0);
  return {
    date,
    baseDate: base,
    days: date && base ? daysBetween(base, date) : 0,
    totalBytes,
    baseTotalBytes: base ? ordered.reduce((sum, group) => sum + (group.baseBytes ?? 0), 0) : null,
    groups: ordered,
  };
}

/** バイト数を `1.23 MB` `456 KB` `12 B` に。 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

/** 増えた量を `+1.20 MB` `−3.0 KB` `±0 B` に。 */
export function formatBytesDelta(delta: number): string {
  if (Math.round(delta) === 0) return "±0 B";
  return `${delta > 0 ? "+" : "−"}${formatBytes(Math.abs(delta))}`;
}
