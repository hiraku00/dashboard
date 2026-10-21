/** ちきりんオプチャの一覧(/chikirin と /api/openchat/programs)の、純粋な決定ロジック。
 *  D1には触れない(app/lib/queries/openchat.ts が呼ぶ)。vitestの "node" project でテストする。
 *
 *  一覧には全スレッドを出す(ちきりんが関わるかどうかは involvement で示す)。
 *  ちきりん以外のコメント本文は、ここのどの関数の出力にも含めない。 */
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes } from "./sql-text.ts";
import { metaFromRow, type Meta } from "./openchat-meta.ts";
import { youTubeThumbnailFromLinks } from "./thumbnail.ts";
import { canonicalUrl } from "./text.ts";

export const PAGE_SIZE = 10;
export const MAX_PAGE = 10000;
export const ROOM = "atsumare-tv";

/** all: 全スレッド(既定)。involved: ちきりんが関わる(旧仕様の一覧と同じ)。thread/comment: involved の内訳。none: 関わらないスレッドだけ。 */
export type ProgramKind = "all" | "involved" | "thread" | "comment" | "none";
export type ProgramsQuery = { q?: string | null; kind?: string | null; sort?: string | null; watch?: string | null; page?: number | string | null; limit?: number | null };

/** 視聴列での絞り込み。unwatched: 視聴列が「視聴」(Watch List で完了)でないもの(未視聴・鑑賞中・—)だけ。
 *  値の名前は、ブックマークしたURL(?watch=unwatched)が効き続けるように残している。 */
export type ProgramWatch = "all" | "unwatched";
export function parseWatch(value: unknown): ProgramWatch {
  return value === "unwatched" ? "unwatched" : "all";
}

function clean(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

const KINDS: ProgramKind[] = ["all", "involved", "thread", "comment", "none"];

/** 並び順。posted: スレッドの起票日時が新しい順(既定)。latest: ちきりんの最新の投稿(コメント、なければスレッド自身)が新しい順。 */
export type ProgramSort = "posted" | "latest";
const SORTS: ProgramSort[] = ["posted", "latest"];

export function parseSort(value: unknown): ProgramSort {
  return (SORTS as string[]).includes(value as string) ? (value as ProgramSort) : "posted";
}

export function parseKind(value: unknown): ProgramKind {
  return (KINDS as string[]).includes(value as string) ? (value as ProgramKind) : "all";
}

/** LIKEの特殊文字(% _ \)を文字として扱う。 */
export function likePattern(term: string): string {
  const safe = truncateUtf8Bytes(term, MAX_LIKE_TERM_BYTES).replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${safe}%`;
}

/** kind ごとの関わり方の条件(SQL)。一覧の絞り込み(buildProgramsFilter)と件数(programCountsSql)の両方がこれを使うので、数字と一覧がずれない。all は条件なし。 */
export const KIND_CONDITIONS: Record<Exclude<ProgramKind, "all">, string> = {
  involved: "(n.author_is_target = 1 OR n.target_comment_count > 0)",
  thread: "n.author_is_target = 1",
  comment: "n.target_comment_count > 0",
  none: "n.author_is_target = 0 AND n.target_comment_count = 0",
};

export type ProgramCounts = Record<ProgramKind, number>;

/** 件数を兼ねた絞り込みの数字: ルームの削除されていないノートを、1回の集計で kind ごとに数える(検索・視聴の絞り込みは無視する全体の数)。
 *  D1の読み取り行数を抑えるため、kind ごとに別のクエリにしない。バインドする値は [ROOM]。 */
export function programCountsSql(): string {
  const sums = (Object.keys(KIND_CONDITIONS) as Array<keyof typeof KIND_CONDITIONS>)
    .map((kind) => `COALESCE(SUM(CASE WHEN ${KIND_CONDITIONS[kind]} THEN 1 ELSE 0 END), 0) AS ${kind}`);
  return `SELECT COUNT(*) AS all_count, ${sums.join(", ")} FROM openchat_notes n WHERE n.room = ? AND n.deleted_at IS NULL`;
}

/** 一覧に載るノート: 既定(all)は全スレッド。kind で、ちきりんの関わり方に絞り込める。 */
export function buildProgramsFilter(query: ProgramsQuery): { where: string; values: unknown[]; limit: number; offset: number; page: number; kind: ProgramKind; sort: ProgramSort; watch: ProgramWatch } {
  const kind = parseKind(query.kind);
  const clauses = ["n.room = ?", "n.deleted_at IS NULL"];
  const values: unknown[] = [ROOM];
  if (kind !== "all") clauses.push(KIND_CONDITIONS[kind]);   // all: 関わり方の条件を付けない

  const q = clean(query.q, 120);
  if (q) {
    const pattern = likePattern(q);
    // 画面に出ている情報だけを探す: スレッド主の投稿(本文)、ちきりんのコメント本文、放送情報(放送局・番組名・番組タイトル)。
    // 画面に出ないOCRの値(ノートの1行目 program_title・リンクカードの題名 link_title)は探さない。リアクションの顔アイコンの
    // 誤読(「あききます。」など)が入っていて、画面のどこにも無い文字でヒットしていた(2026-10-10)。1行目は本文の先頭と同じ。
    // ほかの人のコメント本文は、検索の対象にしない(件数などから内容が推測できてしまうため)。
    clauses.push(`(n.body_text LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM openchat_comments c WHERE c.note_id = n.id AND c.is_target = 1 AND c.deleted_at IS NULL AND c.body_text LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM openchat_note_meta m WHERE m.note_id = n.id
        AND (m.broadcaster LIKE ? ESCAPE '\\' OR m.program_name LIKE ? ESCAPE '\\' OR m.episode_title LIKE ? ESCAPE '\\')))`);
    values.push(pattern, pattern, pattern, pattern, pattern);
  }
  const requested = Math.floor(Number(query.limit));
  const limit = requested > 0 ? Math.min(50, requested) : PAGE_SIZE;
  const wantedPage = Math.floor(Number(query.page));
  const page = wantedPage >= 1 ? Math.min(wantedPage, MAX_PAGE) : 1;
  return { where: `WHERE ${clauses.join(" AND ")}`, values, limit, offset: (page - 1) * limit, page, kind, sort: parseSort(query.sort), watch: parseWatch(query.watch) };
}

/** ちきりんの最新の投稿の日時(一覧の「最新ちきりん」列、toProgram の latestAt と同じ): ちきりんのコメントのうち最新、なければちきりんが立てたスレッド自身。関わりが無ければ NULL。 */
const LATEST_TARGET_AT = `COALESCE(
  (SELECT MAX(c.posted_at) FROM openchat_comments c WHERE c.note_id = n.id AND c.is_target = 1 AND c.deleted_at IS NULL),
  CASE WHEN n.author_is_target = 1 THEN n.posted_at END)`;

/** latest は、ちきりんが関わらないスレッド(日時が無い)を最後にまとめる。同じ日時は起票日時の新しい順。 */
export function programsOrderBy(sort: ProgramSort): string {
  if (sort === "latest") return `ORDER BY (${LATEST_TARGET_AT}) IS NULL, ${LATEST_TARGET_AT} DESC, n.posted_at DESC, n.id ASC`;
  return "ORDER BY n.posted_at DESC, n.id ASC";
}

export const PROGRAMS_ORDER_BY = programsOrderBy("posted");

export type ProgramComment = { id: string; bodyText: string; postedAt: string; precision: string };
/** ちきりんの関わり方: thread=ちきりんが立てたスレッド、comment=他の人のスレッドにちきりんのコメントがある、none=どちらでもない。 */
export type Involvement = "thread" | "comment" | "none";
export type Program = {
  noteId: string; programTitle: string; linkUrl: string;
  noteAuthor: string; noteByTarget: boolean; notePostedAt: string; notePrecision: string;
  /** ちきりんが立てたノートのときだけ本文が入る。ほかの人のノートは null。 */
  targetBody: string | null;
  /** スレッド主の投稿(番組の情報)。全スレッドに入る。 */
  noteBody: string;
  /** ちきりんの関わり方。一覧の「ちきりん」列・絞り込みに使う。 */
  involvement: Involvement;
  targetComments: ProgramComment[];
  /** ちきりんの最新の投稿(コメント、なければスレッド自身)の日時。関わりが無ければ空。一覧の列に使う。 */
  latestAt: string; latestPrecision: string;
  /** 人が編集した情報(放送局・その日の放送タイトル・リンク)。未編集なら空。 */
  meta: Meta;
  /** 取得の状態。要確認(コメント件数が合わず再確認待ち)・本文が途中の可能性。どちらでもなければ空。 */
  issues: string[];
  /** このスレッド・ちきりんの投稿を、collector が最初に見つけた日時のうち最新のもの(UTC, ISO)。「新着」の判定に使う。 */
  newestSeenAt: string;
  commentCount: number; lastCheckedAt: string;
  /** 一覧のサムネイル(Watch List と同じ: YouTube はリンクから決め、それ以外はリンク先の og:image)。無ければ空。 */
  thumbnailUrl: string;
};

/** ノート行とちきりんのコメント行から、画面・APIの形にする。ノート行はどのスレッドでもよい。ほかの人のコメントは受け取らない。 */
function isoUtc(value: unknown): string {
  const t = new Date(String(value ?? "")).getTime();
  return Number.isNaN(t) ? "" : new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
}

export function toProgram(note: Record<string, unknown>, targetComments: Array<Record<string, unknown>>): Program {
  const p = buildProgram(note, targetComments);
  // 新着の判定: スレッドが見つかった日時(全スレッド共通)と、ちきりんのコメントが見つかった日時のうち、最新のもの。
  const seen = [isoUtc(note.first_seen_at), ...targetComments.filter((c) => Number(c.is_target ?? 1) === 1).map((c) => isoUtc(c.first_seen_at))];
  p.newestSeenAt = seen.filter(Boolean).sort().pop() ?? "";
  const last = p.targetComments[p.targetComments.length - 1];
  p.latestAt = last ? last.postedAt : p.noteByTarget ? p.notePostedAt : "";
  p.latestPrecision = last ? last.precision : p.noteByTarget ? p.notePrecision : "";
  return p;
}

function buildProgram(note: Record<string, unknown>, targetComments: Array<Record<string, unknown>>): Program {
  const byTarget = Number(note.author_is_target) === 1;
  const filteredComments = targetComments
    .filter((c) => Number(c.is_target ?? 1) === 1)
    .map((c) => ({ id: String(c.id), bodyText: String(c.body_text ?? ""), postedAt: String(c.posted_at), precision: String(c.posted_at_precision) }));
  const involvement: Involvement = byTarget ? "thread" : filteredComments.length > 0 ? "comment" : "none";
  return {
    noteId: String(note.id), programTitle: String(note.program_title ?? ""),
    linkUrl: String(note.link_url ?? ""), noteAuthor: String(note.author_name ?? ""),
    noteByTarget: byTarget, notePostedAt: String(note.posted_at), notePrecision: String(note.posted_at_precision),
    targetBody: byTarget ? String(note.body_text ?? "") : null,
    noteBody: String(note.body_text ?? ""),
    involvement,
    targetComments: filteredComments,
    latestAt: "", latestPrecision: "", issues: programIssues(note), newestSeenAt: "", meta: metaFromRow(note.meta_row as Record<string, unknown> | undefined),
    commentCount: Number(note.comment_count ?? 0), lastCheckedAt: String(note.last_checked_at ?? ""),
    thumbnailUrl: "",
  };
}

/** サムネイルを探すリンク: 一覧のリンク列の1件目と同じ(編集したリンクがあればその1件目、無ければノートのリンクカード)。 */
export function thumbnailSourceUrl(program: Pick<Program, "meta" | "linkUrl">): string {
  return program.meta.links[0]?.url || program.linkUrl;
}

export type CachedThumbnail = { source_url: unknown; thumbnail_url: unknown };

/** 一覧の各ノートのサムネイル。YouTube はリンクから決まる(保存しない)。それ以外は、放送情報の保存時に取得して
 *  保存したもの(openchat_note_thumbnails)を使う。ただし探したリンクが今のリンクと違えば、古い画像なので使わない。 */
export function resolveThumbnails(programs: Array<Pick<Program, "noteId" | "meta" | "linkUrl">>, cached: Map<string, CachedThumbnail>): Map<string, string> {
  const thumbnails = new Map<string, string>();
  for (const p of programs) {
    const url = thumbnailSourceUrl(p);
    if (!url) continue;
    const youTube = youTubeThumbnailFromLinks([{ url }]);
    if (youTube) { thumbnails.set(p.noteId, youTube); continue; }
    const row = cached.get(p.noteId);
    if (row && String(row.source_url) === url && row.thumbnail_url) thumbnails.set(p.noteId, String(row.thumbnail_url));
  }
  return thumbnails;
}

/** 取得の状態: 画面で気づけるように、要確認の理由を文にする(collector が警告に出したものと同じ内容)。 */
export function programIssues(note: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if (Number(note.needs_recheck) === 1) issues.push("コメントの件数が表示と合わず、再確認待ちです（次回の同期でやり直します）。");
  if (note.body_complete !== undefined && Number(note.body_complete) !== 1) issues.push("本文が途中までしか読めていない可能性があります（「もっと見る」を開けませんでした）。");
  return issues;
}

/** 画面の日時表示(日本時間). "09.23 21:46"(mm.dd hh:mm。データは年つきのUTCで持ち、表示だけ年を省く)。 */
export function formatPostedAt(postedAt: string, precision: string): string {
  const date = new Date(postedAt);
  if (Number.isNaN(date.getTime())) return "";
  const jst = new Date(date.getTime() + 9 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = `${pad(jst.getUTCMonth() + 1)}.${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
  return text;
}

/** Watch List での登録状況: url=保存URL、title=項目名、count=項目数、status=同じリンクの項目のうち最も進んだ状態(完了 > 鑑賞中 > 未着手 > 見送り)、watchedOn=完了日。 */
export type WatchedInfo = { url: string; title: string; count: number; status: string; watchedOn: string | null };
/** キーは watchedKey(ノートID, 一覧に出るURL)。同じURLでもノートごとに照合結果が違いうるため、ノートごとに持つ。 */
export type WatchedLinks = Record<string, WatchedInfo>;
export function watchedKey(noteId: string, url: string): string {
  return `${noteId}\n${url}`;
}

/** Watch List の「リンク×項目」1行。canonical_url は正規化したURL。 */
export type WatchedRow = { canonicalUrl: string; url: string; itemId: string; title: string; status: string; watchedOn: string | null };

const WATCH_RANK: Record<string, number> = { completed: 3, in_progress: 2, backlog: 1 };
const WATCH_STATUS_BY_RANK: Record<number, string> = { 3: "completed", 2: "in_progress", 1: "backlog" };

/** 回のタイトルを比べるための形。空白・記号を除き、全角半角などをそろえる。 */
export function normalizeEpisodeTitle(value: string): string {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}_]+/gu, "").toLowerCase();
}

/** 一覧に出るリンクのURL(編集したリンク + ノートのリンクカード)を正規化して返す。 */
export function programLinkUrls(p: Pick<Program, "linkUrl" | "meta">): string[] {
  return [...new Set([...p.meta.links.map((l) => l.url), p.linkUrl].filter(Boolean))];
}

/** 一覧のリンクが Watch List にも登録されているかを、正規化したURLで照合する。
 *  番組の一覧ページのように複数の項目が同じURLを共有しているときは、URLだけでは回を決められないので、
 *  ノートの「その日の放送タイトル」と項目のタイトルが一致する項目だけを登録済とする(一致しなければ登録済にしない)。 */
export function matchWatched(programs: Array<Pick<Program, "noteId" | "linkUrl" | "meta">>, rows: WatchedRow[]): WatchedLinks {
  const byCanonical = new Map<string, WatchedRow[]>();
  for (const r of rows) byCanonical.set(r.canonicalUrl, [...(byCanonical.get(r.canonicalUrl) ?? []), r]);
  const watched: WatchedLinks = {};
  for (const p of programs) {
    const episode = normalizeEpisodeTitle(p.meta.episodeTitle);
    for (const shown of programLinkUrls(p)) {
      let items = byCanonical.get(canonicalUrl(shown)) ?? [];
      if (new Set(items.map((r) => r.itemId)).size > 1) items = episode ? items.filter((r) => normalizeEpisodeTitle(r.title) === episode) : [];
      if (!items.length) continue;
      const rank = Math.max(...items.map((r) => WATCH_RANK[r.status] ?? 0));
      const completed = items.filter((r) => r.status === "completed" && r.watchedOn).map((r) => r.watchedOn as string).sort().at(-1);
      watched[watchedKey(p.noteId, shown)] = {
        url: items.map((r) => r.url).sort()[0], title: items.map((r) => r.title).sort()[0] ?? "",
        count: new Set(items.map((r) => r.itemId)).size, status: WATCH_STATUS_BY_RANK[rank] ?? "dropped", watchedOn: completed ?? null,
      };
    }
  }
  return watched;
}

/** 視聴列が「視聴」(Watch List で完了)になるか。画面(app/chikirin-app.tsx の displayLinks)と同じく、
 *  編集したリンクがあればそれ、無ければノートのリンクカードを見て、そのどれかが完了した項目に結びつけば true。 */
export function isWatchCompleted(p: Pick<Program, "noteId" | "linkUrl" | "meta">, watched: WatchedLinks): boolean {
  const shown = p.meta.links.length > 0 ? p.meta.links.map((l) => l.url) : [p.linkUrl].filter(Boolean);
  return shown.some((url) => watched[watchedKey(p.noteId, url)]?.status === "completed");
}
