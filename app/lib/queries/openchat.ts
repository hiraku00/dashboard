/** ちきりんオプチャの読み取り(D1呼び出しを伴う層)。/chikirin ページの Server Component と
 *  app/api/openchat/* の両方がこれを呼ぶ。純粋な決定ロジック(WHERE句・カーソル・整形)は
 *  app/lib/openchat-query.ts にある(cloudflare:workers を読み込むとunit testできないため)。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { metaFromRow, normalizeMeta } from "@/app/lib/openchat-meta";
import { normalizeTextEdit } from "@/app/lib/openchat-input";
import { canonicalUrl } from "@/app/lib/text";
import { fetchPageThumbnail } from "@/app/lib/thumbnail-fetch";
import {
  buildProgramsFilter, PROGRAMS_ORDER_BY, toProgram, ROOM, resolveThumbnails, thumbnailSourceUrl,
  type CachedThumbnail, type Program, type ProgramsQuery,
} from "@/app/lib/openchat-query";

/** 一覧のリンクのうち、Watch List(items/item_links)にもあるもの。キーは一覧に出るURLそのまま、値はWatch Listでの保存URL・
 *  その項目のタイトル(「登録済」バッジの遷移先の検索語に使う。フルURLだと検索欄の48バイト制限で先頭から切り詰められ、
 *  同じシリーズの他の項目にもヒットしてしまうため。app/lib/text.ts の watchListSearchTerm 参照)と該当の項目数。 */
export type WatchedLinks = Record<string, { url: string; title: string; count: number }>;
export type ProgramsPage = { programs: Program[]; total: number; page: number; pageSize: number; watched: WatchedLinks };

/** 一覧: 既定(kind=all)は全スレッド。kind でちきりんの関わり方に絞り込める(buildProgramsFilter参照)。
 *  ほかの人のコメントは読み込まない(SQLの時点で is_target = 1 に絞る)。 */
export async function listPrograms(query: ProgramsQuery = {}): Promise<ProgramsPage> {
  await ensureSchema({ seed: false });
  const { where, values, limit, offset, page } = buildProgramsFilter(query);
  const [countRow, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS c FROM openchat_notes n ${where}`).bind(...values).first<{ c: number }>(),
    env.DB.prepare(
      `SELECT n.id, n.author_name, n.author_is_target, n.program_title, n.link_title, n.link_url, n.body_text,
              n.posted_at, n.posted_at_precision, n.comment_count, n.last_checked_at, n.needs_recheck, n.body_complete, n.first_seen_at
         FROM openchat_notes n ${where} ${PROGRAMS_ORDER_BY} LIMIT ? OFFSET ?`,
    ).bind(...values, limit, offset).all<Record<string, unknown>>(),
  ]);
  const notes = rows.results ?? [];
  const total = Number(countRow?.c ?? 0);
  if (!notes.length) return { programs: [], total, page, pageSize: limit, watched: {} };
  // サムネイルは飾り: 失敗しても一覧は出す。
  const commented = await withComments(notes);
  const programs = await withThumbnails(commented).catch(() => commented);
  return { programs, total, page, pageSize: limit, watched: await watchedLinks(programs) };
}

/** 一覧のサムネイル: 保存済みのものを読むだけ(取得は放送情報の保存時。saveProgramMeta 参照)。判定は resolveThumbnails()。 */
async function withThumbnails(programs: Program[]): Promise<Program[]> {
  const ids = programs.map((p) => p.noteId);
  const rows = (await env.DB.prepare(
    `SELECT note_id, source_url, thumbnail_url FROM openchat_note_thumbnails WHERE note_id IN (${ids.map(() => "?").join(",")})`,
  ).bind(...ids).all<CachedThumbnail & { note_id: string }>()).results ?? [];
  const thumbnails = resolveThumbnails(programs, new Map(rows.map((r) => [String(r.note_id), r])));
  return programs.map((p) => ({ ...p, thumbnailUrl: thumbnails.get(p.noteId) ?? "" }));
}

/** サムネイルを探して保存する。Watch List と同じく、リンクを保存したときに取得する(YouTube はリンクから決まるので取得しない)。
 *  探したリンクが前回と同じで画像もあれば何もしない。失敗しても保存自体は成功させる(画像は飾り)。 */
export async function refreshThumbnail(noteId: string, program: Pick<Program, "meta" | "linkUrl">): Promise<void> {
  try {
    const url = thumbnailSourceUrl(program);
    if (!url) return;
    const previous = await env.DB.prepare("SELECT source_url, thumbnail_url FROM openchat_note_thumbnails WHERE note_id = ?").bind(noteId).first<CachedThumbnail>();
    if (previous && String(previous.source_url) === url && previous.thumbnail_url) return;
    const found = await fetchPageThumbnail(url);
    await env.DB.prepare(
      `INSERT INTO openchat_note_thumbnails (note_id, source_url, thumbnail_url, checked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(note_id) DO UPDATE SET source_url = excluded.source_url, thumbnail_url = excluded.thumbnail_url, checked_at = excluded.checked_at`,
    ).bind(noteId, url, found, new Date().toISOString()).run();
  } catch { /* 画像は飾り。取れなくても保存は成功させる。 */ }
}

/** 1回の同期で新しく取りに行くスレッドの数の上限(1件ごとに外部へのサブリクエストが最大3回かかる)。残りは次の同期で試す。 */
const SYNC_THUMBNAIL_LOOKUPS = 8;

/** 同期で届いたスレッドのうち、サムネイルをまだ一度も試していないものだけ、1回取りに行く。
 *  見つからなかったときも「試した」と記録する(refreshThumbnail が空の行を残す)ので、同じリンクで繰り返し取りには行かない。
 *  OCRの誤りを手で直すと放送情報の保存で取り直す。失敗しても同期は成功させる。 */
export async function fetchThumbnailsForSynced(noteIds: string[]): Promise<void> {
  try {
    if (!noteIds.length) return;
    const rows = (await env.DB.prepare(
      `SELECT n.id, n.link_url, m.links_json FROM openchat_notes n
         LEFT JOIN openchat_note_meta m ON m.note_id = n.id
         LEFT JOIN openchat_note_thumbnails t ON t.note_id = n.id
        WHERE n.id IN (${noteIds.map(() => "?").join(",")}) AND n.deleted_at IS NULL AND t.note_id IS NULL`,
    ).bind(...noteIds).all<Record<string, unknown>>()).results ?? [];
    const untried = rows.map((r) => ({ id: String(r.id), meta: metaFromRow(r), linkUrl: String(r.link_url ?? "") })).filter((p) => thumbnailSourceUrl(p));
    await Promise.all(untried.slice(0, SYNC_THUMBNAIL_LOOKUPS).map((p) => refreshThumbnail(p.id, p)));
  } catch { /* 画像は飾り */ }
}

/** 一覧に出るリンク(編集したリンク + ノートのリンクカード)が Watch List にも登録されているかを、正規化したURLで照合する。 */
async function watchedLinks(programs: Program[]): Promise<WatchedLinks> {
  const byCanonical = new Map<string, string[]>();
  for (const p of programs) {
    for (const url of [...p.meta.links.map((l) => l.url), p.linkUrl]) {
      const canonical = url ? canonicalUrl(url) : "";
      if (canonical) byCanonical.set(canonical, [...new Set([...(byCanonical.get(canonical) ?? []), url])]);
    }
  }
  const canonicals = [...byCanonical.keys()].slice(0, 90);
  if (!canonicals.length) return {};
  const rows = (await env.DB.prepare(
    `SELECT l.canonical_url, MIN(l.url) AS url, MIN(i.title) AS title, COUNT(DISTINCT l.item_id) AS c
       FROM item_links l JOIN items i ON i.id = l.item_id
      WHERE i.deleted_at IS NULL AND l.canonical_url IN (${canonicals.map(() => "?").join(",")})
      GROUP BY l.canonical_url`,
  ).bind(...canonicals).all<Record<string, unknown>>()).results ?? [];
  const watched: WatchedLinks = {};
  for (const row of rows) {
    for (const shown of byCanonical.get(String(row.canonical_url)) ?? []) watched[shown] = { url: String(row.url), title: String(row.title ?? ""), count: Number(row.c) };
  }
  return watched;
}

/** ノート行に、ちきりんのコメント(古い順)をつけて、画面・APIの形にする。ほかの人のコメントは読み込まない。 */
async function withComments(page: Array<Record<string, unknown>>): Promise<Program[]> {
  const ids = page.map((n) => String(n.id));
  const placeholders = ids.map(() => "?").join(",");
  const comments = (await env.DB.prepare(
    `SELECT id, note_id, body_text, posted_at, posted_at_precision, is_target, first_seen_at
       FROM openchat_comments WHERE is_target = 1 AND deleted_at IS NULL AND note_id IN (${placeholders})
      ORDER BY posted_at ASC, ordinal ASC`,
  ).bind(...ids).all<Record<string, unknown>>()).results ?? [];
  const byNote = new Map<string, Array<Record<string, unknown>>>();
  for (const c of comments) {
    const key = String(c.note_id);
    byNote.set(key, [...(byNote.get(key) ?? []), c]);
  }
  const metas = (await env.DB.prepare(
    `SELECT note_id, broadcaster, program_name, episode_title, links_json FROM openchat_note_meta WHERE note_id IN (${placeholders})`,
  ).bind(...ids).all<Record<string, unknown>>()).results ?? [];
  const metaByNote = new Map(metas.map((m) => [String(m.note_id), m]));
  return page.map((n) => toProgram({ ...n, meta_row: metaByNote.get(String(n.id)) }, byNote.get(String(n.id)) ?? []));
}

/** 人が編集する情報(放送局・番組名・その日の放送タイトル・リンク)を保存する。 */
export async function saveProgramMeta(id: string, input: unknown): Promise<Program | null | { error: string }> {
  const parsed = normalizeMeta(input);
  if ("error" in parsed) return { error: parsed.error };
  const program = await getProgram(id);
  if (!program) return null;
  const { meta } = parsed;
  await env.DB.prepare(
    `INSERT INTO openchat_note_meta (note_id, broadcaster, program_name, episode_title, links_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(note_id) DO UPDATE SET broadcaster = excluded.broadcaster, program_name = excluded.program_name, episode_title = excluded.episode_title,
       links_json = excluded.links_json, updated_at = excluded.updated_at`,
  ).bind(id, meta.broadcaster, meta.programName, meta.episodeTitle, JSON.stringify(meta.links), new Date().toISOString().replace(/\.\d+Z$/, "Z")).run();
  await refreshThumbnail(id, { meta, linkUrl: program.linkUrl });
  return { ...program, meta };
}

/** OCRの読み間違いを手で直した本文(スレッドの本文・ちきりんのコメント)を保存する。
 *  body_edited = 1 にして、collector の再同期で OCR の本文に戻されないようにする(sync/route.ts)。
 *  ちきりんのコメント以外(ほかの人のコメント・別のスレッドのコメント)は直せない。 */
export async function saveProgramText(id: string, input: unknown): Promise<Program | null | { error: string }> {
  const parsed = normalizeTextEdit(input);
  if (parsed.error !== undefined) return { error: parsed.error };
  const program = await getProgram(id);
  if (!program) return null;
  const edit = parsed.value;
  const known = new Set(program.targetComments.map((c) => c.id));
  if (edit.comments.some((c) => !known.has(c.id))) return { error: "このスレッドにないコメントは直せません。" };
  const statements = [];
  if (edit.noteBody !== undefined) {
    statements.push(env.DB.prepare("UPDATE openchat_notes SET body_text = ?, body_edited = 1 WHERE id = ?").bind(edit.noteBody, id));
  }
  for (const c of edit.comments) {
    statements.push(env.DB.prepare("UPDATE openchat_comments SET body_text = ?, body_edited = 1 WHERE id = ? AND note_id = ? AND is_target = 1").bind(c.bodyText, c.id, id));
  }
  await env.DB.batch(statements);
  return (await getProgram(id))!;
}

/** 詳細: 1ノート(1番組)。削除済み・存在しないノートは null(ちきりんが関わらないスレッドも開ける)。 */
export async function getProgram(id: string): Promise<Program | null> {
  await ensureSchema({ seed: false });
  const note = (await env.DB.prepare(
    `SELECT n.id, n.author_name, n.author_is_target, n.program_title, n.link_title, n.link_url, n.body_text,
            n.posted_at, n.posted_at_precision, n.comment_count, n.last_checked_at, n.needs_recheck, n.body_complete, n.first_seen_at
       FROM openchat_notes n
      WHERE n.id = ? AND n.room = ? AND n.deleted_at IS NULL`,
  ).bind(id, ROOM).first<Record<string, unknown>>());
  if (!note) return null;
  return (await withComments([note]))[0];
}

export type LatestRun = {
  status: string; startedAt: string; completedAt: string | null; notesScanned: number; notesOpened: number;
  commentsNew: number; targetCommentsNew: number; warningCount: number; warnings: string[];
  /** 最後の取得で、ちきりんの投稿(スレッド・コメント)が初めて見つかった番組の数。一覧の「新着」の行。 */
  newPrograms: number;
};

export async function latestOpenchatRun(): Promise<LatestRun | null> {
  await ensureSchema({ seed: false });
  const row = (await env.DB.prepare(
    "SELECT status, started_at, completed_at, notes_scanned, notes_opened, comments_new, target_comments_new, warnings_json FROM openchat_sync_runs ORDER BY started_at DESC LIMIT 1",
  ).all<Record<string, unknown>>()).results?.[0];
  if (!row) return null;
  let warnings: string[] = [];
  try { warnings = (JSON.parse(String(row.warnings_json ?? "[]")) as unknown[]).map((w) => String(w).slice(0, 300)).slice(0, 50); } catch { /* 壊れていても件数0として扱う */ }
  const warningCount = warnings.length;
  // 最後の取得(started_at)以降に初めて見つかった番組: 新しいスレッド、またはちきりんの新しい投稿(スレッド・コメント)。
  // first_seen_at は「+07:00」付きのことがあるので datetime() でUTCにそろえる。
  const fresh = (await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM openchat_notes n
      WHERE n.room = ? AND n.deleted_at IS NULL
        AND (datetime(n.first_seen_at) >= datetime(?)
             OR EXISTS (SELECT 1 FROM openchat_comments c WHERE c.note_id = n.id AND c.is_target = 1 AND c.deleted_at IS NULL AND datetime(c.first_seen_at) >= datetime(?)))`,
  ).bind(ROOM, String(row.started_at), String(row.started_at)).first<{ c: number }>());
  return {
    status: String(row.status), startedAt: String(row.started_at), completedAt: row.completed_at ? String(row.completed_at) : null,
    notesScanned: Number(row.notes_scanned ?? 0), notesOpened: Number(row.notes_opened ?? 0),
    commentsNew: Number(row.comments_new ?? 0), targetCommentsNew: Number(row.target_comments_new ?? 0), warningCount, warnings, newPrograms: Number(fresh?.c ?? 0),
  };
}

const LEDGER_NOTE_LIMIT = 3000;
const LEDGER_COMMENT_LIMIT = 40000;

/** collectorのローカル台帳を失ったときの復元用。読み取り行数が多いので、通常の画面・同期からは呼ばない。
 *  本文は照合に必要な先頭200字だけ返す。 */
export async function exportLedger() {
  await ensureSchema({ seed: false });
  const notes = (await env.DB.prepare(
    `SELECT id, author_name, author_is_target, program_title, link_title, link_url, substr(body_text, 1, 200) AS body_head,
            body_complete, posted_at, posted_at_precision, posted_at_raw, comment_count, needs_recheck, first_seen_at,
            last_checked_at, deleted_at
       FROM openchat_notes WHERE room = ? ORDER BY posted_at DESC LIMIT ?`,
  ).bind(ROOM, LEDGER_NOTE_LIMIT).all<Record<string, unknown>>()).results ?? [];
  const comments = (await env.DB.prepare(
    `SELECT c.id, c.note_id, c.ordinal, c.author_name, c.is_target, substr(c.body_text, 1, 200) AS body_head, c.posted_at,
            c.posted_at_precision, c.deleted_at
       FROM openchat_comments c JOIN openchat_notes n ON n.id = c.note_id WHERE n.room = ? ORDER BY c.note_id, c.ordinal LIMIT ?`,
  ).bind(ROOM, LEDGER_COMMENT_LIMIT).all<Record<string, unknown>>()).results ?? [];
  return {
    truncated: notes.length >= LEDGER_NOTE_LIMIT || comments.length >= LEDGER_COMMENT_LIMIT,
    notes: notes.map((n) => ({
      id: n.id, authorName: n.author_name, authorIsTarget: Number(n.author_is_target) === 1, programTitle: n.program_title,
      linkTitle: n.link_title, linkUrl: n.link_url, bodyHead: n.body_head, bodyComplete: Number(n.body_complete) === 1,
      postedAt: n.posted_at, postedAtPrecision: n.posted_at_precision, postedAtRaw: n.posted_at_raw,
      commentCount: n.comment_count, needsRecheck: Number(n.needs_recheck) === 1, firstSeenAt: n.first_seen_at,
      lastCheckedAt: n.last_checked_at, deletedAt: n.deleted_at,
    })),
    comments: comments.map((c) => ({
      id: c.id, noteId: c.note_id, ordinal: c.ordinal, authorName: c.author_name, isTarget: Number(c.is_target) === 1,
      bodyHead: c.body_head, postedAt: c.posted_at, postedAtPrecision: c.posted_at_precision, deletedAt: c.deleted_at,
    })),
  };
}
