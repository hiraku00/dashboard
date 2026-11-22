/** モーニングページ(Obsidian の朝の書き物)の取り込み(POST /api/morning-pages)の入力検証。D1 にも cloudflare:workers にも
 *  触れない純粋なロジック(vitest の "node" project でテストする)。
 *
 *  auto-daily-report の morning_pages.py が、1ページごとに「ヘッダーの表(時間・場所・文字数)」と、
 *  Claude で取り出した「昨日のこと・今日の予定・気になったこと」を送る。本文そのものは送らない。 */

export const MAX_PAGES_PER_REQUEST = 50;
/** 1つの一覧の項目数と、1項目の長さの上限(取り出した結果は短い箇条書き) */
export const MAX_LIST_ITEMS = 16;
export const MAX_ITEM_CHARS = 400;
export const MAX_PLACE_CHARS = 100;
/** 所要時間の上限(分)。これを超える値はヘッダーの書き間違いなので、送り手が null にして送る */
export const MAX_MINUTES = 600;

export type MorningPageInput = {
  date: string;
  startedAt: string | null;
  endedAt: string | null;
  minutes: number | null;
  place: string;
  chars: number | null;
  yesterday: string[];
  plan: string[];
  notes: string[];
  /** 昨日のこと・今日の予定・気になったことを Claude で取り出した(false なら、ヘッダーだけ) */
  extracted: boolean;
};

export type Normalized = { ok: true; page: MorningPageInput } | { ok: false; date: string; error: string };

/** 実在する YYYY-MM-DD か(2026-02-30 のような日付は通さない) */
export function isPageDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function clock(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && CLOCK.test(value) ? value : undefined;
}

function wholeNumber(value: unknown, max: number): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;
}

function list(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const text = item.replace(/\s+/g, " ").trim();
    if (text.length > MAX_ITEM_CHARS) return undefined;
    if (text) items.push(text);
  }
  return items;
}

export function normalizeMorningPage(raw: unknown): Normalized {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const date = typeof input.date === "string" ? input.date : "";
  const fail = (error: string): Normalized => ({ ok: false, date, error });
  if (!isPageDate(input.date)) return fail("dateはYYYY-MM-DDで指定してください。");

  const startedAt = clock(input.startedAt);
  const endedAt = clock(input.endedAt);
  if (startedAt === undefined || endedAt === undefined) return fail("startedAt・endedAtはHH:MMで指定してください。");
  const minutes = wholeNumber(input.minutes, MAX_MINUTES);
  if (minutes === undefined) return fail(`minutesは0〜${MAX_MINUTES}の整数で指定してください。`);
  const chars = wholeNumber(input.chars, 1_000_000);
  if (chars === undefined) return fail("charsは0以上の整数で指定してください。");
  const place = input.place === undefined || input.place === null ? "" : typeof input.place === "string" ? input.place.trim() : undefined;
  if (place === undefined || place.length > MAX_PLACE_CHARS) return fail(`placeは${MAX_PLACE_CHARS}文字までの文字列で指定してください。`);

  const yesterday = list(input.yesterday);
  const plan = list(input.plan);
  const notes = list(input.notes);
  if (!yesterday || !plan || !notes) return fail(`yesterday・plan・notesは${MAX_ITEM_CHARS}文字まで・${MAX_LIST_ITEMS}件までの文字列の配列で指定してください。`);
  if (input.extracted !== undefined && typeof input.extracted !== "boolean") return fail("extractedは真偽値で指定してください。");

  return { ok: true, page: { date, startedAt, endedAt, minutes, place, chars, yesterday, plan, notes, extracted: input.extracted === true } };
}

/** 同じ内容かの判定に使う、キーの並びを固定した JSON(日付は主キーなので含めない) */
export function canonicalContent(page: MorningPageInput): string {
  return JSON.stringify([page.startedAt, page.endedAt, page.minutes, page.place, page.chars, page.yesterday, page.plan, page.notes, page.extracted]);
}
