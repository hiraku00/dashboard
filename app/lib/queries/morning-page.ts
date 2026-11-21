/** モーニングページの読み取り(D1呼び出しを伴う層)。/morning-page の Server Component が呼ぶ。書き込みは app/lib/morning-page-store.ts。
 *  1回の env.DB.batch で、月ごとの集計(全期間)・開く月の行・(検索語があれば)検索の結果を読む。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes } from "@/app/lib/sql-text";
import type { MonthStat, MorningPageRow, MorningPageView, SearchHit } from "@/app/lib/morning-page-model";

export type { MorningPageView };

type Row = Record<string, unknown>;

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

export async function morningPageView(requestedMonth: string | null, q: string): Promise<MorningPageView> {
  await ensureSchema({ seed: false });
  const db = env.DB;
  const term = q.trim();
  const statements = [
    db.prepare("SELECT substr(page_date,1,7) AS month, COUNT(*) AS pages, AVG(minutes) AS avg_minutes, AVG(chars) AS avg_chars FROM morning_pages GROUP BY month ORDER BY month"),
    db.prepare(`SELECT page_date, started_at, ended_at, minutes, place, chars, yesterday, plan, notes, extracted FROM morning_pages
      WHERE substr(page_date,1,7) = COALESCE(?1, (SELECT MAX(substr(page_date,1,7)) FROM morning_pages)) ORDER BY page_date`).bind(requestedMonth),
  ];
  if (term) {
    const pattern = likePattern(term);
    statements.push(db.prepare(`SELECT page_date, yesterday, plan, notes FROM morning_pages
      WHERE notes LIKE ?1 ESCAPE '\\' OR plan LIKE ?1 ESCAPE '\\' OR yesterday LIKE ?1 ESCAPE '\\' ORDER BY page_date DESC LIMIT 60`).bind(pattern));
  }
  const [monthRows, pageRows, searchRows] = await db.batch<Row>(statements);

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
    search = { q: term, hits };
  }
  return { months, month: requestedMonth ?? months.at(-1)?.month ?? null, rows, search };
}
