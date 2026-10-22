/** 作業日報の読み取り(D1呼び出しを伴うオーケストレーション層。docs/daily-report-view-design.md §8)。
 *  /daily-report の Server Component が呼ぶ。書き込みは app/lib/daily-report-store.ts にあり、ここには置かない。
 *  日次・週次・月次のどれでも periodView() の1回の env.DB.batch で読み、タブの中身はすべてここから作る
 *  (app/lib/daily-report-model.ts)。本文(markdown)は日次のときだけ、その日の1行を読む。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import type { PeriodRange } from "@/app/lib/daily-report-summary";
import type { PeriodView, ReportRow } from "@/app/lib/daily-report-model";

export type { PeriodView };

type Row = Record<string, unknown>;

const toNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const splitTags = (value: unknown): string[] => (typeof value === "string" && value ? value.split(",") : []);

function parseWarnings(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** 日報のある日付の一覧(昇順)。date の指定が無いとき、既定の期間を決めるのに使う。 */
export async function listReportDates(): Promise<string[]> {
  await ensureSchema({ seed: false });
  const rows = await env.DB.prepare("SELECT report_date FROM daily_reports ORDER BY report_date").all<{ report_date: string }>();
  return (rows.results ?? []).map((row) => row.report_date);
}

export async function periodView(period: PeriodRange): Promise<PeriodView> {
  await ensureSchema({ seed: false });
  const db = env.DB;
  const { from, to, prevFrom, trendFrom } = period;
  const statements = [
    db.prepare("SELECT report_date FROM daily_reports ORDER BY report_date"),
    db.prepare("SELECT report_date, record_start, record_end, recorded_minutes, capture_count, capture_count_is_min, gap_minutes, parse_status FROM daily_reports WHERE report_date BETWEEN ? AND ? ORDER BY report_date").bind(prevFrom, to),
    db.prepare("SELECT report_date, tag, minutes FROM daily_report_tag_days WHERE report_date BETWEEN ? AND ?").bind(trendFrom, to),
    db.prepare(`SELECT b.report_date, b.position, b.start_minute, b.end_minute, b.activity, b.duration_minutes, b.is_gap,
        (SELECT group_concat(t.tag) FROM daily_report_item_tags t WHERE t.report_date=b.report_date AND t.source='time' AND t.position=b.position) AS tags
      FROM daily_report_time_blocks b WHERE b.report_date BETWEEN ? AND ? ORDER BY b.report_date, b.position`).bind(from, to),
    db.prepare(`SELECT w.report_date, w.position, w.category_position, w.category, w.item_position, w.text,
        (SELECT group_concat(t.tag) FROM daily_report_item_tags t WHERE t.report_date=w.report_date AND t.source='work' AND t.position=w.position) AS tags
      FROM daily_report_work_items w WHERE w.report_date BETWEEN ? AND ? ORDER BY w.report_date, w.position`).bind(from, to),
    db.prepare("SELECT report_date, app_name, app_key, usage_count, usage_count_raw, usage_is_min, purpose FROM daily_report_app_usage WHERE report_date BETWEEN ? AND ? ORDER BY report_date, position").bind(from, to),
    db.prepare("SELECT report_date, text FROM daily_report_notes WHERE report_date BETWEEN ? AND ? ORDER BY report_date DESC, position").bind(from, to),
  ];
  if (period.range === "day") statements.push(db.prepare("SELECT markdown, parse_warnings FROM daily_reports WHERE report_date=?").bind(from));
  const [dates, reports, tagDays, blocks, workItems, apps, notes, original] = await db.batch<Row>(statements);

  const head = original?.results?.[0];
  return {
    reportDates: (dates.results ?? []).map((row) => String(row.report_date)),
    reports: (reports.results ?? []).map((row) => ({
      reportDate: String(row.report_date),
      recordStart: (row.record_start as string | null) ?? null,
      recordEnd: (row.record_end as string | null) ?? null,
      recordedMinutes: toNumber(row.recorded_minutes),
      captureCount: toNumber(row.capture_count),
      captureCountIsMin: Number(row.capture_count_is_min) === 1,
      gapMinutes: Number(row.gap_minutes ?? 0),
      parseStatus: row.parse_status as ReportRow["parseStatus"],
    })),
    tagDays: (tagDays.results ?? []).map((row) => ({ reportDate: String(row.report_date), tag: String(row.tag), minutes: Number(row.minutes ?? 0) })),
    blocks: (blocks.results ?? []).map((row) => ({
      reportDate: String(row.report_date),
      position: Number(row.position),
      startMinute: toNumber(row.start_minute),
      endMinute: toNumber(row.end_minute),
      activity: String(row.activity ?? ""),
      durationMinutes: toNumber(row.duration_minutes),
      isGap: Number(row.is_gap) === 1,
      tags: splitTags(row.tags),
    })),
    workItems: (workItems.results ?? []).map((row) => ({
      reportDate: String(row.report_date),
      position: Number(row.position),
      categoryPosition: Number(row.category_position),
      category: String(row.category ?? ""),
      itemPosition: Number(row.item_position),
      text: String(row.text ?? ""),
      tags: splitTags(row.tags),
    })),
    apps: (apps.results ?? []).map((row) => ({
      reportDate: String(row.report_date),
      appName: String(row.app_name),
      appKey: String(row.app_key),
      usageCount: toNumber(row.usage_count),
      usageCountRaw: String(row.usage_count_raw ?? ""),
      usageIsMin: Number(row.usage_is_min) === 1,
      purpose: String(row.purpose ?? ""),
    })),
    notes: (notes.results ?? []).map((row) => ({ reportDate: String(row.report_date), text: String(row.text) })),
    original: head ? { markdown: String(head.markdown ?? ""), warnings: parseWarnings(head.parse_warnings) } : null,
  };
}
