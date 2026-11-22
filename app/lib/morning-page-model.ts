/** /morning-page の画面に渡す形を、D1から読んだ行(app/lib/queries/morning-page.ts の MorningPageView)から組み立てる。
 *  D1に触れない純粋なロジックで、サーバーで1回だけ呼ぶ(クライアントには集計済みの形だけを渡す)。 */

import { weekdayLabel } from "./daily-report-summary.ts";

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
export type SearchHit = { date: string; kind: "yesterday" | "plan" | "notes"; text: string };

export type MorningPageView = {
  /** データのある月(昇順、全期間) */
  months: MonthStat[];
  /** 開く月(YYYY-MM)。データが無ければ null */
  month: string | null;
  rows: MorningPageRow[];
  search: { q: string; hits: SearchHit[] } | null;
};

export type DayBar = { date: string; day: number; weekday: string; written: boolean; minutes: number | null; chars: number | null; place: string };

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
  maxChars: number;
  places: { place: string; count: number }[];
  /** 月ごとの推移(全期間) */
  trend: { month: string; label: string; pages: number; avgMinutes: number | null; avgChars: number | null }[];
  maxTrendMinutes: number;
  days: (MorningPageRow & { weekday: string; reportLink: string | null })[];
  /** 抜き出した気がかり(月内、日付の新しい順) */
  notes: { date: string; text: string }[];
  /** 抜き出した結果のある日数(月内)。0 なら「日ごと」「気がかり」は、ヘッダーだけの月 */
  extractedDays: number;
  search: { q: string; hits: SearchHit[] } | null;
  empty: boolean;
};

export const monthLabel = (month: string) => `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;

function daysIn(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

/** 「自宅(co-working)」「自宅（槻木）」→「自宅」のように、かっこの前だけで数える */
export function placeGroup(place: string): string {
  const base = place.replace(/[（(].*$/, "").trim();
  return base || "不明";
}

const average = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

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

  const dayCount = month ? daysIn(month) : 0;
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const dayBars: DayBar[] = [];
  for (let day = 1; day <= dayCount; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const row = byDate.get(date);
    dayBars.push({ date, day, weekday: weekdayLabel(date), written: Boolean(row), minutes: row?.minutes ?? null, chars: row?.chars ?? null, place: row?.place ?? "" });
  }

  const minutes = rows.flatMap((row) => (row.minutes === null ? [] : [row.minutes]));
  const chars = rows.flatMap((row) => (row.chars === null ? [] : [row.chars]));
  const longest = rows.reduce<{ date: string; minutes: number } | null>((best, row) => (row.minutes !== null && (!best || row.minutes > best.minutes) ? { date: row.date, minutes: row.minutes } : best), null);

  const placeCounts = new Map<string, number>();
  for (const row of rows) placeCounts.set(placeGroup(row.place), (placeCounts.get(placeGroup(row.place)) ?? 0) + 1);

  const trend = months.map((entry) => ({ month: entry.month, label: monthLabel(entry.month), pages: entry.pages, avgMinutes: entry.avgMinutes, avgChars: entry.avgChars }));

  const days = rows.map((row) => ({
    ...row,
    weekday: weekdayLabel(row.date),
    // 日報(画面記録)のある期間は、予定と実績を日報の「振り返り」タブで読める
    reportLink: row.date >= DAILY_REPORT_START ? `/daily-report?range=day&date=${row.date}&tab=reflection` : null,
  }));
  const notes = [...rows].reverse().flatMap((row) => row.notes.map((text) => ({ date: row.date, text })));

  return {
    month,
    monthLabel: month ? monthLabel(month) : "",
    prev: index > 0 ? known[index - 1] : null,
    next: index >= 0 && index < known.length - 1 ? known[index + 1] : null,
    years,
    stats: { daysInMonth: dayCount, pages: rows.length, avgMinutes: average(minutes), avgChars: average(chars), longest },
    dayBars,
    maxMinutes: Math.max(1, ...minutes),
    maxChars: Math.max(1, ...chars),
    places: [...placeCounts.entries()].map(([place, count]) => ({ place, count })).sort((a, b) => b.count - a.count || a.place.localeCompare(b.place)),
    trend,
    maxTrendMinutes: Math.max(1, ...trend.map((entry) => entry.avgMinutes ?? 0)),
    days,
    notes,
    extractedDays: rows.filter((row) => row.extracted).length,
    search: view.search,
    empty: months.length === 0,
  };
}
