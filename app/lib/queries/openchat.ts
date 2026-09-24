/** ちきりんオプチャの読み取り(D1呼び出しを伴う層)。/chikirin ページの Server Component と
 *  app/api/openchat/* の両方がこれを呼ぶ。純粋な決定ロジック(WHERE句・カーソル・整形)は
 *  app/lib/openchat-query.ts にある(cloudflare:workers を読み込むとunit testできないため)。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import {
  buildProgramsFilter, encodeCursor, PROGRAMS_ORDER_BY, toProgram, ROOM,
  type Program, type ProgramsQuery,
} from "@/app/lib/openchat-query";

export type ProgramsPage = { programs: Program[]; nextCursor: string | null };

/** 一覧: ちきりんさんが立てたノート、または、ちきりんさんのコメントがあるノートだけ。
 *  ほかの人のコメントは読み込まない(SQLの時点で is_target = 1 に絞る)。 */
export async function listPrograms(query: ProgramsQuery = {}): Promise<ProgramsPage> {
  await ensureSchema({ seed: false });
  const { where, values, limit } = buildProgramsFilter(query);
  const notes = (await env.DB.prepare(
    `SELECT n.id, n.author_name, n.author_is_target, n.program_title, n.link_title, n.link_url, n.body_text,
            n.posted_at, n.posted_at_precision, n.comment_count, n.last_checked_at
       FROM openchat_notes n ${where} ${PROGRAMS_ORDER_BY} LIMIT ?`,
  ).bind(...values, limit + 1).all<Record<string, unknown>>()).results ?? [];
  const page = notes.slice(0, limit);
  const nextCursor = notes.length > limit ? encodeCursor({ postedAt: String(page[page.length - 1].posted_at), id: String(page[page.length - 1].id) }) : null;
  if (!page.length) return { programs: [], nextCursor: null };

  const ids = page.map((n) => String(n.id));
  const placeholders = ids.map(() => "?").join(",");
  const comments = (await env.DB.prepare(
    `SELECT id, note_id, body_text, posted_at, posted_at_precision, is_target
       FROM openchat_comments WHERE is_target = 1 AND deleted_at IS NULL AND note_id IN (${placeholders})
      ORDER BY posted_at ASC, ordinal ASC`,
  ).bind(...ids).all<Record<string, unknown>>()).results ?? [];
  const byNote = new Map<string, Array<Record<string, unknown>>>();
  for (const c of comments) {
    const key = String(c.note_id);
    byNote.set(key, [...(byNote.get(key) ?? []), c]);
  }
  return { programs: page.map((n) => toProgram(n, byNote.get(String(n.id)) ?? [])), nextCursor };
}

export type LatestRun = {
  status: string; startedAt: string; completedAt: string | null; notesScanned: number; notesOpened: number;
  commentsNew: number; targetCommentsNew: number; warningCount: number;
};

export async function latestOpenchatRun(): Promise<LatestRun | null> {
  await ensureSchema({ seed: false });
  const row = (await env.DB.prepare(
    "SELECT status, started_at, completed_at, notes_scanned, notes_opened, comments_new, target_comments_new, warnings_json FROM openchat_sync_runs ORDER BY started_at DESC LIMIT 1",
  ).all<Record<string, unknown>>()).results?.[0];
  if (!row) return null;
  let warningCount = 0;
  try { warningCount = (JSON.parse(String(row.warnings_json ?? "[]")) as unknown[]).length; } catch { /* 壊れていても件数0として扱う */ }
  return {
    status: String(row.status), startedAt: String(row.started_at), completedAt: row.completed_at ? String(row.completed_at) : null,
    notesScanned: Number(row.notes_scanned ?? 0), notesOpened: Number(row.notes_opened ?? 0),
    commentsNew: Number(row.comments_new ?? 0), targetCommentsNew: Number(row.target_comments_new ?? 0), warningCount,
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
