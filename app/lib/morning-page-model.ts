/** /morning-page の画面に渡す形を、D1から読んだ行(app/lib/queries/morning-page.ts の MorningPageView)から組み立てる。
 *  D1に触れない純粋なロジックで、サーバーで1回だけ呼ぶ(クライアントには集計済みの形だけを渡す)。
 *
 *  日報のある期間(DAILY_REPORT_START 以降)のページは、Claude での取り出しをしていない(ヘッダーだけ)。その期間の
 *  「今日の予定」「昨日のこと」「気がかり」は、日報の6節目「予定と振り返り」から補う。6節目は「日報 D の日の朝の予定」と
 *  「D+1 日の朝の振り返り・気になること」から書かれるので、日報 D の予定はページ D に、PCの外の活動と気がかりはページ D+1 に付ける。 */

import { addDays, weekdayLabel } from "./daily-report-summary.ts";
import { parseReflection } from "./daily-report-reflection.ts";
import { PLACE_GROUPS, classifyPlace, emptyPlaceCounts, type PlaceCounts, type PlaceGroup } from "./morning-page-places.ts";

/** 作業日報(画面記録)の最初の日。これ以降の日は、予定と実績を日報の「振り返り」タブで読める */
export const DAILY_REPORT_START = "2025-12-23";

export type MorningPageRow = {
  date: string;
  startedAt: string | null;
  endedAt: string | null;
  minutes: number | null;
  place: string;
  chars: number | null;
  yesterday: string[];
  plan: string[];
  notes: string[];
  extracted: boolean;
};

export type MonthStat = { month: string; pages: number; avgMinutes: number | null; avgChars: number | null };
/** 月ごと・場所(書いたままの文字)ごとのページ数 */
export type MonthPlace = { month: string; place: string; pages: number };
/** 日報の6節目(Markdown)。reportDate は日報の日付 */
export type ReportReflection = { reportDate: string; markdown: string };
export type SearchHit = { date: string; kind: "yesterday" | "plan" | "notes"; text: string };

export type MorningPageView = {
  /** データのある月(昇順、全期間) */
  months: MonthStat[];
  monthPlaces: MonthPlace[];
  /** 開く月(YYYY-MM)。データが無ければ null */
  month: string | null;
  rows: MorningPageRow[];
  /** 開く月の前日〜月末の日報の6節目(予定・昨日のこと・気がかりを補う) */
  reflections: ReportReflection[];
  /** 気がかりタブで開く年 */
  notesYear: string | null;
  /** notesYear のページから取り出した気がかり(日報の無い期間) */
  yearNotes: { date: string; notes: string[] }[];
  /** notesYear のページに当たる日報の6節目(「気になったこと・持ち越し」の小見出しから後だけでよい) */
  yearReflections: ReportReflection[];
  search: { q: string; hits: SearchHit[] } | null;
};

/** 日報 D の6節目の気がかりを、それを書いた朝のページ(D+1)の日付で返す */
export function concernsFromReflection(reflection: ReportReflection): { date: string; text: string }[] {
  const date = addDays(reflection.reportDate, 1);
  return parseReflection(reflection.markdown).notes.flatMap((note) => (note.kind === "concern" ? [{ date, text: note.text }] : []));
}

export type DaySource = "extracted" | "report" | "header";
export type MorningDay = MorningPageRow & { weekday: string; reportLink: string | null; source: DaySource };
export type DayBar = { date: string; day: number; weekday: string; written: boolean; minutes: number | null; chars: number | null; place: string; group: PlaceGroup | null };
export type TrendPoint = { month: string; label: string; daysInMonth: number; pages: number; avgMinutes: number | null; avgChars: number | null; places: PlaceCounts };
export type PlaceShare = { group: PlaceGroup; label: string; count: number; raw: { place: string; count: number }[] };
export type Concern = { date: string; text: string; source: "page" | "report" };

export type MorningPageModel = {
  month: string | null;
  monthLabel: string;
  prev: string | null;
  next: string | null;
  /** 月の選択(年ごと、データのある月だけ押せる) */
  years: { year: string; months: { month: string; label: string; pages: number }[] }[];
  /** 月の数字(書いた日数、平均の所要時間・文字数) */
  stats: { daysInMonth: number; pages: number; avgMinutes: number | null; avgChars: number | null; longest: { date: string; minutes: number } | null };
  dayBars: DayBar[];
  maxMinutes: number;
  /** 開く月の場所(意味でまとめた分類ごと) */
  places: PlaceShare[];
  /** 月ごとの推移(全期間) */
  trend: TrendPoint[];
  days: MorningDay[];
  notesYear: string | null;
  /** 気がかり(notesYear の分、日付の新しい順) */
  concerns: Concern[];
  search: { q: string; hits: SearchHit[] } | null;
  empty: boolean;
};

export const monthLabel = (month: string) => `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;

export function daysIn(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

const average = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

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

export function buildMorningModel(view: MorningPageView): MorningPageModel {
  const { month, months, rows } = view;
  const known = months.map((entry) => entry.month);
  const index = month ? known.indexOf(month) : -1;
  const years: MorningPageModel["years"] = [];
  for (const entry of months) {
    const year = entry.month.slice(0, 4);
    let group = years.find((item) => item.year === year);
    if (!group) years.push((group = { year, months: [] }));
    group.months.push({ month: entry.month, label: `${Number(entry.month.slice(5, 7))}月`, pages: entry.pages });
  }

  const placesByMonth = new Map<string, PlaceCounts>();
  for (const entry of view.monthPlaces) {
    const counts = placesByMonth.get(entry.month) ?? emptyPlaceCounts();
    counts[classifyPlace(entry.place)] += entry.pages;
    placesByMonth.set(entry.month, counts);
  }
  const trend: TrendPoint[] = months.map((entry) => ({
    month: entry.month,
    label: monthLabel(entry.month),
    daysInMonth: daysIn(entry.month),
    pages: entry.pages,
    avgMinutes: entry.avgMinutes,
    avgChars: entry.avgChars,
    places: placesByMonth.get(entry.month) ?? emptyPlaceCounts(),
  }));

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

  const dayCount = month ? daysIn(month) : 0;
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const dayBars: DayBar[] = [];
  for (let day = 1; day <= dayCount; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const row = byDate.get(date);
    dayBars.push({ date, day, weekday: weekdayLabel(date), written: Boolean(row), minutes: row?.minutes ?? null, chars: row?.chars ?? null, place: row?.place ?? "", group: row ? classifyPlace(row.place) : null });
  }

  const minutes = rows.flatMap((row) => (row.minutes === null ? [] : [row.minutes]));
  const chars = rows.flatMap((row) => (row.chars === null ? [] : [row.chars]));
  const longest = rows.reduce<{ date: string; minutes: number } | null>((best, row) => (row.minutes !== null && (!best || row.minutes > best.minutes) ? { date: row.date, minutes: row.minutes } : best), null);
  const placeCounts = new Map<string, number>();
  for (const row of rows) placeCounts.set(row.place, (placeCounts.get(row.place) ?? 0) + 1);

  const year = view.notesYear;
  const concerns: Concern[] = year
    ? [
        ...view.yearNotes.flatMap((page) => page.notes.map((text) => ({ date: page.date, text, source: "page" as const }))),
        ...view.yearReflections.flatMap((item) => concernsFromReflection(item).map((note) => ({ ...note, source: "report" as const }))),
      ]
        .filter((item) => item.date.startsWith(year))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    : [];

  return {
    month,
    monthLabel: month ? monthLabel(month) : "",
    prev: index > 0 ? known[index - 1] : null,
    next: index >= 0 && index < known.length - 1 ? known[index + 1] : null,
    years,
    stats: { daysInMonth: dayCount, pages: rows.length, avgMinutes: average(minutes), avgChars: average(chars), longest },
    dayBars,
    maxMinutes: Math.max(1, ...minutes),
    places: placeShares([...placeCounts.entries()].map(([place, count]) => ({ place, count }))),
    trend,
    days,
    notesYear: year,
    concerns,
    search: view.search,
    empty: months.length === 0,
  };
}
