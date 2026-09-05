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
