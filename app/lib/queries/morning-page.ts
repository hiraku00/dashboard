/** モーニングページの読み取り(D1呼び出しを伴う層)。/morning-page の Server Component が呼ぶ。書き込みは app/lib/morning-page-store.ts。
 *  1回の env.DB.batch で、月ごとの集計と場所(全期間。年次・全期間の数字とグラフはここから作る)・最初と最後のページの日付・
 *  期間の服装の集計(段・品名ごと、ブランドごと、書いた日数)・月次なら開く月の行と日報の6節目・(検索語があれば)検索の結果を読む。
 *  日報の6節目は、日報のある期間のページを補うために読む(app/lib/morning-page-model.ts の冒頭)。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes } from "@/app/lib/sql-text";
import { OUTFIT_COLUMNS, hasOutfit, outfitFromRow } from "@/app/lib/outfit";
import { concernsFromReflection, type MonthStat, type MorningPageRow, type MorningPageView, type MorningRange, type OutfitBrandCount, type OutfitItemCount, type SearchHit } from "@/app/lib/morning-page-model";

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

/** 6節目のうち「### 気になったこと・持ち越し」から後だけ(検索は、ここしか使わない) */
const NOTES_PART = "substr(reflection, instr(reflection, '### 気にな'))";
const HAS_NOTES = "instr(reflection, '### 気にな') > 0";
/** 開く月(指定が無ければ、データのある最新の月) */
const OPEN_MONTH = "COALESCE(?1, (SELECT MAX(substr(page_date,1,7)) FROM morning_pages))";

/** 服装の段ごとの (段, 品名, ブランド, 日付)。SCOPE は期間の条件 */
const outfitLayers = (scope: string) => (["top", "middle", "bottom"] as const)
  .map((layer) => `SELECT '${layer}' AS layer, outfit_${layer} AS item, outfit_${layer}_brand AS brand, page_date FROM morning_pages WHERE (outfit_${layer} <> '' OR outfit_${layer}_brand <> '') AND ${scope}`)
  .join(" UNION ALL ");

/** 期間の条件(?1 は月次の月・年次の年。null なら最新) */
function periodScope(range: MorningRange): string {
  if (range === "month") return `substr(page_date,1,7) = ${OPEN_MONTH}`;
  if (range === "year") return "substr(page_date,1,4) = COALESCE(?1, (SELECT MAX(substr(page_date,1,4)) FROM morning_pages))";
  return "(?1 IS NULL OR 1)";
}

/** period: 月次は開く月(null なら最新の月)、年次は年(null なら最新の年)、全期間は anchor なし。月次だけページの行を読む */
export async function morningPageView(period: { range: MorningRange; anchor: string | null }, q: string): Promise<MorningPageView> {
  await ensureSchema({ seed: false });
  const db = env.DB;
  const term = q.trim();
  const withMonth = period.range === "month";
  const requestedMonth = withMonth ? period.anchor : null;
  const scope = periodScope(period.range);
  const layers = outfitLayers(scope);
  const statements = [
    // 年次・全期間の平均を、月の平均の平均でなく正しく出せるよう、合計と件数で読む
    db.prepare(`SELECT substr(page_date,1,7) AS month, COUNT(*) AS pages, SUM(minutes) AS sum_minutes, COUNT(minutes) AS n_minutes,
      SUM(chars) AS sum_chars, COUNT(chars) AS n_chars FROM morning_pages GROUP BY month ORDER BY month`),
    db.prepare("SELECT substr(page_date,1,7) AS month, place, COUNT(*) AS pages FROM morning_pages GROUP BY month, place"),
    db.prepare(`SELECT MIN(page_date) AS first, MAX(page_date) AS last,
      (SELECT MIN(page_date) FROM morning_pages WHERE outfit_top <> '' OR outfit_middle <> '' OR outfit_bottom <> '') AS first_outfit FROM morning_pages`),
    // 服装: 期間の段・品名ごとの着た日数(ブランドは大文字・小文字を揃えて数える)と、ブランドごとの着た日数。
    // ブランドの表示は、いちばん新しく着た日の書き方(SQLite は MAX() と並べた素の列を、MAX の行から取る)
    db.prepare(`SELECT layer, item, brand, COUNT(*) AS days, MAX(page_date) AS last FROM (${layers})
      GROUP BY layer, item, lower(brand) ORDER BY days DESC, last DESC`).bind(period.anchor),
    db.prepare(`SELECT brand, COUNT(DISTINCT page_date) AS days, MAX(page_date) AS last FROM (${layers}) WHERE brand <> ''
      GROUP BY lower(brand) ORDER BY days DESC, last DESC`).bind(period.anchor),
    db.prepare(`SELECT COUNT(*) AS days FROM morning_pages WHERE (outfit_top <> '' OR outfit_middle <> '' OR outfit_bottom <> '') AND ${scope}`).bind(period.anchor),
  ];
  if (withMonth) {
    statements.push(db.prepare(`SELECT page_date, started_at, ended_at, minutes, place, chars, ${OUTFIT_COLUMNS}, yesterday, plan, notes, extracted FROM morning_pages
      WHERE substr(page_date,1,7) = ${OPEN_MONTH} ORDER BY page_date`).bind(requestedMonth));
    // 日報 D の予定はページ D、活動と気がかりはページ D+1 に付けるので、月の前日の日報から読む
    statements.push(db.prepare(`SELECT report_date, reflection FROM daily_reports
      WHERE report_date BETWEEN date(${OPEN_MONTH} || '-01', '-1 day') AND date(${OPEN_MONTH} || '-01', '+1 month', '-1 day') AND reflection <> ''`).bind(requestedMonth));
  }
  if (term) {
    const pattern = likePattern(term);
    statements.push(db.prepare(`SELECT page_date, yesterday, plan, notes FROM morning_pages
      WHERE notes LIKE ?1 ESCAPE '\\' OR plan LIKE ?1 ESCAPE '\\' OR yesterday LIKE ?1 ESCAPE '\\' ORDER BY page_date DESC LIMIT 60`).bind(pattern));
    statements.push(db.prepare(`SELECT report_date, ${NOTES_PART} AS notes_part FROM daily_reports
      WHERE ${HAS_NOTES} AND ${NOTES_PART} LIKE ?1 ESCAPE '\\' ORDER BY report_date DESC LIMIT 60`).bind(pattern));
  }
  const results = await db.batch<Row>(statements);
  const [monthRows, placeRows, spanRows, outfitItemRows, outfitBrandRows, outfitDayRows] = results;
  const [pageRows, reflectionRows] = withMonth ? results.slice(6, 8) : [];
  const [searchRows, searchReflectionRows] = term ? results.slice(withMonth ? 8 : 6) : [];

  const months: MonthStat[] = (monthRows.results ?? []).map((row) => ({
    month: String(row.month),
    pages: Number(row.pages),
    sumMinutes: Number(row.sum_minutes ?? 0),
    minutesCount: Number(row.n_minutes ?? 0),
    sumChars: Number(row.sum_chars ?? 0),
    charsCount: Number(row.n_chars ?? 0),
  }));
  const rows: MorningPageRow[] = (pageRows?.results ?? []).map((row) => ({
    date: String(row.page_date),
    startedAt: (row.started_at as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
    minutes: toNumber(row.minutes),
    place: String(row.place ?? ""),
    chars: toNumber(row.chars),
    outfit: hasOutfit(outfitFromRow(row)) ? outfitFromRow(row) : null,
    yesterday: stringList(row.yesterday),
    plan: stringList(row.plan),
    notes: stringList(row.notes),
    extracted: Number(row.extracted) === 1,
  }));
  const span = spanRows.results?.[0];

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
    firstDate: span?.first ? String(span.first) : null,
    firstOutfitDate: span?.first_outfit ? String(span.first_outfit) : null,
    outfitItems: (outfitItemRows.results ?? []).map((row): OutfitItemCount => ({
      layer: String(row.layer) as OutfitItemCount["layer"],
      item: String(row.item ?? ""),
      brand: String(row.brand ?? ""),
      days: Number(row.days),
      last: String(row.last),
    })),
    outfitDays: Number(outfitDayRows.results?.[0]?.days ?? 0),
    outfitBrands: (outfitBrandRows.results ?? []).map((row): OutfitBrandCount => ({ brand: String(row.brand ?? ""), days: Number(row.days), last: String(row.last) })),
    lastDate: span?.last ? String(span.last) : null,
    month: withMonth ? requestedMonth ?? months.at(-1)?.month ?? null : null,
    rows,
    reflections: (reflectionRows?.results ?? []).map((row) => ({ reportDate: String(row.report_date), markdown: String(row.reflection ?? "") })),
    search,
  };
}
