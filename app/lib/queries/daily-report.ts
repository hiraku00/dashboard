/** 作業日報の読み取り(D1呼び出しを伴うオーケストレーション層。docs/daily-report-view-design.md §9.1)。
 *  /daily-report/:date の Server Component が呼ぶ。書き込みは app/lib/daily-report-store.ts にあり、
 *  ここには置かない。1画面=1回の env.DB.batch で読み、本文(markdown)は当日の1行だけ読む。
 *  集計・並べ替えは app/lib/daily-report-summary.ts の純関数に任せる。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { addDays, weekDates, type TimelineBlockInput, type WorkItemInput } from "@/app/lib/daily-report-summary";

/** 「この日が普段と比べてどうか」の相手にする、直前の日数 */
export const BASELINE_DAYS = 28;

export type DayReport = {
  reportDate: string;
  markdown: string;
  recordStart: string | null;
  recordEnd: string | null;
  recordedMinutes: number | null;
  captureCount: number | null;
  captureCountIsMin: boolean;
  gapMinutes: number;
  parseStatus: "ok" | "partial" | "failed";
  warnings: string[];
};

export type WeekDay = {
  date: string;
  /** 日報の行があるか(parse_status が failed でも true) */
  hasReport: boolean;
  parseStatus: "ok" | "partial" | "failed" | null;
  /** その日のタグの分数の合計(活動時間) */
  activeMinutes: number;
  blocks: TimelineBlockInput[];
};

export type DayView = {
  date: string;
  report: DayReport | null;
  /** 前後の日報のある日(欠けた日は飛ばす) */
  prevDate: string | null;
  nextDate: string | null;
  week: WeekDay[];
  /** 当日のタグ別の分数 */
  tagMinutes: Record<string, number>;
  /** 直前 BASELINE_DAYS 日の、日報のある日の1日平均。日報が1日も無ければ null */
  baseline: { days: number; minutes: Record<string, number> } | null;
  workItems: WorkItemInput[];
  apps: { appName: string; usageCount: number | null; usageCountRaw: string; usageIsMin: boolean; purpose: string }[];
  notes: string[];
};

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

/** 取り込み済みの最新の日報の日付。1つも無ければ null。 */
export async function latestReportDate(): Promise<string | null> {
  await ensureSchema({ seed: false });
  const row = await env.DB.prepare("SELECT MAX(report_date) AS latest FROM daily_reports").first<{ latest: string | null }>();
  return row?.latest ?? null;
}

export async function dayView(date: string): Promise<DayView> {
  await ensureSchema({ seed: false });
  const week = weekDates(date);
  const baselineFrom = addDays(date, -BASELINE_DAYS);
  const baselineTo = addDays(date, -1);
  const db = env.DB;
  const [report, neighbours, weekReports, weekActive, weekBlocks, dayTagDays, baselineRows, itemTags, workItems, apps, notes] = await db.batch<Row>([
    db.prepare("SELECT * FROM daily_reports WHERE report_date=?").bind(date),
    db.prepare("SELECT (SELECT MAX(report_date) FROM daily_reports WHERE report_date<?) AS prev, (SELECT MIN(report_date) FROM daily_reports WHERE report_date>?) AS next").bind(date, date),
    db.prepare("SELECT report_date, parse_status FROM daily_reports WHERE report_date BETWEEN ? AND ?").bind(week[0], week[6]),
    db.prepare("SELECT report_date, SUM(minutes) AS minutes FROM daily_report_tag_days WHERE report_date BETWEEN ? AND ? GROUP BY report_date").bind(week[0], week[6]),
    db.prepare(`SELECT b.report_date, b.position, b.start_minute, b.end_minute, b.activity, b.duration_minutes, b.is_gap,
        (SELECT group_concat(t.tag) FROM daily_report_item_tags t WHERE t.report_date=b.report_date AND t.source='time' AND t.position=b.position) AS tags
      FROM daily_report_time_blocks b WHERE b.report_date BETWEEN ? AND ? ORDER BY b.report_date, b.position`).bind(week[0], week[6]),
    db.prepare("SELECT tag, minutes FROM daily_report_tag_days WHERE report_date=?").bind(date),
    db.prepare("SELECT report_date, tag, minutes FROM daily_report_tag_days WHERE report_date BETWEEN ? AND ?").bind(baselineFrom, baselineTo),
    db.prepare("SELECT position, tag FROM daily_report_item_tags WHERE report_date=? AND source='work'").bind(date),
    db.prepare("SELECT position, category_position, category, item_position, text FROM daily_report_work_items WHERE report_date=? ORDER BY position").bind(date),
    db.prepare("SELECT app_name, usage_count, usage_count_raw, usage_is_min, purpose FROM daily_report_app_usage WHERE report_date=? ORDER BY position").bind(date),
    db.prepare("SELECT text FROM daily_report_notes WHERE report_date=? ORDER BY position").bind(date),
  ]);

  const head = report.results?.[0];
  const edges = neighbours.results?.[0];

  const reportByDate = new Map((weekReports.results ?? []).map((row) => [String(row.report_date), row]));
  const activeByDate = new Map((weekActive.results ?? []).map((row) => [String(row.report_date), Number(row.minutes ?? 0)]));
  const blocksByDate = new Map<string, TimelineBlockInput[]>();
  for (const row of weekBlocks.results ?? []) {
    const key = String(row.report_date);
    const list = blocksByDate.get(key) ?? [];
    list.push({
      position: Number(row.position),
      startMinute: toNumber(row.start_minute),
      endMinute: toNumber(row.end_minute),
      activity: String(row.activity ?? ""),
      durationMinutes: toNumber(row.duration_minutes),
      isGap: Number(row.is_gap) === 1,
      tags: splitTags(row.tags),
    });
    blocksByDate.set(key, list);
  }

  const baselineByDate = new Map<string, Record<string, number>>();
  for (const row of baselineRows.results ?? []) {
    const key = String(row.report_date);
    const day = baselineByDate.get(key) ?? {};
    day[String(row.tag)] = (day[String(row.tag)] ?? 0) + Number(row.minutes ?? 0);
    baselineByDate.set(key, day);
  }
  let baseline: DayView["baseline"] = null;
  if (baselineByDate.size) {
    const minutes: Record<string, number> = {};
    for (const day of baselineByDate.values()) for (const [tag, value] of Object.entries(day)) minutes[tag] = (minutes[tag] ?? 0) + value;
    for (const tag of Object.keys(minutes)) minutes[tag] /= baselineByDate.size;
    baseline = { days: baselineByDate.size, minutes };
  }

  const tagsByWorkPosition = new Map<number, string[]>();
  for (const row of itemTags.results ?? []) {
    const position = Number(row.position);
    tagsByWorkPosition.set(position, [...(tagsByWorkPosition.get(position) ?? []), String(row.tag)]);
  }

  return {
    date,
    report: head
      ? {
          reportDate: String(head.report_date),
          markdown: String(head.markdown ?? ""),
          recordStart: (head.record_start as string | null) ?? null,
          recordEnd: (head.record_end as string | null) ?? null,
          recordedMinutes: toNumber(head.recorded_minutes),
          captureCount: toNumber(head.capture_count),
          captureCountIsMin: Number(head.capture_count_is_min) === 1,
          gapMinutes: Number(head.gap_minutes ?? 0),
          parseStatus: head.parse_status as DayReport["parseStatus"],
          warnings: parseWarnings(head.parse_warnings),
        }
      : null,
    prevDate: (edges?.prev as string | null) ?? null,
    nextDate: (edges?.next as string | null) ?? null,
    week: week.map((day) => {
      const row = reportByDate.get(day);
      return {
        date: day,
        hasReport: Boolean(row),
        parseStatus: (row?.parse_status as WeekDay["parseStatus"]) ?? null,
        activeMinutes: activeByDate.get(day) ?? 0,
        blocks: blocksByDate.get(day) ?? [],
      };
    }),
    tagMinutes: Object.fromEntries((dayTagDays.results ?? []).map((row) => [String(row.tag), Number(row.minutes ?? 0)])),
    baseline,
    workItems: (workItems.results ?? []).map((row) => ({
      position: Number(row.position),
      categoryPosition: Number(row.category_position),
      category: String(row.category ?? ""),
      itemPosition: Number(row.item_position),
      text: String(row.text ?? ""),
      tags: tagsByWorkPosition.get(Number(row.position)) ?? [],
    })),
    apps: (apps.results ?? []).map((row) => ({
      appName: String(row.app_name),
      usageCount: toNumber(row.usage_count),
      usageCountRaw: String(row.usage_count_raw ?? ""),
      usageIsMin: Number(row.usage_is_min) === 1,
      purpose: String(row.purpose ?? ""),
    })),
    notes: (notes.results ?? []).map((row) => String(row.text)),
  };
}
