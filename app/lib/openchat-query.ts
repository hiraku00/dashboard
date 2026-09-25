/** ちきりんオプチャの一覧(/chikirin と /api/openchat/programs)の、純粋な決定ロジック。
 *  D1には触れない(app/lib/queries/openchat.ts が呼ぶ)。vitestの "node" project でテストする。
 *
 *  ちきりん以外のコメント本文は、ここのどの関数の出力にも含めない。 */
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes } from "./sql-text.ts";
import { metaFromRow, type Meta } from "./openchat-meta.ts";

export const PAGE_SIZE = 20;
export const MAX_PAGE = 10000;
export const ROOM = "atsumare-tv";

export type ProgramKind = "all" | "thread" | "comment";
export type ProgramsQuery = { q?: string | null; kind?: string | null; page?: number | string | null; limit?: number | null };

function clean(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function parseKind(value: unknown): ProgramKind {
  return value === "thread" || value === "comment" ? value : "all";
}

/** LIKEの特殊文字(% _ \)を文字として扱う。 */
export function likePattern(term: string): string {
  const safe = truncateUtf8Bytes(term, MAX_LIKE_TERM_BYTES).replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${safe}%`;
}

/** 一覧に載るノート: ちきりんが立てたノート、または、ちきりんのコメントがあるノート。 */
export function buildProgramsFilter(query: ProgramsQuery): { where: string; values: unknown[]; limit: number; offset: number; page: number; kind: ProgramKind } {
  const kind = parseKind(query.kind);
  const clauses = ["n.room = ?", "n.deleted_at IS NULL"];
  const values: unknown[] = [ROOM];
  if (kind === "thread") clauses.push("n.author_is_target = 1");
  else if (kind === "comment") clauses.push("n.target_comment_count > 0");
  else clauses.push("(n.author_is_target = 1 OR n.target_comment_count > 0)");

  const q = clean(query.q, 120);
  if (q) {
    const pattern = likePattern(q);
    // 番組名(ノートの1行目・リンクカードの題名)、一覧に載るノートの本文(スレッド主の投稿=番組の情報)、ちきりんのコメント本文を探す。
    // 一覧に載らないノートと、ほかの人のコメント本文は、検索の対象にもしない(件数などから内容が推測できてしまうため)。
    clauses.push(`(n.program_title LIKE ? ESCAPE '\\' OR n.link_title LIKE ? ESCAPE '\\'
      OR n.body_text LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM openchat_comments c WHERE c.note_id = n.id AND c.is_target = 1 AND c.deleted_at IS NULL AND c.body_text LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM openchat_note_meta m WHERE m.note_id = n.id AND (m.broadcaster LIKE ? ESCAPE '\\' OR m.episode_title LIKE ? ESCAPE '\\')))`);
    values.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }
  const requested = Math.floor(Number(query.limit));
  const limit = requested > 0 ? Math.min(50, requested) : PAGE_SIZE;
  const wantedPage = Math.floor(Number(query.page));
  const page = wantedPage >= 1 ? Math.min(wantedPage, MAX_PAGE) : 1;
  return { where: `WHERE ${clauses.join(" AND ")}`, values, limit, offset: (page - 1) * limit, page, kind };
}

export const PROGRAMS_ORDER_BY = "ORDER BY n.posted_at DESC, n.id ASC";

export type ProgramComment = { id: string; bodyText: string; postedAt: string; precision: string };
export type Program = {
  noteId: string; programTitle: string; linkTitle: string; linkUrl: string;
  noteAuthor: string; noteByTarget: boolean; notePostedAt: string; notePrecision: string;
  /** ちきりんが立てたノートのときだけ本文が入る。ほかの人のノートは null。 */
  targetBody: string | null;
  /** スレッド主の投稿(番組の情報)。一覧に載るノートは、ちきりんが立てたか、ちきりんのコメントがあるノートだけ。 */
  noteBody: string;
  targetComments: ProgramComment[];
  /** ちきりんの最新の投稿(コメント、なければスレッド自身)の日時。一覧の列に使う。 */
  latestAt: string; latestPrecision: string;
  /** 人が編集した情報(放送局・その日の放送タイトル・リンク)。未編集なら空。 */
  meta: Meta;
  commentCount: number; lastCheckedAt: string;
};

/** ノート行とちきりんのコメント行から、画面・APIの形にする。ノート行は、一覧に載る(ちきりんが関わる)ものだけを渡すこと。ほかの人のコメントは受け取らない。 */
export function toProgram(note: Record<string, unknown>, targetComments: Array<Record<string, unknown>>): Program {
  const p = buildProgram(note, targetComments);
  const last = p.targetComments[p.targetComments.length - 1];
  p.latestAt = last ? last.postedAt : p.noteByTarget ? p.notePostedAt : "";
  p.latestPrecision = last ? last.precision : p.noteByTarget ? p.notePrecision : "";
  return p;
}

function buildProgram(note: Record<string, unknown>, targetComments: Array<Record<string, unknown>>): Program {
  const byTarget = Number(note.author_is_target) === 1;
  return {
    noteId: String(note.id), programTitle: String(note.program_title ?? ""), linkTitle: String(note.link_title ?? ""),
    linkUrl: String(note.link_url ?? ""), noteAuthor: byTarget ? String(note.author_name ?? "") : String(note.author_name ?? ""),
    noteByTarget: byTarget, notePostedAt: String(note.posted_at), notePrecision: String(note.posted_at_precision),
    targetBody: byTarget ? String(note.body_text ?? "") : null,
    noteBody: String(note.body_text ?? ""),
    targetComments: targetComments
      .filter((c) => Number(c.is_target ?? 1) === 1)
      .map((c) => ({ id: String(c.id), bodyText: String(c.body_text ?? ""), postedAt: String(c.posted_at), precision: String(c.posted_at_precision) })),
    latestAt: "", latestPrecision: "", meta: metaFromRow(note.meta_row as Record<string, unknown> | undefined),
    commentCount: Number(note.comment_count ?? 0), lastCheckedAt: String(note.last_checked_at ?? ""),
  };
}

/** 「約」を付けるべき時刻か。 */
export function isApproximate(precision: string): boolean {
  return precision !== "exact";
}

/** 画面の日時表示(日本時間). "26/09/23 21:46"(yy/mm/dd hh:mm)。概算のものには「約」を付ける。 */
export function formatPostedAt(postedAt: string, precision: string): string {
  const date = new Date(postedAt);
  if (Number.isNaN(date.getTime())) return "";
  const jst = new Date(date.getTime() + 9 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = `${pad(jst.getUTCFullYear() % 100)}/${pad(jst.getUTCMonth() + 1)}/${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
  return isApproximate(precision) ? `約${text}` : text;
}
