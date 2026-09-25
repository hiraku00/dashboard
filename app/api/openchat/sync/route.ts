import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { clean } from "@/app/lib/text";
import { route } from "@/app/lib/route";
import { normalizeComplete, normalizeNotesBatch, type NoteInput } from "@/app/lib/openchat-input";

// ちきりんオプチャの同期。collector/line_openchat/uploader.py が start → notes(何回か) → complete の
// 順に呼ぶ(Manage Assetの /api/manage-asset/sync と同じ3段階)。
//
// Cloudflare AccessがEdgeでService Tokenを検証する。Worker側ではヘッダーを再確認しないので、
// このパス(/api/openchat/*)がAccessのApplicationに含まれている必要がある(docs/deployment-and-access.md)。
//
// 何度送られても結果が変わらないように書く: ノート・コメントは collector が発行したid で
// INSERT ... ON CONFLICT DO UPDATE する。通信のタイムアウト後の再送や、同じノートのコメントを
// 複数リクエストに分けて送ることがある。

type Body = { action?: unknown; clientRunId?: unknown; clientVersion?: unknown; notes?: unknown; status?: unknown; stats?: unknown; warnings?: unknown };

const BATCH = 50;   // 1回のD1 batchに入れる文の数(manage-asset/sync と同じ)

function noteStatement(n: NoteInput) {
  // target_comment_count はコメントを書き込んだあとで数え直すので、ここでは触らない。
  // first_seen_at も、最初に見たときの値を残す。
  return env.DB.prepare(`INSERT INTO openchat_notes
    (id,room,author_name,author_is_target,program_title,link_title,link_url,body_text,body_complete,posted_at,posted_at_precision,posted_at_raw,comment_count,needs_recheck,first_seen_at,last_checked_at,deleted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET room=excluded.room,author_name=excluded.author_name,author_is_target=excluded.author_is_target,
      program_title=excluded.program_title,link_title=excluded.link_title,link_url=excluded.link_url,body_text=excluded.body_text,
      body_complete=excluded.body_complete,posted_at=excluded.posted_at,posted_at_precision=excluded.posted_at_precision,
      posted_at_raw=excluded.posted_at_raw,comment_count=excluded.comment_count,needs_recheck=excluded.needs_recheck,
      last_checked_at=excluded.last_checked_at,deleted_at=excluded.deleted_at`)
    .bind(n.id, n.room, n.authorName, n.authorIsTarget ? 1 : 0, n.programTitle, n.linkTitle, n.linkUrl, n.bodyText, n.bodyComplete ? 1 : 0,
      n.postedAt, n.postedAtPrecision, n.postedAtRaw, n.commentCount, n.needsRecheck ? 1 : 0, n.firstSeenAt, n.lastCheckedAt, n.deletedAt);
}

function commentStatements(n: NoteInput) {
  return n.comments.map((c) => env.DB.prepare(`INSERT INTO openchat_comments
    (id,note_id,ordinal,author_name,is_target,body_text,posted_at,posted_at_precision,posted_at_raw,ocr_min_confidence,first_seen_at,last_seen_at,deleted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET note_id=excluded.note_id,ordinal=excluded.ordinal,author_name=excluded.author_name,is_target=excluded.is_target,
      body_text=excluded.body_text,posted_at=excluded.posted_at,posted_at_precision=excluded.posted_at_precision,posted_at_raw=excluded.posted_at_raw,
      ocr_min_confidence=excluded.ocr_min_confidence,last_seen_at=excluded.last_seen_at,deleted_at=excluded.deleted_at`)
    .bind(c.id, n.id, c.ordinal, c.authorName, c.isTarget ? 1 : 0, c.bodyText, c.postedAt, c.postedAtPrecision, c.postedAtRaw, c.ocrMinConfidence,
      c.firstSeenAt, c.lastSeenAt, c.deletedAt));
}

export const POST = route(async (request: Request) => {
  await ensureSchema({ seed: false });
  const body = await request.json().catch(() => null) as Body | null;
  if (!body || typeof body.action !== "string" || typeof body.clientRunId !== "string") return Response.json({ error: "actionとclientRunIdが必要です。" }, { status: 400 });
  const clientRunId = clean(body.clientRunId, 200);
  if (!clientRunId) return Response.json({ error: "clientRunIdが必要です。" }, { status: 400 });
  const now = new Date().toISOString();

  if (body.action === "start") {
    // 再送(タイムアウト後の再試行)で同じclientRunIdが来たら、同じrunを返す。
    const existing = (await env.DB.prepare("SELECT id FROM openchat_sync_runs WHERE client_run_id=?").bind(clientRunId).all<{ id: string }>()).results?.[0];
    if (existing) return Response.json({ runId: existing.id });
    const runId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO openchat_sync_runs (id,client_run_id,client_version,started_at,status) VALUES (?,?,?,?,'started')").bind(runId, clientRunId, clean(body.clientVersion, 100), now).run();
    return Response.json({ runId });
  }

  const run = (await env.DB.prepare("SELECT id FROM openchat_sync_runs WHERE client_run_id=?").bind(clientRunId).all<{ id: string }>()).results?.[0];
  if (!run) return Response.json({ error: "同期runが見つかりません。" }, { status: 404 });

  if (body.action === "complete") {
    const input = normalizeComplete(body as Record<string, unknown>);
    if (input.error !== undefined) return Response.json({ error: input.error }, { status: 400 });
    const v = input.value;
    await env.DB.prepare("UPDATE openchat_sync_runs SET completed_at=?,status=?,notes_scanned=?,notes_opened=?,comments_new=?,target_comments_new=?,warnings_json=? WHERE id=?")
      .bind(now, v.status, v.notesScanned, v.notesOpened, v.commentsNew, v.targetCommentsNew, JSON.stringify(v.warnings), run.id).run();
    return Response.json({ ok: true, runId: run.id });
  }

  if (body.action === "notes") {
    const batch = normalizeNotesBatch(body.notes);
    if (batch.error !== undefined) return Response.json({ error: batch.error }, { status: 400 });
    const { notes, errors } = batch.value;
    const statements = notes.flatMap((n) => [noteStatement(n), ...commentStatements(n)]);
    // ノート行とそのコメント行を書いたあとで、ちきりんのコメント数を数え直す(コメントが複数リクエストに
    // 分かれて届いても、最後に正しい数になる)。
    const touched = notes.map((n) => n.id);
    if (touched.length) {
      statements.push(env.DB.prepare(`UPDATE openchat_notes SET target_comment_count=(SELECT COUNT(*) FROM openchat_comments c WHERE c.note_id=openchat_notes.id AND c.is_target=1 AND c.deleted_at IS NULL)
        WHERE id IN (${touched.map(() => "?").join(",")})`).bind(...touched));
    }
    const results: Array<{ id: string; error?: string }> = errors.map((e) => ({ id: e.id, error: e.error }));
    try {
      for (let start = 0; start < statements.length; start += BATCH) await env.DB.batch(statements.slice(start, start + BATCH));
      for (const n of notes) results.push({ id: n.id });
    } catch (error) {
      console.error(error);
      for (const n of notes) results.push({ id: n.id, error: "保存に失敗しました。" });
    }
    return Response.json({ ok: results.every((r) => !r.error), results });
  }

  return Response.json({ error: "actionが不正です。" }, { status: 400 });
});
