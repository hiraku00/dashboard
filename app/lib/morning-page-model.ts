/** /morning-page の画面に渡す形を、D1から読んだ行(app/lib/queries/morning-page.ts の MorningPageView)から組み立てる。
 *  D1に触れない純粋なロジックで、サーバーで1回だけ呼ぶ(クライアントには集計済みの形だけを渡す)。
 *  期間(月次・年次・全期間)はツールバーで選び、どのタブ(概要・内容・場所)もその期間の分を出す(docs/morning-page-design.md)。
 *
 *  日報のある期間(DAILY_REPORT_START 以降)のページは、Claude での取り出しをしていない(ヘッダーだけ)。その期間の
 *  「今日の予定」「昨日のこと」「気がかり」は、日報の6節目「予定と振り返り」から補う。6節目は「日報 D の日の朝の予定」と
 *  「D+1 日の朝の振り返り・気になること」から書かれるので、日報 D の予定はページ D に、PCの外の活動と気がかりはページ D+1 に付ける。 */

import { addDays, daysBetween, weekdayIndex, weekdayLabel } from "./daily-report-summary.ts";
import { parseReflection } from "./daily-report-reflection.ts";
import type { Outfit } from "./outfit.ts";
import { PLACE_GROUPS, classifyPlace, emptyPlaceCounts, type PlaceCounts, type PlaceGroup } from "./morning-page-places.ts";

/** 作業日報(画面記録)の最初の日。これ以降の日は、予定と実績を日報の「振り返り」タブで読める */
export const DAILY_REPORT_START = "2025-12-23";

export type MorningRange = "month" | "year" | "all";
export const MORNING_RANGES: [MorningRange, string][] = [["month", "月次"], ["year", "年次"], ["all", "全期間"]];
/** 機能内タブ(切り口)。サーバーのページ(URLの tab の検証)とクライアントの両方が使うので、ここに置く */
export type MorningTab = "summary" | "content" | "place" | "outfit";
export const MORNING_TABS: [MorningTab, string][] = [["summary", "概要"], ["content", "内容"], ["place", "場所"], ["outfit", "服装"]];
export const isMorningRange = (value: unknown): value is MorningRange => MORNING_RANGES.some(([id]) => id === value);

export type MorningPageRow = {
  date: string;
  startedAt: string | null;
  endedAt: string | null;
  minutes: number | null;
  place: string;
  chars: number | null;
  /** ヘッダーの「服装」。書いていないページは null */
  outfit: Outfit | null;
  yesterday: string[];
  plan: string[];
  notes: string[];
  extracted: boolean;
};

/** 月ごとの集計。平均は合計÷件数で出す(所要時間・文字数の無いページは数えない) */
export type MonthStat = { month: string; pages: number; sumMinutes: number; minutesCount: number; sumChars: number; charsCount: number };
/** 月ごと・場所(書いたままの文字)ごとのページ数 */
export type MonthPlace = { month: string; place: string; pages: number };
/** 日報の6節目(Markdown)。reportDate は日報の日付 */
export type ReportReflection = { reportDate: string; markdown: string };
/** 服装: 段・品名ごとの着た日数(ブランドは大文字・小文字を揃えて数える) */
export type OutfitItemCount = { layer: "top" | "middle" | "bottom"; item: string; brand: string; days: number; last: string };
export type OutfitBrandCount = { brand: string; days: number; last: string };
export type SearchHit = { date: string; kind: "yesterday" | "plan" | "notes"; text: string };

export type MorningPageView = {
  /** データのある月(昇順、全期間) */
  months: MonthStat[];
  monthPlaces: MonthPlace[];
  /** 最初と最後のページの日付 */
  firstDate: string | null;
  lastDate: string | null;
  /** 服装を初めて書いたページの日付 */
  firstOutfitDate: string | null;
  /** 期間の服装の集計 */
  outfitItems: OutfitItemCount[];
  outfitBrands: OutfitBrandCount[];
  /** 期間に服装を書いたページの数 */
  outfitDays: number;
  /** 月次で開く月(YYYY-MM)。年次・全期間とデータが無いときは null */
  month: string | null;
  /** 月次で開く月のページ */
  rows: MorningPageRow[];
  /** 開く月の前日〜月末の日報の6節目(予定・昨日のこと・気がかりを補う) */
  reflections: ReportReflection[];
  search: { q: string; hits: SearchHit[] } | null;
};

/** 日報 D の6節目の気がかりを、それを書いた朝のページ(D+1)の日付で返す */
export function concernsFromReflection(reflection: ReportReflection): { date: string; text: string }[] {
  const date = addDays(reflection.reportDate, 1);
  return parseReflection(reflection.markdown).notes.flatMap((note) => (note.kind === "concern" ? [{ date, text: note.text }] : []));
}

export type DaySource = "extracted" | "report" | "header";
export type MorningDay = MorningPageRow & { weekday: string; reportLink: string | null; source: DaySource };
/** 月次のカレンダーの1日。future は今日より後の日 */
export type CalendarDay = { date: string; day: number; weekday: number; written: boolean; future: boolean; minutes: number | null; chars: number | null; place: string; group: PlaceGroup | null };
export type TrendPoint = { month: string; label: string; daysInMonth: number; pages: number; avgMinutes: number | null; avgChars: number | null; places: PlaceCounts };
export type PlaceShare = { group: PlaceGroup; label: string; count: number; raw: { place: string; count: number }[] };

export type MorningPageModel = {
  range: MorningRange;
  /** 月次は YYYY-MM、年次は YYYY、全期間は null */
  anchor: string | null;
  label: string;
  /** 前後の期間と最新の期間(データのある月・年だけ)。全期間はすべて null */
  nav: { prev: string | null; next: string | null; latest: string | null };
  /** ツールバーで単位を替えたときに開く期間 */
  switchTo: Record<MorningRange, string | null>;
  /** 月・年の選択(データのある月だけ押せる) */
  years: { year: string; months: { month: string; pages: number }[] }[];
  /** 期間の数字。days は期間のうち、最初のページの日〜今日に入る日数 */
  figures: { pages: number; days: number; avgMinutes: number | null; avgChars: number | null; longest: { date: string; minutes: number } | null };
  /** 年次・全期間の月ごとの推移(月次は空) */
  trend: TrendPoint[];
  /** 月次のカレンダー(月曜始まり。lead は1日の前の空きの数) */
  calendar: { lead: number; days: CalendarDay[] };
  /** 期間の場所(意味でまとめた分類ごと) */
  places: PlaceShare[];
  /** 月次のページ(日付の昇順) */
  days: MorningDay[];
  /** 服装タブ: 期間の書いた日数と、段・品名ごと・ブランドごとの着た日数(多い順)。firstDate は服装を初めて書いた日 */
  outfit: { firstDate: string | null; days: number; items: OutfitItemCount[]; brands: OutfitBrandCount[] };
  search: { q: string; hits: SearchHit[] } | null;
  empty: boolean;
};

export const monthLabel = (month: string) => `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;

export function daysIn(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

const average = (sum: number, count: number) => (count ? Math.round(sum / count) : null);

function placeShares(entries: { place: string; count: number }[]): PlaceShare[] {
  const byGroup = new Map<PlaceGroup, Map<string, number>>();
  for (const { place, count } of entries) {
    const group = classifyPlace(place);
    const name = place || "(書いていない)";
    const raw = byGroup.get(group) ?? new Map<string, number>();
    raw.set(name, (raw.get(name) ?? 0) + count);
    byGroup.set(group, raw);
  }
  return PLACE_GROUPS.flatMap(({ group, label }) => {
    const raw = byGroup.get(group);
    if (!raw) return [];
    const list = [...raw.entries()].map(([place, count]) => ({ place, count })).sort((a, b) => b.count - a.count || a.place.localeCompare(b.place));
    return [{ group, label, count: list.reduce((sum, item) => sum + item.count, 0), raw: list }];
  }).sort((a, b) => b.count - a.count);
}

/** 日報のある期間のページに、日報の6節目から予定・昨日のこと・気がかりを補う */
function fillFromReports(row: MorningPageRow, reflections: Map<string, ReturnType<typeof parseReflection>>): { row: MorningPageRow; filled: boolean } {
  if (row.extracted || row.date < DAILY_REPORT_START) return { row, filled: false };
  const today = reflections.get(row.date);
  const before = reflections.get(addDays(row.date, -1));
  const plan = (today?.plans ?? []).filter((item) => item.status !== "extra").map((item) => item.plan);
  const yesterday = (before?.activities ?? []).map((item) => (item.time ? `${item.time} ${item.activity}` : item.activity));
  const notes = (before?.notes ?? []).filter((note) => note.kind === "concern").map((note) => note.text);
  return { row: { ...row, plan, yesterday, notes }, filled: plan.length + yesterday.length + notes.length > 0 };
}

/** from〜to のうち、最初のページの日〜今日に入る日数 */
function coveredDays(from: string, to: string, firstDate: string | null, today: string): number {
  const start = firstDate && firstDate > from ? firstDate : from;
  const end = today < to ? today : to;
  return end < start ? 0 : daysBetween(start, end) + 1;
}

/** period.anchor: 月次は view.month と同じ月、年次は年(null なら最新の年)、全期間は null */
export function buildMorningModel(view: MorningPageView, period: { range: MorningRange; anchor: string | null }, today: string): MorningPageModel {
  const { months, rows } = view;
  const range = period.range;
  const knownMonths = months.map((entry) => entry.month);
  const knownYears = [...new Set(knownMonths.map((month) => month.slice(0, 4)))];
  const anchor = range === "month" ? view.month : range === "year" ? (period.anchor ?? knownYears.at(-1) ?? null) : null;

  const years: MorningPageModel["years"] = knownYears.map((year) => ({ year, months: months.filter((entry) => entry.month.startsWith(year)).map((entry) => ({ month: entry.month, pages: entry.pages })) }));
  const steps = range === "month" ? knownMonths : range === "year" ? knownYears : [];
  const index = anchor ? steps.indexOf(anchor) : -1;
  const nav = {
    prev: index > 0 ? steps[index - 1] : index === -1 && anchor ? (steps.filter((step) => step < anchor).at(-1) ?? null) : null,
    next: index >= 0 && index < steps.length - 1 ? steps[index + 1] : index === -1 && anchor ? (steps.find((step) => step > anchor) ?? null) : null,
    latest: steps.at(-1) ?? null,
  };
  const switchTo: MorningPageModel["switchTo"] = {
    month: range === "year" && anchor ? (knownMonths.filter((month) => month.startsWith(anchor)).at(-1) ?? null) : (knownMonths.at(-1) ?? null),
    year: range === "month" && anchor ? anchor.slice(0, 4) : (knownYears.at(-1) ?? null),
    all: null,
  };

  // 期間に入る月
  const inPeriod = (month: string) => (range === "all" ? true : anchor ? month.startsWith(anchor) : false);
  const periodMonths = months.filter((entry) => inPeriod(entry.month));
  const placesByMonth = new Map<string, PlaceCounts>();
  const placeTotals = new Map<string, number>();
  for (const entry of view.monthPlaces) {
    if (!inPeriod(entry.month)) continue;
    const counts = placesByMonth.get(entry.month) ?? emptyPlaceCounts();
    counts[classifyPlace(entry.place)] += entry.pages;
    placesByMonth.set(entry.month, counts);
    placeTotals.set(entry.place, (placeTotals.get(entry.place) ?? 0) + entry.pages);
  }
  const trend: TrendPoint[] = range === "month" ? [] : periodMonths.map((entry) => ({
    month: entry.month,
    label: monthLabel(entry.month),
    daysInMonth: daysIn(entry.month),
    pages: entry.pages,
    avgMinutes: average(entry.sumMinutes, entry.minutesCount),
    avgChars: average(entry.sumChars, entry.charsCount),
    places: placesByMonth.get(entry.month) ?? emptyPlaceCounts(),
  }));

  const sum = (pick: (entry: MonthStat) => number) => periodMonths.reduce((total, entry) => total + pick(entry), 0);
  const [from, to] = range === "month" && anchor
    ? [`${anchor}-01`, `${anchor}-${String(daysIn(anchor)).padStart(2, "0")}`]
    : range === "year" && anchor
      ? [`${anchor}-01-01`, `${anchor}-12-31`]
      : [view.firstDate ?? today, view.lastDate && view.lastDate > today ? view.lastDate : today];
  const longest = rows.reduce<{ date: string; minutes: number } | null>((best, row) => (row.minutes !== null && (!best || row.minutes > best.minutes) ? { date: row.date, minutes: row.minutes } : best), null);
  const figures = {
    pages: sum((entry) => entry.pages),
    days: anchor || range === "all" ? coveredDays(from, to, view.firstDate, today) : 0,
    avgMinutes: average(sum((entry) => entry.sumMinutes), sum((entry) => entry.minutesCount)),
    avgChars: average(sum((entry) => entry.sumChars), sum((entry) => entry.charsCount)),
    longest,
  };

  const parsed = new Map(view.reflections.map((item) => [item.reportDate, parseReflection(item.markdown)]));
  const days: MorningDay[] = rows.map((original) => {
    const { row, filled } = fillFromReports(original, parsed);
    return {
      ...row,
      weekday: weekdayLabel(row.date),
      // 日報(画面記録)のある期間は、予定と実績を日報の「振り返り」タブで読める
      reportLink: row.date >= DAILY_REPORT_START ? `/daily-report?range=day&date=${row.date}&tab=reflection` : null,
      source: row.extracted ? "extracted" : filled ? "report" : "header",
    };
  });

  const calendar: MorningPageModel["calendar"] = { lead: 0, days: [] };
  if (range === "month" && anchor) {
    const byDate = new Map(rows.map((row) => [row.date, row]));
    calendar.lead = weekdayIndex(`${anchor}-01`);
    for (let day = 1; day <= daysIn(anchor); day += 1) {
      const date = `${anchor}-${String(day).padStart(2, "0")}`;
      const row = byDate.get(date);
      calendar.days.push({ date, day, weekday: weekdayIndex(date), written: Boolean(row), future: date > today, minutes: row?.minutes ?? null, chars: row?.chars ?? null, place: row?.place ?? "", group: row ? classifyPlace(row.place) : null });
    }
  }

  const label = range === "month" ? (anchor ? monthLabel(anchor) : "") : range === "year" ? (anchor ? `${anchor}年` : "") : view.firstDate && view.lastDate ? `${monthLabel(view.firstDate.slice(0, 7))}〜${monthLabel(view.lastDate.slice(0, 7))}` : "全期間";

  return {
    range,
    anchor,
    label,
    nav,
    switchTo,
    years,
    figures,
    trend,
    calendar,
    places: placeShares([...placeTotals.entries()].map(([place, count]) => ({ place, count }))),
    days,
    outfit: { firstDate: view.firstOutfitDate, days: view.outfitDays, items: view.outfitItems, brands: view.outfitBrands },
    search: view.search,
    empty: months.length === 0,
  };
}
