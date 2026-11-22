/** モーニングページの読み取り(D1呼び出しを伴う層)。/morning-page の Server Component が呼ぶ。書き込みは app/lib/morning-page-store.ts。
 *  1回の env.DB.batch で、月ごとの集計と場所(全期間)・開く月の行と日報の6節目・気がかりタブの年の分・(検索語があれば)検索の結果を読む。
 *  日報の6節目は、日報のある期間のページを補うために読む(app/lib/morning-page-model.ts の冒頭)。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes } from "@/app/lib/sql-text";
import { concernsFromReflection, type MonthStat, type MorningPageRow, type MorningPageView, type SearchHit } from "@/app/lib/morning-page-model";

export type { MorningPageView };

type Row = Record<string, unknown>;

export const isYear = (value: unknown): value is string => typeof value === "string" && /^\d{4}$/.test(value);

export const isMonth = (value: unknown): value is string => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

const toNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function stringList(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** LIKE の特殊文字(% _ \)を文字として扱い、D1 の50バイト上限に収める */
function likePattern(term: string): string {
  return `%${truncateUtf8Bytes(term, MAX_LIKE_TERM_BYTES).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** 6節目のうち「### 気になったこと・持ち越し」から後だけ(気がかりの一覧と検索は、ここしか使わない) */
const NOTES_PART = "substr(reflection, instr(reflection, '### 気にな'))";
const HAS_NOTES = "instr(reflection, '### 気にな') > 0";
/** 開く月(指定が無ければ、データのある最新の月) */
const OPEN_MONTH = "COALESCE(?1, (SELECT MAX(substr(page_date,1,7)) FROM morning_pages))";

export async function morningPageView(requestedMonth: string | null, requestedYear: string | null, q: string): Promise<MorningPageView> {
  await ensureSchema({ seed: false });
  const db = env.DB;
  const term = q.trim();
  const year = `COALESCE(?2, substr(${OPEN_MONTH},1,4))`;
  const statements = [
    db.prepare("SELECT substr(page_date,1,7) AS month, COUNT(*) AS pages, AVG(minutes) AS avg_minutes, AVG(chars) AS avg_chars FROM morning_pages GROUP BY month ORDER BY month"),
    db.prepare("SELECT substr(page_date,1,7) AS month, place, COUNT(*) AS pages FROM morning_pages GROUP BY month, place"),
    db.prepare(`SELECT page_date, started_at, ended_at, minutes, place, chars, yesterday, plan, notes, extracted FROM morning_pages
      WHERE substr(page_date,1,7) = ${OPEN_MONTH} ORDER BY page_date`).bind(requestedMonth),
    // 日報 D の予定はページ D、活動と気がかりはページ D+1 に付けるので、月の前日の日報から読む
    db.prepare(`SELECT report_date, reflection FROM daily_reports
      WHERE report_date BETWEEN date(${OPEN_MONTH} || '-01', '-1 day') AND date(${OPEN_MONTH} || '-01', '+1 month', '-1 day') AND reflection <> ''`).bind(requestedMonth),
    db.prepare(`SELECT page_date, notes FROM morning_pages WHERE substr(page_date,1,4) = ${year} AND notes <> '[]'`).bind(requestedMonth, requestedYear),
    db.prepare(`SELECT report_date, ${NOTES_PART} AS notes_part FROM daily_reports
      WHERE report_date BETWEEN date(${year} || '-01-01', '-1 day') AND ${year} || '-12-30' AND ${HAS_NOTES}`).bind(requestedMonth, requestedYear),
  ];
  if (term) {
    const pattern = likePattern(term);
    statements.push(db.prepare(`SELECT page_date, yesterday, plan, notes FROM morning_pages
      WHERE notes LIKE ?1 ESCAPE '\\' OR plan LIKE ?1 ESCAPE '\\' OR yesterday LIKE ?1 ESCAPE '\\' ORDER BY page_date DESC LIMIT 60`).bind(pattern));
    statements.push(db.prepare(`SELECT report_date, ${NOTES_PART} AS notes_part FROM daily_reports
      WHERE ${HAS_NOTES} AND ${NOTES_PART} LIKE ?1 ESCAPE '\\' ORDER BY report_date DESC LIMIT 60`).bind(pattern));
  }
  const [monthRows, placeRows, pageRows, reflectionRows, yearNoteRows, yearReflectionRows, searchRows, searchReflectionRows] = await db.batch<Row>(statements);

  const months: MonthStat[] = (monthRows.results ?? []).map((row) => ({
    month: String(row.month),
    pages: Number(row.pages),
    avgMinutes: toNumber(row.avg_minutes) === null ? null : Math.round(Number(row.avg_minutes)),
    avgChars: toNumber(row.avg_chars) === null ? null : Math.round(Number(row.avg_chars)),
  }));
  const rows: MorningPageRow[] = (pageRows.results ?? []).map((row) => ({
    date: String(row.page_date),
    startedAt: (row.started_at as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
    minutes: toNumber(row.minutes),
    place: String(row.place ?? ""),
    chars: toNumber(row.chars),
    yesterday: stringList(row.yesterday),
    plan: stringList(row.plan),
    notes: stringList(row.notes),
    extracted: Number(row.extracted) === 1,
  }));
  const month = requestedMonth ?? months.at(-1)?.month ?? null;

  let search: MorningPageView["search"] = null;
  if (term) {
    const needle = term.toLowerCase();
    const hits: SearchHit[] = [];
    for (const row of searchRows?.results ?? []) {
      for (const kind of ["notes", "plan", "yesterday"] as const) {
        for (const text of stringList(row[kind])) {
          if (text.toLowerCase().includes(needle)) hits.push({ date: String(row.page_date), kind, text });
        }
      }
    }
    for (const row of searchReflectionRows?.results ?? []) {
      for (const note of concernsFromReflection({ reportDate: String(row.report_date), markdown: String(row.notes_part ?? "") })) {
        if (note.text.toLowerCase().includes(needle)) hits.push({ date: note.date, kind: "notes", text: note.text });
      }
    }
    hits.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    search = { q: term, hits };
  }
  return {
    months,
    monthPlaces: (placeRows.results ?? []).map((row) => ({ month: String(row.month), place: String(row.place ?? ""), pages: Number(row.pages) })),
    month,
    rows,
    reflections: (reflectionRows.results ?? []).map((row) => ({ reportDate: String(row.report_date), markdown: String(row.reflection ?? "") })),
    notesYear: requestedYear ?? month?.slice(0, 4) ?? null,
    yearNotes: (yearNoteRows.results ?? []).map((row) => ({ date: String(row.page_date), notes: stringList(row.notes) })),
    yearReflections: (yearReflectionRows.results ?? []).map((row) => ({ reportDate: String(row.report_date), markdown: String(row.notes_part ?? "") })),
    search,
  };
}
