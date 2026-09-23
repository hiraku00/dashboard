/** TextTube 動画一覧の読み取りロジック（D1呼び出しを伴うオーケストレー
 *  ション層）。app/api/text-tube/videos の GET と、/text-tube・
 *  /text-tube/studio の Server Component の両方がこれを呼ぶ -- ロジックを
 *  複製すると「ページとAPIで一覧の中身がずれる」種類のバグを作るので、
 *  正はここに一本化する。
 *
 *  純粋な決定ロジック（WHERE句の組み立て）は app/lib/text-tube-query.ts に
 *  分離してある。理由は app/lib/watch-list-query.ts と同じ。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { buildVideosFilter, type VideosQuery } from "@/app/lib/text-tube-query";

export type Video = {
  id: unknown;
  title: unknown;
  channel_name: unknown;
  thumbnail_url: unknown;
  original_url: unknown;
  summary: unknown;
  published_at: unknown;
  view_count: unknown;
  channel_thumbnail_url: unknown;
  duration: unknown;
  detailed_script_object_key: unknown;
  created_at: unknown;
  updated_at: unknown;
};

/** app/api/text-tube/videos の GET と、/text-tube・/text-tube/studio の
 *  初期表示が両方呼ぶ。 */
export async function listVideos(query: VideosQuery = {}): Promise<{ videos: Video[] }> {
  await ensureSchema({ seed: false });
  const { where, values } = buildVideosFilter(query);
  const rows = (await env.DB.prepare(`SELECT id,title,channel_name,thumbnail_url,original_url,summary,published_at,view_count,channel_thumbnail_url,duration,detailed_script_object_key,created_at,updated_at FROM text_tube_videos ${where} ORDER BY created_at DESC LIMIT 100`).bind(...values).all<Record<string, unknown>>()).results ?? [];
  return { videos: rows as unknown as Video[] };
}

/** app/api/text-tube/videos/[id] の GET と、Studioの編集フォーム展開
 *  (studio-app.tsx の edit()) が必要とする全カラムをそのまま返す --
 *  listVideos() の絞ったカラム一覧とは別物なので使い回さない。 */
export async function getVideo(id: string): Promise<Video | null> {
  await ensureSchema({ seed: false });
  const result = await env.DB.prepare("SELECT * FROM text_tube_videos WHERE id=? AND deleted_at IS NULL").bind(id).all<Record<string, unknown>>();
  return (result.results?.[0] as unknown as Video | undefined) ?? null;
}

/** app/text-tube/watch/[id]/page.tsx の初期表示が呼ぶ。動画が
 *  見つからない場合は null を返す（D1自体の障害と区別するため、例外を
 *  投げない -- 呼び出し元はこれを「404」として扱い、D1障害時のような
 *  クライアント側フォールバックは行わない）。
 *
 *  視聴ページは詳細スクリプト本文（R2）を表示しない -- 以前は
 *  getVideoDocument() でここに埋め込んでいたが、表示しないものを毎回
 *  R2から読むだけ無駄なので、動画1本ぶんのメタデータだけを返す。本文
 *  そのものはStudioの編集フォームが GET .../document で必要なときだけ
 *  個別に読む（app/api/text-tube/videos/[id]/document/route.ts）。 */
export async function getVideoDetail(id: string): Promise<Video | null> {
  return getVideo(id);
}
