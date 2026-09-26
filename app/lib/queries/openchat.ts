/** ちきりんオプチャの読み取り(D1呼び出しを伴う層)。/chikirin ページの Server Component と
 *  app/api/openchat/* の両方がこれを呼ぶ。純粋な決定ロジック(WHERE句・カーソル・整形)は
 *  app/lib/openchat-query.ts にある(cloudflare:workers を読み込むとunit testできないため)。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { normalizeMeta } from "@/app/lib/openchat-meta";
import { canonicalUrl } from "@/app/lib/text";
import {
  buildProgramsFilter, PROGRAMS_ORDER_BY, toProgram, ROOM,
  type Program, type ProgramsQuery,
} from "@/app/lib/openchat-query";

/** 一覧のリンクのうち、Watch List(items/item_links)にもあるもの。キーは一覧に出るURLそのまま、値はWatch Listでの保存URL(検索に使う)と該当の項目数。 */
export type WatchedLinks = Record<string, { url: string; count: number }>;
export type ProgramsPage = { programs: Program[]; total: number; page: number; pageSize: number; watched: WatchedLinks };

/** 一覧: ちきりんが立てたノート、または、ちきりんのコメントがあるノートだけ。
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
  const programs = await withComments(notes);
  return { programs, total, page, pageSize: limit, watched: await watchedLinks(programs) };
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
    `SELECT l.canonical_url, MIN(l.url) AS url, COUNT(DISTINCT l.item_id) AS c
       FROM item_links l JOIN items i ON i.id = l.item_id
      WHERE i.deleted_at IS NULL AND l.canonical_url IN (${canonicals.map(() => "?").join(",")})
      GROUP BY l.canonical_url`,
  ).bind(...canonicals).all<Record<string, unknown>>()).results ?? [];
  const watched: WatchedLinks = {};
  for (const row of rows) {
    for (const shown of byCanonical.get(String(row.canonical_url)) ?? []) watched[shown] = { url: String(row.url), count: Number(row.c) };
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
  return { ...program, meta };
}

/** 詳細: 1ノート(1番組)。一覧に載る条件(ちきりんが立てた、またはコメントがある)を満たさないノートは null。 */
export async function getProgram(id: string): Promise<Program | null> {
  await ensureSchema({ seed: false });
  const note = (await env.DB.prepare(
    `SELECT n.id, n.author_name, n.author_is_target, n.program_title, n.link_title, n.link_url, n.body_text,
            n.posted_at, n.posted_at_precision, n.comment_count, n.last_checked_at, n.needs_recheck, n.body_complete, n.first_seen_at
       FROM openchat_notes n
      WHERE n.id = ? AND n.room = ? AND n.deleted_at IS NULL AND (n.author_is_target = 1 OR n.target_comment_count > 0)`,
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
  // 最後の取得(started_at)以降に初めて見つかった投稿がある番組。first_seen_at は「+07:00」付きのことがあるので datetime() でUTCにそろえる。
  const fresh = (await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM openchat_notes n
      WHERE n.room = ? AND n.deleted_at IS NULL AND (n.author_is_target = 1 OR n.target_comment_count > 0)
        AND ((n.author_is_target = 1 AND datetime(n.first_seen_at) >= datetime(?))
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
