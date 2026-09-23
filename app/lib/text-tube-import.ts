/** Watch Listに保存されたYouTubeリンクをTextTubeへ自動で取り込む処理。
 *
 *  app/api/items/route.ts (POST) と app/api/items/[id]/route.ts (PATCH) が
 *  保存直後に「今回追加された」YouTubeリンクのIDを返し(textTubeCandidates)、
 *  クライアント(app/watch-list-app.tsx)がその1件ずつに対して
 *  POST /api/text-tube/imports/run を呼ぶ -- これが runTextTubeImport() を
 *  呼ぶ。編集画面の「TextTubeへ反映」ボタン(手動での再登録)も同じ
 *  runTextTubeImport() を同じエンドポイント経由で呼ぶので、自動と手動で
 *  挙動が分かれることはない。
 *
 *  cronでの自動再実行は行わない -- 登録中に画面を閉じた場合は
 *  text_tube_imports に running のまま残り、pendingTextTubeImports() が
 *  10分以上進んでいない running を「stuck」として拾い上げ、Watch List
 *  上部の帯からの手動の再試行に委ねる。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import {
  fetchYouTubeVideoInfo,
  fetchYouTubeTranscript,
} from "@/app/lib/youtube-video-fetch";
import { saveVideoDocument } from "@/app/lib/text-tube-document";

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const STALE_RUNNING_MS = 10 * 60 * 1000;

export type TextTubeImportResult =
  | { status: "reflected"; videoId: string }
  | { status: "running" }
  | { status: "done"; videoId: string }
  | { status: "failed"; error: string };

async function markFailed(
  importId: string,
  error: string,
): Promise<TextTubeImportResult> {
  await env.DB.prepare(
    "UPDATE text_tube_imports SET status='failed', last_error=?, updated_at=? WHERE id=?",
  )
    .bind(error.slice(0, 1000), new Date().toISOString(), importId)
    .run();
  return { status: "failed", error };
}

/** app/api/text-tube/imports/run/route.ts の唯一の呼び出し元。動画1本分の
 *  取り込みを実行する。`itemId` は記録用(Watch List上部の帯にどの項目の
 *  ものか表示するため)で、無くても取り込み自体は行える(手動ボタンが
 *  項目からリンクを特定できているとき以外は省略される想定はない -- 現状
 *  すべての呼び出し元がitemIdを渡す)。 */
export async function runTextTubeImport(
  youtubeVideoId: string,
  itemId: string | null,
): Promise<TextTubeImportResult> {
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(youtubeVideoId))
    return { status: "failed", error: "YouTube動画IDが不正です。" };
  await ensureSchema({ seed: false });

  // 既にTextTubeにある(削除されていない)動画なら、何もしない。
  const existingVideo = (
    await env.DB.prepare(
      "SELECT id FROM text_tube_videos WHERE youtube_video_id=? AND deleted_at IS NULL",
    )
      .bind(youtubeVideoId)
      .all<{ id: string }>()
  ).results?.[0];
  if (existingVideo) return { status: "reflected", videoId: existingVideo.id };

  // 別の呼び出しが今まさに取り込み中なら(10分以内に更新されたrunning)、
  // 二重に取り込まない。10分より古いrunningは「止まってしまったもの」と
  // みなし、ここでは無視して新しく始める(古いrunning行はstatus='running'
  // のまま残るが、pendingTextTubeImports()はyoutube_video_idごとに
  // updated_atが最新の1行だけを見るので、この新しい試行の結果に置き換わる)。
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const activeRun = (
    await env.DB.prepare(
      "SELECT id FROM text_tube_imports WHERE youtube_video_id=? AND status='running' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1",
    )
      .bind(youtubeVideoId, staleCutoff)
      .all<{ id: string }>()
  ).results?.[0];
  if (activeRun) return { status: "running" };

  const importId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO text_tube_imports (id,youtube_video_id,item_id,status,attempts,last_error,created_at,updated_at) VALUES (?,?,?,'running',1,'',?,?)",
  )
    .bind(importId, youtubeVideoId, itemId, startedAt, startedAt)
    .run();

  const key = (env as { YOUTUBE_DATA_API_KEY?: string }).YOUTUBE_DATA_API_KEY;
  const supadataKey = (env as { SUPADATA_API_KEY?: string }).SUPADATA_API_KEY;
  if (!key) return markFailed(importId, "YouTube連携が設定されていません。");

  const info = await fetchYouTubeVideoInfo(youtubeVideoId, key);
  if ("error" in info) return markFailed(importId, info.error);

  // 字幕が取れなくても(未対応言語、字幕なしの動画など)動画自体は作る --
  // 要約と同じく、字幕もあとから手動で補える(Studioの編集フォーム)。
  // ここで失敗にしてしまうと、字幕が無いだけの動画がいつまでも「未反映」
  // のままになる。
  const captions = await fetchYouTubeTranscript(
    info.value.originalUrl,
    supadataKey,
    info.value.defaultAudioLanguage,
  ).catch(() => ({ script: "", notice: "" }));

  const videoId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO text_tube_videos (id,title,channel_name,thumbnail_url,original_url,summary,published_at,view_count,channel_thumbnail_url,duration,youtube_video_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      videoId,
      info.value.title,
      info.value.channelName,
      info.value.thumbnailUrl,
      info.value.originalUrl,
      "",
      info.value.publishedAt || null,
      0,
      info.value.channelThumbnailUrl,
      info.value.duration,
      youtubeVideoId,
      now,
      now,
    )
    .run();

  if (captions.script) {
    // ArrayBufferにしてsaveVideoDocument()へ -- POST .../documentが
    // request.arrayBuffer()で受け取るのと同じ形。失敗しても動画自体の
    // 作成は既に済んでいるので、取り込み全体は成功のまま扱う(字幕だけ
    // Studioで後から保存し直せる)。
    await saveVideoDocument(videoId, new TextEncoder().encode(captions.script).buffer).catch(() => {});
  }

  await env.DB.prepare(
    "UPDATE text_tube_imports SET status='done', video_id=?, updated_at=? WHERE id=?",
  )
    .bind(videoId, new Date().toISOString(), importId)
    .run();
  return { status: "done", videoId };
}

export type PendingTextTubeImport = {
  id: string;
  youtubeVideoId: string;
  itemId: string | null;
  itemTitle: string | null;
  status: "failed" | "stuck";
  error: string;
};

/** Watch List上部の帯(app/watch-list-app.tsx)が表示する、対応が必要な
 *  取り込みの一覧。「youtube_video_idごとに最新の1行」を見て、それが
 *  failed、または10分以上進んでいないrunning(stuck)で、かつ
 *  (再試行が成功していれば当然そうなる)今もTextTubeに動画が無いものだけ
 *  を返す。dismissed_atが付いているものは除く。 */
export async function pendingTextTubeImports(): Promise<PendingTextTubeImport[]> {
  await ensureSchema({ seed: false });
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const rows =
    (
      await env.DB.prepare(
        `SELECT ti.id, ti.youtube_video_id, ti.item_id, ti.status, ti.last_error, i.title AS item_title
         FROM text_tube_imports ti
         LEFT JOIN items i ON i.id = ti.item_id
         WHERE ti.dismissed_at IS NULL
           AND ti.updated_at = (SELECT MAX(updated_at) FROM text_tube_imports WHERE youtube_video_id = ti.youtube_video_id)
           AND (ti.status = 'failed' OR (ti.status = 'running' AND ti.updated_at < ?))
           AND NOT EXISTS (SELECT 1 FROM text_tube_videos v WHERE v.youtube_video_id = ti.youtube_video_id AND v.deleted_at IS NULL)
         ORDER BY ti.updated_at DESC LIMIT 20`,
      )
        .bind(staleCutoff)
        .all<Record<string, unknown>>()
    ).results ?? [];
  return rows.map((row) => ({
    id: String(row.id),
    youtubeVideoId: String(row.youtube_video_id),
    itemId: row.item_id ? String(row.item_id) : null,
    itemTitle: row.item_title ? String(row.item_title) : null,
    status: row.status === "running" ? "stuck" : "failed",
    error:
      row.status === "running"
        ? "登録中の処理が終わりませんでした。もう一度お試しください。"
        : String(row.last_error ?? ""),
  }));
}

export async function dismissTextTubeImport(id: string): Promise<void> {
  await ensureSchema({ seed: false });
  await env.DB.prepare(
    "UPDATE text_tube_imports SET dismissed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), id)
    .run();
}
