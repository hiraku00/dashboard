/** 作業日報の D1 への書き込み(docs/daily-report-ingest-design.md §5)。解析とタグ付けは
 *  daily-report-parse.ts / daily-report-tags.ts の純関数に任せ、ここは保存だけを受け持つ。
 *
 *  1日分は1回の DB.batch(トランザクション)で書くので、途中で失敗しても前の内容が残る。
 *  Workers 無料枠の「1回の呼び出しで50クエリまで」に収まるよう、1件につき batch は1回、
 *  行は1つの INSERT にまとめる(D1 の bind パラメーターは1文100個まで)。 */

import { env } from "cloudflare:workers";
import { PARSER_VERSION, parseDailyReport, type ParseStatus } from "./daily-report-parse.ts";
import { tagDailyReport } from "./daily-report-tags.ts";

/** 1リクエストの件数と1件の大きさの上限(現状の日報は最大約7KB) */
export const MAX_REPORTS_PER_REQUEST = 20;
export const MAX_MARKDOWN_BYTES = 64 * 1024;

/** 日付ごとに作り直す正規化・タグのテーブル */
const DERIVED_TABLES = ["daily_report_work_items", "daily_report_app_usage", "daily_report_time_blocks", "daily_report_notes", "daily_report_item_tags", "daily_report_tag_days"];

export type IngestResult = {
  date: string;
  status: "created" | "updated" | "skipped" | "error";
  parseStatus?: ParseStatus;
  warnings?: string[];
  error?: string;
};

type StoredRow = { report_date: string; sha256: string; parse_status: ParseStatus; parse_warnings: string };

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 実在する YYYY-MM-DD か(2026-02-30 のような日付は通さない) */
export function isReportDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 複数行を1つの INSERT にまとめる。1文の bind パラメーターが100個を超えないよう分ける。 */
function insertRows(table: string, columns: string[], rows: unknown[][]): D1PreparedStatement[] {
  const perStatement = Math.floor(100 / columns.length);
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",");
    statements.push(env.DB.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders}`).bind(...chunk.flat()));
  }
  return statements;
}

/** 1日分を解析・タグ付けし、書き込む文を作る。keepRevision なら差し替える前の原本を daily_report_revisions へ退避する。 */
function buildWrite(date: string, markdown: string, sha256: string, now: string, keepRevision: boolean) {
  const parsed = parseDailyReport(markdown, date);
  const { itemTags, tagDays } = tagDailyReport(parsed);
  const { header } = parsed;
  const statements: D1PreparedStatement[] = [];
  if (keepRevision) {
    statements.push(env.DB.prepare(`INSERT INTO daily_report_revisions (report_date,revision_number,markdown,sha256,replaced_at)
      SELECT report_date, COALESCE((SELECT MAX(revision_number) FROM daily_report_revisions WHERE report_date=?1),0)+1, markdown, sha256, ?2
      FROM daily_reports WHERE report_date=?1`).bind(date, now));
  }
  statements.push(env.DB.prepare(`INSERT INTO daily_reports (report_date,markdown,sha256,record_start,record_end,recorded_minutes,capture_count,capture_count_is_min,gap_minutes,parser_version,parse_status,parse_warnings,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(report_date) DO UPDATE SET markdown=excluded.markdown,sha256=excluded.sha256,record_start=excluded.record_start,record_end=excluded.record_end,
      recorded_minutes=excluded.recorded_minutes,capture_count=excluded.capture_count,capture_count_is_min=excluded.capture_count_is_min,gap_minutes=excluded.gap_minutes,
      parser_version=excluded.parser_version,parse_status=excluded.parse_status,parse_warnings=excluded.parse_warnings,updated_at=excluded.updated_at`)
    .bind(date, markdown, sha256, header.recordStart, header.recordEnd, header.recordedMinutes, header.captureCount, header.captureCountIsMin ? 1 : 0,
      parsed.gapMinutes, PARSER_VERSION, parsed.status, JSON.stringify(parsed.warnings), now, now));
  for (const table of DERIVED_TABLES) statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE report_date=?`).bind(date));
  statements.push(
    ...insertRows("daily_report_work_items", ["report_date", "position", "category_position", "category", "item_position", "text"],
      parsed.workItems.map((w) => [date, w.position, w.categoryPosition, w.category, w.itemPosition, w.text])),
    ...insertRows("daily_report_app_usage", ["report_date", "position", "app_name", "app_key", "usage_count", "usage_count_raw", "usage_is_min", "purpose"],
      parsed.appUsage.map((a) => [date, a.position, a.appName, a.appKey, a.usageCount, a.usageCountRaw, a.usageIsMin ? 1 : 0, a.purpose])),
    ...insertRows("daily_report_time_blocks", ["report_date", "position", "start_minute", "end_minute", "activity", "duration_minutes", "is_gap"],
      parsed.timeBlocks.map((b) => [date, b.position, b.startMinute, b.endMinute, b.activity, b.durationMinutes, b.isGap ? 1 : 0])),
    ...insertRows("daily_report_notes", ["report_date", "position", "text"], parsed.notes.map((text, position) => [date, position, text])),
    ...insertRows("daily_report_item_tags", ["report_date", "source", "position", "tag"], itemTags.map((t) => [date, t.source, t.position, t.tag])),
    ...insertRows("daily_report_tag_days", ["report_date", "tag", "minutes", "work_item_count"], tagDays.map((d) => [date, d.tag, d.minutes, d.workItemCount])),
  );
  return { parsed, statements };
}

/** POST /api/daily-reports の1件ずつの処理。入力の形の検証は呼び出し側で済ませておく。
 *  同じ本文(sha256)が登録済みなら何も書かない。1件の失敗はその件の error にして、ほかの件は続ける。 */
export async function ingestDailyReports(reports: Array<{ date: unknown; markdown: unknown }>): Promise<IngestResult[]> {
  const dates = reports.map((r) => r.date).filter(isReportDate);
  const stored = new Map<string, StoredRow>();
  if (dates.length) {
    const rows = await env.DB.prepare(`SELECT report_date,sha256,parse_status,parse_warnings FROM daily_reports WHERE report_date IN (${dates.map(() => "?").join(",")})`)
      .bind(...dates).all<StoredRow>();
    for (const row of rows.results ?? []) stored.set(row.report_date, row);
  }

  const results: IngestResult[] = [];
  for (const report of reports) {
    const date = typeof report.date === "string" ? report.date : String(report.date ?? "");
    if (!isReportDate(report.date)) {
      results.push({ date, status: "error", error: "dateはYYYY-MM-DDの実在する日付にしてください。" });
      continue;
    }
    if (typeof report.markdown !== "string" || !report.markdown.trim()) {
      results.push({ date, status: "error", error: "markdownが空です。" });
      continue;
    }
    if (new TextEncoder().encode(report.markdown).byteLength > MAX_MARKDOWN_BYTES) {
      results.push({ date, status: "error", error: `markdownは1件${MAX_MARKDOWN_BYTES / 1024}KBまでです。` });
      continue;
    }
    try {
      const sha256 = await sha256Hex(report.markdown);
      const existing = stored.get(date);
      if (existing?.sha256 === sha256) {
        results.push({ date, status: "skipped", parseStatus: existing.parse_status, warnings: parseWarnings(existing.parse_warnings) });
        continue;
      }
      const now = new Date().toISOString();
      const { parsed, statements } = buildWrite(date, report.markdown, sha256, now, Boolean(existing));
      await env.DB.batch(statements);
      // 同じリクエストに同じ日付が2回あっても、2回目を正しく判定できるようにする
      stored.set(date, { report_date: date, sha256, parse_status: parsed.status, parse_warnings: JSON.stringify(parsed.warnings) });
      results.push({ date, status: existing ? "updated" : "created", parseStatus: parsed.status, warnings: parsed.warnings });
    } catch (error) {
      console.error(error);
      results.push({ date, status: "error", error: error instanceof Error ? error.message : "保存に失敗しました。" });
    }
  }
  return results;
}

/** parser_version が古い日報を、D1 の原本から最大 limit 件だけ解析し直す。原本は変わらないので改訂は残さない。 */
export async function reparseDailyReports(limit = MAX_REPORTS_PER_REQUEST): Promise<{ reparsed: number; remaining: number }> {
  const rows = (await env.DB.prepare("SELECT report_date,markdown,sha256 FROM daily_reports WHERE parser_version < ? ORDER BY report_date LIMIT ?")
    .bind(PARSER_VERSION, limit).all<{ report_date: string; markdown: string; sha256: string }>()).results ?? [];
  for (const row of rows) {
    const { statements } = buildWrite(row.report_date, row.markdown, row.sha256, new Date().toISOString(), false);
    await env.DB.batch(statements);
  }
  const remaining = (await env.DB.prepare("SELECT COUNT(*) AS count FROM daily_reports WHERE parser_version < ?").bind(PARSER_VERSION).all<{ count: number }>()).results?.[0];
  return { reparsed: rows.length, remaining: Number(remaining?.count ?? 0) };
}

/** その日付の日報を、正規化・タグ・改訂も含めて消す。無ければ false。 */
export async function deleteDailyReport(date: string): Promise<boolean> {
  const results = await env.DB.batch([
    ...[...DERIVED_TABLES, "daily_report_revisions"].map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE report_date=?`).bind(date)),
    env.DB.prepare("DELETE FROM daily_reports WHERE report_date=?").bind(date),
  ]);
  return Number(results.at(-1)?.meta.changes ?? 0) > 0;
}

function parseWarnings(json: string): string[] {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}
