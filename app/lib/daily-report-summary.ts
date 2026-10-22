/** 作業日報の表示用の集計(docs/daily-report-view-design.md §5・§7)。D1には触れない純粋なロジック
 *  (vitestの "node" project でテストする)。取り込み時に計算済みの値(タグ×日の分数、時間帯の行)を、
 *  画面で読みやすい形に並べ替えるだけで、タグ付けや時間の数え方は daily-report-tags.ts が正。 */

import { DAILY_REPORT_TAGS, OTHER_TAG, tagsForText, type TagGroup } from "./daily-report-tags.ts";

// ---- カテゴリ(表示用の4分類＋未分類。タグ辞書のグループを寄せる) ----

export type Category = "study" | "dev" | "life" | "media" | "other";

/** 並び順と色の割り当て(固定。順位では変えない) */
export const CATEGORY_ORDER: Category[] = ["study", "dev", "life", "media", "other"];

export const CATEGORY_LABELS: Record<Category, string> = {
  study: "学習",
  dev: "開発",
  life: "生活",
  media: "視聴",
  other: "未分類",
};

/** 「お金」は単独では数%で帯の上では細い線にしかならないので、生活に入れる(設計書 §5.1) */
const GROUP_TO_CATEGORY: Record<TagGroup, Category> = { study: "study", dev: "dev", money: "life", life: "life", media: "media" };

const TAG_INDEX = new Map(DAILY_REPORT_TAGS.map((tag) => [tag.key, tag]));

export function categoryOfTag(tag: string): Category {
  const group = TAG_INDEX.get(tag)?.group;
  return group ? GROUP_TO_CATEGORY[group] : "other";
}

export function tagLabel(tag: string): string {
  if (tag === OTHER_TAG) return CATEGORY_LABELS.other;
  return TAG_INDEX.get(tag)?.label ?? tag;
}

/** 分数を `10h33m` / `54m` に。時間表記は画面全体でこの形に揃える。 */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  return `${hours}h${String(rest).padStart(2, "0")}m`;
}

/** 0時からの分を `HH:MM` に(`start_minute` と同じ単位)。 */
export function formatClock(minute: number): string {
  const wrapped = Math.max(0, Math.round(minute));
  return `${String(Math.floor(wrapped / 60) % 24).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

// ---- 日付(タイムゾーンは扱わず、report_date の文字列だけで計算する) ----

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function addMonths(date: string, months: number): string {
  const value = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
}

/** 0=月 … 6=日 */
export function weekdayIndex(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function weekdayLabel(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/** その日を含む週(月曜始まり)の7日 */
export function weekDates(date: string): string[] {
  const monday = addDays(date, -weekdayIndex(date));
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

export function isReportDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// ---- 期間(日次・週次・月次) ----

export type Range = "day" | "week" | "month";
export const RANGES: [Range, string][] = [["day", "日次"], ["week", "週次"], ["month", "月次"]];

export function isRange(value: unknown): value is Range {
  return value === "day" || value === "week" || value === "month";
}

export type PeriodRange = {
  range: Range;
  /** 期間を代表する日(日次=その日、週次=月曜、月次=1日)。URLの date に入る */
  anchor: string;
  from: string;
  to: string;
  /** 比べる相手。週次・月次は前の期間、日次は直前28日 */
  prevFrom: string;
  prevTo: string;
  /** 流れ(週次は12週、月次は12か月)を読む最初の日。日次は prevFrom と同じ */
  trendFrom: string;
  days: number;
  /** 期間のうち today までに過ぎた日数 */
  elapsedDays: number;
};

/** 日次の「比べる相手」にする直前の日数 */
export const BASELINE_DAYS = 28;
export const TREND_PERIODS = 12;

export function periodRange(range: Range, date: string, today: string): PeriodRange {
  let from: string;
  let to: string;
  let prevFrom: string;
  let prevTo: string;
  let trendFrom: string;
  if (range === "day") {
    from = to = date;
    prevFrom = addDays(date, -BASELINE_DAYS);
    prevTo = addDays(date, -1);
    trendFrom = prevFrom;
  } else if (range === "week") {
    from = addDays(date, -weekdayIndex(date));
    to = addDays(from, 6);
    prevFrom = addDays(from, -7);
    prevTo = addDays(from, -1);
    trendFrom = addDays(from, -7 * (TREND_PERIODS - 1));
  } else {
    from = `${date.slice(0, 7)}-01`;
    to = addDays(addMonths(from, 1), -1);
    prevFrom = addMonths(from, -1);
    prevTo = addDays(from, -1);
    trendFrom = addMonths(from, -(TREND_PERIODS - 1));
  }
  const days = daysBetween(from, to) + 1;
  const elapsedDays = today < from ? 0 : Math.min(days, daysBetween(from, today) + 1);
  return { range, anchor: from, from, to, prevFrom, prevTo, trendFrom, days, elapsedDays };
}

/** 既定の表示: 今日を含む期間に日報があればそこ、無ければ最新の日報を含む期間。日報が1件も無ければ今日。 */
export function defaultAnchor(range: Range, reportDates: string[], today: string): string {
  const latest = reportDates.at(-1);
  if (!latest) return periodRange(range, today, today).anchor;
  if (range === "day") return latest;
  const current = periodRange(range, today, today);
  const hasCurrent = reportDates.some((date) => date >= current.from && date <= current.to);
  return hasCurrent ? current.anchor : periodRange(range, latest, today).anchor;
}

/** 期間の中で最後に日報がある日。無ければ null。 */
export function lastReportIn(reportDates: string[], from: string, to: string): string | null {
  for (let index = reportDates.length - 1; index >= 0; index -= 1) {
    const date = reportDates[index];
    if (date < from) break;
    if (date <= to) return date;
  }
  return null;
}

/** 単位を替えたときの日付(設計書 §3.1)。下位(日次)へは、その期間の最後の日報のある日へ降りる。 */
export function switchRange(current: PeriodRange, to: Range, reportDates: string[], today: string): string {
  if (to === "day") {
    return lastReportIn(reportDates, current.from, current.to) ?? reportDates.filter((date) => date <= current.to).at(-1) ?? reportDates[0] ?? current.from;
  }
  return periodRange(to, current.anchor, today).anchor;
}

/** 前後の期間の日付。日次は日報のある日へ飛ぶ。週次・月次は日報の範囲と今日の期間を越えない。行き先が無ければ null。 */
export function shiftAnchor(current: PeriodRange, direction: -1 | 1, reportDates: string[], today: string): string | null {
  if (current.range === "day") {
    if (direction < 0) return reportDates.filter((date) => date < current.anchor).at(-1) ?? null;
    return reportDates.find((date) => date > current.anchor) ?? null;
  }
  const first = reportDates[0];
  if (!first) return null;
  const next = direction < 0
    ? current.range === "week" ? addDays(current.from, -7) : addMonths(current.from, -1)
    : current.range === "week" ? addDays(current.from, 7) : addMonths(current.from, 1);
  const target = periodRange(current.range, next, today);
  if (direction < 0 && target.to < first) return null;
  if (direction > 0 && target.from > today) return null;
  return target.anchor;
}

// ---- 時間帯の帯 ----

export type TimelineBlockInput = {
  position: number;
  startMinute: number | null;
  endMinute: number | null;
  activity: string;
  durationMinutes: number | null;
  isGap: boolean;
  /** その時間帯に付いたタグ(daily_report_item_tags の source='time') */
  tags: string[];
};

export type TimelinePart = { tag: string; category: Category; fraction: number };

export type TimelineSegment = {
  position: number;
  startMinute: number;
  endMinute: number;
  activity: string;
  durationMinutes: number | null;
  isGap: boolean;
  /** 帯の塗り分け。複数のタグが付いた時間帯は、タグの数で等分する(時間の数え方と同じ規則) */
  parts: TimelinePart[];
};

/** 開始・終了が読めた時間帯だけを、帯に描く形にする。タグが無ければ未分類(灰)、ログなしは parts なし。 */
export function timelineSegments(blocks: TimelineBlockInput[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  for (const block of blocks) {
    if (block.startMinute === null || block.endMinute === null || block.endMinute <= block.startMinute) continue;
    const tags = block.isGap ? [] : block.tags.length ? block.tags : [OTHER_TAG];
    segments.push({
      position: block.position,
      startMinute: block.startMinute,
      endMinute: block.endMinute,
      activity: block.activity,
      durationMinutes: block.durationMinutes,
      isGap: block.isGap,
      parts: tags.map((tag) => ({ tag, category: categoryOfTag(tag), fraction: 1 / tags.length })),
    });
  }
  return segments;
}

export type TimeAxis = { startHour: number; endHour: number };

const DEFAULT_AXIS: TimeAxis = { startHour: 8, endHour: 22 };

/** 帯の横軸。時間帯の最早開始〜最遅終了を時間単位に丸める。1つも無ければ既定(8〜22時)。 */
export function axisRange(segments: Pick<TimelineSegment, "startMinute" | "endMinute">[]): TimeAxis {
  if (!segments.length) return DEFAULT_AXIS;
  const start = Math.min(...segments.map((segment) => segment.startMinute));
  const end = Math.max(...segments.map((segment) => segment.endMinute));
  const startHour = Math.floor(start / 60);
  const endHour = Math.max(startHour + 1, Math.ceil(end / 60));
  return { startHour, endHour };
}

/** 帯の上の目盛り(時)。軸が短ければ1時間おき、長ければ2時間おき。 */
export function axisTicks(axis: TimeAxis): number[] {
  const step = axis.endHour - axis.startHour <= 9 ? 1 : 2;
  const first = Math.ceil(axis.startHour / step) * step;
  const ticks: number[] = [];
  for (let hour = first; hour <= axis.endHour; hour += step) ticks.push(hour);
  return ticks;
}

export type CategoryMinutes = Partial<Record<Category, number>>;

/** 時刻別の平均(設計書 §4「時間帯タブ」)。各時間帯を1時間の区切りに重なった分だけ配り、日報のある日数で割る。
 *  ログなしは数えない。daysWithRecord は「その1時間に何らかの記録(ログなしを含む)があった日」の数。 */
export function hourProfile(days: TimelineSegment[][], axis: TimeAxis): { hour: number; minutes: CategoryMinutes; daysWithRecord: number }[] {
  const count = days.length;
  const hours = Array.from({ length: axis.endHour - axis.startHour }, (_, index) => ({ hour: axis.startHour + index, minutes: {} as CategoryMinutes, daysWithRecord: 0 }));
  for (const segments of days) {
    const recorded = new Set<number>();
    for (const segment of segments) {
      for (const slot of hours) {
        const overlap = Math.min(segment.endMinute, (slot.hour + 1) * 60) - Math.max(segment.startMinute, slot.hour * 60);
        if (overlap <= 0) continue;
        recorded.add(slot.hour);
        for (const part of segment.parts) slot.minutes[part.category] = (slot.minutes[part.category] ?? 0) + overlap * part.fraction;
      }
    }
    for (const slot of hours) if (recorded.has(slot.hour)) slot.daysWithRecord += 1;
  }
  if (count) for (const slot of hours) for (const key of Object.keys(slot.minutes) as Category[]) slot.minutes[key] = (slot.minutes[key] ?? 0) / count;
  return hours;
}

// ---- 配分(カテゴリ→タグ) ----

/** 1日平均の差を `+42m` `−18m` `±0m` に(色は付けずに書く。設計書 §4.1) */
export function signedMinutes(diff: number): string {
  const rounded = Math.round(diff);
  if (rounded === 0) return "±0m";
  return `${rounded > 0 ? "+" : "−"}${formatMinutes(Math.abs(rounded))}`;
}

export type AllocationTagRow = { tag: string; label: string; total: number; average: number; baselineAverage: number | null };
export type AllocationRow = {
  category: Category;
  label: string;
  /** 活動時間(タグの合計)に対する割合。欠落は分母に入れない */
  percent: number;
  total: number;
  /** 日報のある日の1日平均 */
  average: number;
  /** 比べる相手の1日平均。相手の日報が0日なら null */
  baselineAverage: number | null;
  tags: AllocationTagRow[];
};

/** 概要の「配分の表」(設計書 §4.1)。行はカテゴリの固定順(0分のカテゴリは出さない)、タグは合計の多い順。
 *  baseline は比べる相手のタグ別の1日平均(perDayAverages の minutes)。 */
export function allocationRows(current: Record<string, number>, reportDays: number, baseline: Record<string, number> | null): AllocationRow[] {
  const days = Math.max(1, reportDays);
  const total = Object.values(current).reduce((sum, value) => sum + value, 0);
  const rows = new Map<Category, AllocationRow>();
  for (const [tag, minutes] of Object.entries(current)) {
    if (minutes <= 0) continue;
    const category = categoryOfTag(tag);
    let row = rows.get(category);
    if (!row) {
      row = { category, label: CATEGORY_LABELS[category], percent: 0, total: 0, average: 0, baselineAverage: baseline ? 0 : null, tags: [] };
      rows.set(category, row);
    }
    row.total += minutes;
    row.tags.push({ tag, label: tagLabel(tag), total: minutes, average: minutes / days, baselineAverage: baseline ? (baseline[tag] ?? 0) : null });
  }
  // カテゴリの相手は、今期に出たタグだけでなく、そのカテゴリの相手の合計で引く
  if (baseline) {
    for (const [tag, minutes] of Object.entries(baseline)) {
      const row = rows.get(categoryOfTag(tag));
      if (row) row.baselineAverage = (row.baselineAverage ?? 0) + minutes;
    }
  }
  for (const row of rows.values()) {
    row.average = row.total / days;
    row.percent = total ? (row.total / total) * 100 : 0;
    row.tags.sort((a, b) => b.total - a.total);
  }
  return CATEGORY_ORDER.filter((category) => rows.has(category)).map((category) => rows.get(category)!);
}

export type TagDayRow = { reportDate: string; tag: string; minutes: number };

/** 日ごとのタグ別の分数から、タグごとの「日報のある日の1日平均」を出す。日報のある日が0日なら null。 */
export function perDayAverages(rows: TagDayRow[], reportDays?: number): { days: number; minutes: Record<string, number> } | null {
  const days = reportDays ?? new Set(rows.map((row) => row.reportDate)).size;
  if (!days) return null;
  const minutes: Record<string, number> = {};
  for (const row of rows) minutes[row.tag] = (minutes[row.tag] ?? 0) + row.minutes;
  for (const tag of Object.keys(minutes)) minutes[tag] /= days;
  return { days, minutes };
}

export type CategoryShare = { category: Category; label: string; minutes: number; percent: number };

/** カテゴリ別の割合(100%横棒・凡例)。分母は活動時間(タグの合計)で、欠落は入れない。並びは固定順。 */
export function categoryShares(tagMinutes: Record<string, number>): CategoryShare[] {
  const totals = new Map<Category, number>();
  for (const [tag, minutes] of Object.entries(tagMinutes)) totals.set(categoryOfTag(tag), (totals.get(categoryOfTag(tag)) ?? 0) + minutes);
  const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
  return CATEGORY_ORDER.filter((category) => (totals.get(category) ?? 0) > 0).map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    minutes: totals.get(category) ?? 0,
    percent: total ? ((totals.get(category) ?? 0) / total) * 100 : 0,
  }));
}

export function sumTags(rows: TagDayRow[]): Record<string, number> {
  const minutes: Record<string, number> = {};
  for (const row of rows) minutes[row.tag] = (minutes[row.tag] ?? 0) + row.minutes;
  return minutes;
}

export type DayColumn = { date: string; hasReport: boolean; total: number; parts: { category: Category; minutes: number }[] };

/** 日ごとの積み上げ縦棒(週次・月次の概要)。日報の無い日は空き枠。 */
export function dailyColumns(dates: string[], rows: TagDayRow[], reportDates: Set<string>): DayColumn[] {
  const byDate = new Map<string, Map<Category, number>>();
  for (const row of rows) {
    const day = byDate.get(row.reportDate) ?? new Map<Category, number>();
    day.set(categoryOfTag(row.tag), (day.get(categoryOfTag(row.tag)) ?? 0) + row.minutes);
    byDate.set(row.reportDate, day);
  }
  return dates.map((date) => {
    const day = byDate.get(date) ?? new Map<Category, number>();
    const parts = CATEGORY_ORDER.filter((category) => (day.get(category) ?? 0) > 0).map((category) => ({ category, minutes: day.get(category) ?? 0 }));
    return { date, hasReport: reportDates.has(date), total: parts.reduce((sum, part) => sum + part.minutes, 0), parts };
  });
}

export type TrendPoint = { from: string; to: string; label: string; days: number; minutes: CategoryMinutes | null };

/** 最近12期間の、カテゴリ別の1日平均(週次=12週、月次=12か月)。日報の無い期間は minutes が null。 */
export function trendSeries(period: PeriodRange, rows: TagDayRow[], reportDates: string[]): TrendPoint[] {
  if (period.range === "day") return [];
  const points: TrendPoint[] = [];
  for (let index = TREND_PERIODS - 1; index >= 0; index -= 1) {
    const from = period.range === "week" ? addDays(period.from, -7 * index) : addMonths(period.from, -index);
    const to = period.range === "week" ? addDays(from, 6) : addDays(addMonths(from, 1), -1);
    const days = reportDates.filter((date) => date >= from && date <= to).length;
    const label = period.range === "week" ? `${Number(from.slice(5, 7))}/${Number(from.slice(8, 10))}` : `${Number(from.slice(5, 7))}月`;
    if (!days) {
      points.push({ from, to, label, days, minutes: null });
      continue;
    }
    const minutes: CategoryMinutes = {};
    for (const row of rows) {
      if (row.reportDate < from || row.reportDate > to) continue;
      const category = categoryOfTag(row.tag);
      minutes[category] = (minutes[category] ?? 0) + row.minutes / days;
    }
    points.push({ from, to, label, days, minutes });
  }
  return points;
}

/** 曜日別の平均活動時間(月次の「時間帯タブ」)。日報のある日だけで平均する。 */
export function weekdayAverages(columns: DayColumn[]): { weekday: string; minutes: number | null; days: number }[] {
  const labels = ["月", "火", "水", "木", "金", "土", "日"];
  return labels.map((weekday, index) => {
    const days = columns.filter((column) => column.hasReport && weekdayIndex(column.date) === index);
    return { weekday, days: days.length, minutes: days.length ? days.reduce((sum, column) => sum + column.total, 0) / days.length : null };
  });
}

// ---- 作業項目・知見 ----

export type WorkItemInput = { reportDate: string; position: number; categoryPosition: number; category: string; itemPosition: number; text: string; tags: string[] };

export type WorkTagRow = {
  tag: string;
  label: string;
  /** タグ×日の分数の合計(時間帯から数えた時間)。時間帯に一度も出ないタグは null */
  minutes: number | null;
  /** 作業項目か時間帯にそのタグが出た日の数 */
  days: number;
  /** 作業項目(新しい順)。作業項目の無いタグは空 */
  items: { reportDate: string; text: string }[];
};
export type WorkCategoryRow = { category: Category; label: string; minutes: number; tags: WorkTagRow[] };

/** 作業内容タブの表(設計書 §4.4)。日報の `###` 見出しは日ごとに言い方が揺れてまとまらないので、タグの単位でまとめる。
 *  カテゴリは固定順、タグは時間の多い順(時間の無いタグは最後)。タグの付かない作業項目は未分類(other)に入れる。 */
export function workTable(items: WorkItemInput[], tagDays: TagDayRow[]): WorkCategoryRow[] {
  const tags = new Map<string, { minutes: number | null; dates: Set<string>; items: { reportDate: string; text: string }[] }>();
  const entry = (tag: string) => {
    let value = tags.get(tag);
    if (!value) tags.set(tag, (value = { minutes: null, dates: new Set(), items: [] }));
    return value;
  };
  for (const row of tagDays) {
    if (row.minutes <= 0) continue;
    const value = entry(row.tag);
    value.minutes = (value.minutes ?? 0) + row.minutes;
    value.dates.add(row.reportDate);
  }
  for (const item of items) {
    for (const tag of item.tags.length ? item.tags : [OTHER_TAG]) {
      const value = entry(tag);
      value.dates.add(item.reportDate);
      value.items.push({ reportDate: item.reportDate, text: item.text });
    }
  }
  const categories = new Map<Category, WorkCategoryRow>();
  for (const [tag, value] of tags) {
    const category = categoryOfTag(tag);
    let row = categories.get(category);
    if (!row) categories.set(category, (row = { category, label: CATEGORY_LABELS[category], minutes: 0, tags: [] }));
    row.minutes += value.minutes ?? 0;
    row.tags.push({
      tag,
      label: tagLabel(tag),
      minutes: value.minutes,
      days: value.dates.size,
      items: [...value.items].sort((a, b) => b.reportDate.localeCompare(a.reportDate)),
    });
  }
  for (const row of categories.values()) row.tags.sort((a, b) => (b.minutes ?? -1) - (a.minutes ?? -1) || a.label.localeCompare(b.label));
  return CATEGORY_ORDER.filter((category) => categories.has(category)).map((category) => categories.get(category)!);
}

/** 知見の文のカテゴリ(設計書 §4.5)。タグ辞書を当てた最初のタグのカテゴリで、当たらなければ未分類。D1には保存しない。 */
export function noteCategory(text: string): Category {
  const [first] = tagsForText(text);
  return first ? categoryOfTag(first) : "other";
}
