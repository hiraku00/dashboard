/** /daily-report の画面に渡す形(タブの中身)を、D1から読んだ行(app/lib/queries/daily-report.ts の PeriodView)
 *  から組み立てる。D1に触れない純粋なロジックで、サーバーで1回だけ呼ぶ(クライアントには集計済みの形だけを渡す)。
 *  docs/daily-report-view-design.md §4・§6.2。 */

import {
  CATEGORY_LABELS,
  RANGES,
  allocationRows,
  appSummaries,
  axisRange,
  categoryShares,
  dailyColumns,
  datesBetween,
  formatMinutes,
  groupDayWorkItems,
  headingSummaries,
  hourProfile,
  perDayAverages,
  periodRange,
  shiftAnchor,
  signedMinutes,
  sumTags,
  switchRange,
  timelineSegments,
  trendSeries,
  weekdayAverages,
  weekdayLabel,
  type AllocationRow,
  type AppSummary,
  type AppUsageInput,
  type Category,
  type CategoryShare,
  type HeadingSummary,
  type PeriodRange,
  type Range,
  type TagDayRow,
  type TimeAxis,
  type TimelineBlockInput,
  type TimelineSegment,
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

/** 活動時間の図の棒1本(設計書 §4.2)。value が null は日報なし。 */
export type ActivityBar = {
  key: string;
  /** 横軸のラベル(空なら出さない) */
  label: string;
  /** ツールチップの1行目 */
  title: string;
  value: number | null;
  future: boolean;
  breakdown: { category: Category; minutes: number }[];
  /** 押したときの行き先 */
  target: { range: Range; date: string } | null;
};

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
  /** ヒーロー: 週次・月次は合計と1日平均を同じ大きさで並べる(§6.2) */
  hero: { figures: { label: string; value: string }[]; caption: string | null; items: HeroItem[] };
  /** 時間の使い方タブの凡例(期間のカテゴリ別の割合) */
  legend: CategoryShare[];
  /** 概要の配分の表 */
  allocation: AllocationRow[];
  baseline: { days: number; label: string; shortLabel: string };
  /** 週次・月次: 活動時間の図(日ごと / 最近12週・12か月) */
  activity: { days: ActivityBar[]; periods: ActivityBar[]; periodsLabel: string };
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
const BASELINE_SHORT: Record<Range, string> = { day: "直近28日", week: "前週", month: "前月" };
const MONTH_DAY_LABELS = new Set([1, 5, 10, 15, 20, 25, 30]);

const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

/** 比べる相手との差の補足(`+42m/日`)。相手の日報が3日未満なら参考扱い、0日なら「日報なし」 */
function diffNote(current: number, base: number | null, baseDays: number, perDay: boolean): string {
  if (base === null || baseDays === 0) return "日報なし";
  return `${signedMinutes(current - base)}${perDay ? "/日" : ""}${baseDays < 3 ? "(参考)" : ""}`;
}

/** 期間がまだ途中のときの「木〜日はまだ」「23日〜31日はまだ」 */
function remainingNote(period: PeriodRange): string | undefined {
  if (period.elapsedDays >= period.days) return undefined;
  const dates = datesBetween(period.from, period.to).slice(period.elapsedDays);
  if (!dates.length) return undefined;
  const label = (date: string) => (period.range === "week" ? weekdayLabel(date) : `${Number(date.slice(8, 10))}日`);
  return dates.length === 1 ? `${label(dates[0])}はまだ` : `${label(dates[0])}〜${label(dates.at(-1)!)}はまだ`;
}

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
  const baseDays = base?.days ?? 0;
  const gapItem: HeroItem = { label: "ログなし", value: current.length ? formatMinutes(gap) : "—", sub: recorded ? `記録の${Math.round((gap / recorded) * 100)}%` : undefined };

  let hero: DailyReportModel["hero"];
  if (range === "day") {
    const report = current[0];
    hero = {
      figures: [{ label: "活動時間", value: report ? formatMinutes(active) : "—" }],
      caption: report?.recordStart && report.recordEnd ? `記録 ${report.recordStart}〜${report.recordEnd}${report.recordedMinutes ? `(${formatMinutes(report.recordedMinutes)})` : ""}` : null,
      items: [
        { label: BASELINE_LABEL.day, value: baseActive === null ? "—" : formatMinutes(baseActive), sub: report ? diffNote(active, baseActive, baseDays, false) : undefined },
        gapItem,
        { label: "キャプチャ", value: report?.captureCount != null ? `${report.captureCount}回${report.captureCountIsMin ? "以上" : ""}` : "—" },
      ],
    };
  } else {
    const days = current.length;
    const average = days ? active / days : 0;
    hero = {
      figures: [
        { label: "合計", value: days ? formatMinutes(active) : "—" },
        { label: "1日平均", value: days ? formatMinutes(average) : "—" },
      ],
      caption: null,
      items: [
        { label: BASELINE_LABEL[range], value: baseActive === null ? "—" : formatMinutes(baseActive), sub: days ? diffNote(average, baseActive, baseDays, true) : undefined },
        gapItem,
        { label: "日報", value: `${days}/${period.days}日`, sub: remainingNote(period) },
      ],
    };
  }

  const reportSet = new Set(reportDates);
  const periodDates = datesBetween(from, to);
  const columns = range === "day" ? [] : dailyColumns(periodDates, currentTags, reportSet);

  const activityDays: ActivityBar[] = columns.map((column) => ({
    key: column.date,
    label: range === "week" ? weekdayLabel(column.date) : MONTH_DAY_LABELS.has(Number(column.date.slice(8, 10))) ? String(Number(column.date.slice(8, 10))) : "",
    title: `${shortDate(column.date)}(${weekdayLabel(column.date)})`,
    value: column.hasReport ? column.total : null,
    future: column.date > today,
    breakdown: column.parts,
    target: column.hasReport ? { range: "day", date: column.date } : null,
  }));
  const activityPeriods: ActivityBar[] = trendSeries(period, view.tagDays, reportDates).map((point, index, points) => {
    const minutes = point.minutes;
    const total = minutes ? Object.values(minutes).reduce((sum, value) => sum + (value ?? 0), 0) : null;
    // 横軸は12本すべてに書くと詰まるので、最新から2本おき(週ごと)・全部(月ごと)
    const showLabel = range === "month" || (points.length - 1 - index) % 2 === 0;
    return {
      key: point.from,
      label: showLabel ? point.label : "",
      title: range === "week" ? `${shortDate(point.from)}〜${shortDate(point.to)}の週(1日平均・${point.days}日分)` : `${Number(point.from.slice(0, 4))}年${Number(point.from.slice(5, 7))}月(1日平均・${point.days}日分)`,
      value: total,
      future: point.from > today,
      breakdown: minutes ? (Object.keys(CATEGORY_LABELS) as Category[]).filter((category) => minutes[category]).map((category) => ({ category, minutes: minutes[category] ?? 0 })) : [],
      target: total === null ? null : { range, date: point.from },
    };
  });

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
    allocation: allocationRows(currentSum, current.length, base ? base.minutes : null),
    baseline: { days: baseDays, label: BASELINE_LABEL[range], shortLabel: BASELINE_SHORT[range] },
    activity: { days: activityDays, periods: activityPeriods, periodsLabel: range === "month" ? "最近12か月" : "最近12週" },
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
