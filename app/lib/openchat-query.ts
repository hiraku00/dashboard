/** ちきりんオプチャの一覧(/chikirin と /api/openchat/programs)の、純粋な決定ロジック。
 *  D1には触れない(app/lib/queries/openchat.ts が呼ぶ)。vitestの "node" project でテストする。
 *
 *  ちきりんさん以外のコメント本文は、ここのどの関数の出力にも含めない。 */
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes } from "./sql-text.ts";

export const PAGE_SIZE = 20;
export const ROOM = "atsumare-tv";

export type ProgramKind = "all" | "thread" | "comment";
export type ProgramsQuery = { q?: string | null; kind?: string | null; cursor?: string | null; limit?: number | null };
export type Cursor = { postedAt: string; id: string };

function clean(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function parseKind(value: unknown): ProgramKind {
  return value === "thread" || value === "comment" ? value : "all";
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
}

export function encodeCursor(cursor: Cursor): string {
  return toBase64Url(JSON.stringify([cursor.postedAt, cursor.id]));
}

/** 壊れたカーソルは null(先頭から読む)。SQLに入れるので形式を厳しく確かめる。 */
export function decodeCursor(value: unknown): Cursor | null {
  if (typeof value !== "string" || !value || value.length > 200) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(value));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [postedAt, id] = parsed;
    if (typeof postedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(postedAt)) return null;
    if (typeof id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return null;
    return { postedAt, id };
  } catch {
    return null;
  }
}

/** LIKEの特殊文字(% _ \)を文字として扱う。 */
export function likePattern(term: string): string {
  const safe = truncateUtf8Bytes(term, MAX_LIKE_TERM_BYTES).replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${safe}%`;
}

/** 一覧に載るノート: ちきりんさんが立てたノート、または、ちきりんさんのコメントがあるノート。 */
export function buildProgramsFilter(query: ProgramsQuery): { where: string; values: unknown[]; limit: number; kind: ProgramKind } {
  const kind = parseKind(query.kind);
  const clauses = ["n.room = ?", "n.deleted_at IS NULL"];
  const values: unknown[] = [ROOM];
  if (kind === "thread") clauses.push("n.author_is_target = 1");
  else if (kind === "comment") clauses.push("n.target_comment_count > 0");
  else clauses.push("(n.author_is_target = 1 OR n.target_comment_count > 0)");

  const q = clean(query.q, 120);
  if (q) {
    const pattern = likePattern(q);
    // 番組名(ノートの1行目・リンクカードの題名)、ちきりんさん本人のノート本文、ちきりんさんのコメント本文だけを探す。
    // ほかの人のコメント本文は、検索の対象にもしない(件数などから内容が推測できてしまうため)。
    clauses.push(`(n.program_title LIKE ? ESCAPE '\\' OR n.link_title LIKE ? ESCAPE '\\'
      OR (n.author_is_target = 1 AND n.body_text LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM openchat_comments c WHERE c.note_id = n.id AND c.is_target = 1 AND c.deleted_at IS NULL AND c.body_text LIKE ? ESCAPE '\\'))`);
    values.push(pattern, pattern, pattern, pattern);
  }
  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    clauses.push("(n.posted_at < ? OR (n.posted_at = ? AND n.id > ?))");
    values.push(cursor.postedAt, cursor.postedAt, cursor.id);
  }
  const requested = Math.floor(Number(query.limit));
  const limit = requested > 0 ? Math.min(50, requested) : PAGE_SIZE;
  return { where: `WHERE ${clauses.join(" AND ")}`, values, limit, kind };
}

export const PROGRAMS_ORDER_BY = "ORDER BY n.posted_at DESC, n.id ASC";

export type ProgramComment = { id: string; bodyText: string; postedAt: string; precision: string };
export type Program = {
  noteId: string; programTitle: string; linkTitle: string; linkUrl: string;
  noteAuthor: string; noteByTarget: boolean; notePostedAt: string; notePrecision: string;
  /** ちきりんさんが立てたノートのときだけ本文が入る。ほかの人のノートは null。 */
  targetBody: string | null;
  targetComments: ProgramComment[];
  commentCount: number; lastCheckedAt: string;
};

/** ノート行とちきりんさんのコメント行から、画面・APIの形にする。ほかの人のコメントは受け取らない。 */
export function toProgram(note: Record<string, unknown>, targetComments: Array<Record<string, unknown>>): Program {
  const byTarget = Number(note.author_is_target) === 1;
  return {
    noteId: String(note.id), programTitle: String(note.program_title ?? ""), linkTitle: String(note.link_title ?? ""),
    linkUrl: String(note.link_url ?? ""), noteAuthor: byTarget ? String(note.author_name ?? "") : String(note.author_name ?? ""),
    noteByTarget: byTarget, notePostedAt: String(note.posted_at), notePrecision: String(note.posted_at_precision),
    targetBody: byTarget ? String(note.body_text ?? "") : null,
    targetComments: targetComments
      .filter((c) => Number(c.is_target ?? 1) === 1)
      .map((c) => ({ id: String(c.id), bodyText: String(c.body_text ?? ""), postedAt: String(c.posted_at), precision: String(c.posted_at_precision) })),
    commentCount: Number(note.comment_count ?? 0), lastCheckedAt: String(note.last_checked_at ?? ""),
  };
}

/** 「約」を付けるべき時刻か。 */
export function isApproximate(precision: string): boolean {
  return precision !== "exact";
}

/** 画面の日時表示(日本時間). "2026.09.23 21:46"。概算のものには「約」を付ける。 */
export function formatPostedAt(postedAt: string, precision: string): string {
  const date = new Date(postedAt);
  if (Number.isNaN(date.getTime())) return "";
  const jst = new Date(date.getTime() + 9 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = `${jst.getUTCFullYear()}.${pad(jst.getUTCMonth() + 1)}.${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
  return isApproximate(precision) ? `約 ${text}` : text;
}
