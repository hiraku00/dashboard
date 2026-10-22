/** /daily-report の画面に渡す形(タブの中身)を、D1から読んだ行(app/lib/queries/daily-report.ts の PeriodView)
 *  から組み立てる。D1に触れない純粋なロジックで、サーバーで1回だけ呼ぶ(クライアントには集計済みの形だけを渡す)。
 *  docs/daily-report-view-design.md §4・§6.2。 */

import {
  RANGES,
  appSummaries,
  axisRange,
  breakdown,
  categoryShares,
  dailyColumns,
  datesBetween,
  groupDayWorkItems,
  headingSummaries,
  hourProfile,
  perDayAverages,
  periodRange,
  shiftAnchor,
  sumTags,
  switchRange,
  timelineSegments,
  trendSeries,
  weekdayAverages,
  type AppSummary,
  type AppUsageInput,
  type BreakdownCategory,
  type CategoryShare,
  type DayColumn,
  type HeadingSummary,
  type PeriodRange,
  type Range,
  type TagDayRow,
  type TimeAxis,
  type TimelineBlockInput,
  type TimelineSegment,
  type TrendPoint,
  type WorkItemGroup,
  type WorkItemInput,
} from "./daily-report-summary.ts";

export type ReportRow = {
  reportDate: string;
  recordStart: string | null;
  recordEnd: string | null;
  recordedMinutes: number | null;
  captureCount: number | null;
  captureCountIsMin: boolean;
  gapMinutes: number;
  parseStatus: "ok" | "partial" | "failed";
};

export type PeriodView = {
  /** 日報のある日付の一覧(昇順、全期間)。カレンダー・前後移動・単位の切り替えに使う */
  reportDates: string[];
  /** prevFrom〜to の日報(本文以外) */
  reports: ReportRow[];
  /** trendFrom〜to のタグ×日 */
  tagDays: TagDayRow[];
  /** from〜to の時間帯(タグ付き) */
  blocks: (TimelineBlockInput & { reportDate: string })[];
  workItems: WorkItemInput[];
  apps: AppUsageInput[];
  notes: { reportDate: string; text: string }[];
  /** 日次のときだけ: その日の本文と解析時の警告 */
  original: { markdown: string; warnings: string[] } | null;
};

export type HeroItem = { label: string; value: string; sub?: string };

export type DailyReportModel = {
  period: PeriodRange;
  today: string;
  reportDates: string[];
  nav: {
    prev: string | null;
    next: string | null;
    /** 今日を含む期間(「今日へ」「今週へ」「今月へ」) */
    current: string;
    /** 単位を替えたときの日付 */
    switchTo: Record<Range, string>;
  };
  /** 期間内の日報の日数 */
  reportCount: number;
  hero: { label: string; value: string; items: HeroItem[] };
  /** 凡例を兼ねる、期間のカテゴリ別の割合 */
  legend: CategoryShare[];
  /** 100%横棒(日次は1本、週次・月次は今期と前期) */
  shareRows: { label: string; shares: CategoryShare[] }[];
  breakdown: BreakdownCategory[];
  baseline: { days: number; label: string };
  /** 週次・月次: 日ごとの積み上げ縦棒 */
  columns: DayColumn[];
  trend: TrendPoint[];
  /** 日次: その日の時間帯・日報・作業・アプリ */
  day: {
    report: ReportRow | null;
    blocks: TimelineBlockInput[];
    workGroups: WorkItemGroup[];
    apps: AppUsageInput[];
  } | null;
  /** 週次: 7行の帯 */
  weekRows: { date: string; hasReport: boolean; future: boolean; active: number; segments: TimelineSegment[] }[];
  weekAxis: TimeAxis;
  /** 週次・月次: 時刻別の平均 */
  profile: ReturnType<typeof hourProfile>;
  profileAxis: TimeAxis;
  /** 月次: 曜日別の平均 */
  weekdays: ReturnType<typeof weekdayAverages>;
  headings: HeadingSummary[];
  appRanking: AppSummary[];
  notes: { reportDate: string; text: string }[];
  /** 原本タブ: 日次は本文、週次・月次は日報の一覧 */
  original: { markdown: string; warnings: string[]; parseStatus: ReportRow["parseStatus"] } | null;
  reportList: { date: string; active: number; parseStatus: ReportRow["parseStatus"] }[];
};

const BASELINE_LABEL: Record<Range, string> = { day: "直近28日の1日平均", week: "前週の1日平均", month: "前月の1日平均" };
const PREVIOUS_LABEL: Record<Range, string> = { day: "直近28日", week: "前週", month: "前月" };
const CURRENT_LABEL: Record<Range, string> = { day: "この日", week: "今週", month: "今月" };

const minutesText = (minutes: number) => {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  return hours ? `${hours}h${String(total % 60).padStart(2, "0")}m` : `${total % 60}m`;
};

export function buildModel(view: PeriodView, period: PeriodRange, today: string): DailyReportModel {
  const { range, from, to } = period;
  const reportDates = view.reportDates;
  const current = view.reports.filter((row) => row.reportDate >= from && row.reportDate <= to);
  const previous = view.reports.filter((row) => row.reportDate >= period.prevFrom && row.reportDate <= period.prevTo);
  const currentTags = view.tagDays.filter((row) => row.reportDate >= from && row.reportDate <= to);
  const previousTags = view.tagDays.filter((row) => row.reportDate >= period.prevFrom && row.reportDate <= period.prevTo);
  const currentSum = sumTags(currentTags);
  const active = Object.values(currentSum).reduce((sum, value) => sum + value, 0);
  const gap = current.reduce((sum, row) => sum + row.gapMinutes, 0);
  const recorded = current.reduce((sum, row) => sum + (row.recordedMinutes ?? 0), 0);
  const base = perDayAverages(previousTags, previous.length || undefined);
  const baseActive = base ? Object.values(base.minutes).reduce((sum, value) => sum + value, 0) : null;
  const gapText = `${minutesText(gap)}${recorded ? `(記録の${Math.round((gap / recorded) * 100)}%)` : ""}`;

  let hero: DailyReportModel["hero"];
  if (range === "day") {
    const report = current[0];
    hero = {
      label: "活動時間",
      value: report ? minutesText(active) : "—",
      items: [
        { label: "記録", value: report?.recordStart && report.recordEnd ? `${report.recordStart}〜${report.recordEnd}` : "—", sub: report?.recordedMinutes ? minutesText(report.recordedMinutes) : undefined },
        { label: "ログなし", value: report ? gapText : "—" },
        { label: "キャプチャ", value: report?.captureCount != null ? `${report.captureCount}回${report.captureCountIsMin ? "以上" : ""}` : "—" },
        { label: BASELINE_LABEL.day, value: baseActive === null ? "—" : minutesText(baseActive), sub: base ? `${base.days}日分` : "日報なし" },
      ],
    };
  } else {
    const days = current.length;
    hero = {
      label: "1日平均の活動時間",
      value: days ? minutesText(active / days) : "—",
      items: [
        { label: "合計", value: days ? minutesText(active) : "—" },
        { label: "ログなし", value: days ? gapText : "—" },
        { label: "日報", value: `${days}/${period.days}日`, sub: period.elapsedDays < period.days ? `${period.elapsedDays}日目まで` : undefined },
        { label: BASELINE_LABEL[range], value: baseActive === null ? "—" : minutesText(baseActive), sub: base ? `${base.days}日分` : "日報なし" },
      ],
    };
  }

  // 配分の横棒: 日次はその日の分数、週次・月次は1日平均(期間の日数が違っても比べられるように)
  const breakdownCurrent = range === "day" ? currentSum : perDayAverages(currentTags, current.length || undefined)?.minutes ?? {};
  const shareRows = [{ label: CURRENT_LABEL[range], shares: categoryShares(currentSum) }];
  if (range !== "day" && previousTags.length) shareRows.push({ label: PREVIOUS_LABEL[range], shares: categoryShares(sumTags(previousTags)) });

  const reportSet = new Set(reportDates);
  const periodDates = datesBetween(from, to);
  const columns = range === "day" ? [] : dailyColumns(periodDates, currentTags, reportSet);

  const blocksByDate = new Map<string, TimelineBlockInput[]>();
  for (const block of view.blocks) blocksByDate.set(block.reportDate, [...(blocksByDate.get(block.reportDate) ?? []), block]);
  const segmentsByDate = new Map([...blocksByDate.entries()].map(([date, blocks]) => [date, timelineSegments(blocks)]));
  const allSegments = [...segmentsByDate.values()];
  const sharedAxis = axisRange(allSegments.flat());
  const activeByDate = new Map(columns.map((column) => [column.date, column.total]));

  const switchTo = Object.fromEntries(RANGES.map(([value]) => [value, value === range ? period.anchor : switchRange(period, value, reportDates, today)])) as Record<Range, string>;
  const report = current[0] ?? null;

  return {
    period,
    today,
    reportDates,
    nav: {
      prev: shiftAnchor(period, -1, reportDates, today),
      next: shiftAnchor(period, 1, reportDates, today),
      current: range === "day" ? (reportDates.filter((date) => date <= today).at(-1) ?? today) : periodRange(range, today, today).anchor,
      switchTo,
    },
    reportCount: current.length,
    hero,
    legend: categoryShares(currentSum),
    shareRows,
    breakdown: breakdown(breakdownCurrent, base ? base.minutes : null),
    baseline: { days: base?.days ?? 0, label: BASELINE_LABEL[range] },
    columns,
    trend: trendSeries(period, view.tagDays, reportDates),
    day: range === "day"
      ? { report, blocks: blocksByDate.get(from) ?? [], workGroups: groupDayWorkItems(view.workItems), apps: view.apps }
      : null,
    weekRows: range === "week"
      ? periodDates.map((date) => ({ date, hasReport: reportSet.has(date), future: date > today, active: activeByDate.get(date) ?? 0, segments: segmentsByDate.get(date) ?? [] }))
      : [],
    weekAxis: sharedAxis,
    profile: range === "day" ? [] : hourProfile(allSegments, sharedAxis),
    profileAxis: sharedAxis,
    weekdays: range === "month" ? weekdayAverages(columns) : [],
    headings: range === "day" ? [] : headingSummaries(view.workItems),
    appRanking: range === "day" ? [] : appSummaries(view.apps),
    notes: view.notes,
    original: range === "day" && view.original && report ? { ...view.original, parseStatus: report.parseStatus } : null,
    reportList: current.map((row) => ({ date: row.reportDate, active: activeByDate.get(row.reportDate) ?? 0, parseStatus: row.parseStatus })).reverse(),
  };
}
