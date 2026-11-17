/** TextTube 動画一覧の読み取りロジック（D1呼び出しを伴うオーケストレー
 *  ション層）。app/api/text-tube/videos の GET と、/text-tube の
 *  Server Component の両方がこれを呼ぶ -- ロジックを
 *  複製すると「ページとAPIで一覧の中身がずれる」種類のバグを作るので、
 *  正はここに一本化する。
 *
 *  純粋な決定ロジック（WHERE句の組み立て）は app/lib/text-tube-query.ts に
 *  分離してある。理由は app/lib/watch-list-query.ts と同じ。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { buildVideosFilter, videosOffset, VIDEOS_PAGE_SIZE, type VideosQuery } from "@/app/lib/text-tube-query";

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
  /** 読み終えた日時(ISO)。未読は null。 */
  read_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

/** 一覧の1行。要約（summary）は入れない -- 一覧のカードは使わないのに、1本あたり数万文字あり、
 *  入れると一覧の応答が動画の本数ぶんの要約で数MBになる。要約は getVideo() が返す。 */
export type VideoListItem = Omit<Video, "summary">;

/** app/api/text-tube/videos の GET と、/text-tube の
 *  初期表示が両方呼ぶ。新しい順に VIDEOS_PAGE_SIZE 本ずつ返し、まだ続きがあれば hasMore が true
 *  （1本多く読んで確かめるので、件数を数える別のクエリは要らない）。 */
export async function listVideos(query: VideosQuery = {}): Promise<{ videos: VideoListItem[]; hasMore: boolean }> {
  await ensureSchema({ seed: false });
  const { where, values } = buildVideosFilter(query);
  // id を第2キーにするのは、created_at が同じ行があっても offset での続きが飛んだり重なったりしないため。
  const rows = (await env.DB.prepare(`SELECT id,title,channel_name,thumbnail_url,original_url,published_at,view_count,channel_thumbnail_url,duration,detailed_script_object_key,read_at,created_at,updated_at FROM text_tube_videos ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(...values, VIDEOS_PAGE_SIZE + 1, videosOffset(query.offset)).all<Record<string, unknown>>()).results ?? [];
  return { videos: rows.slice(0, VIDEOS_PAGE_SIZE) as unknown as VideoListItem[], hasMore: rows.length > VIDEOS_PAGE_SIZE };
}

/** app/api/text-tube/videos/[id] の GET と、編集フォーム展開
 *  (app/text-tube/video-edit-app.tsx の編集画面) が必要とする全カラムをそのまま返す --
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
 *  そのものは編集フォームが GET .../document で必要なときだけ
 *  個別に読む（app/api/text-tube/videos/[id]/document/route.ts）。 */
export async function getVideoDetail(id: string): Promise<Video | null> {
  return getVideo(id);
}

/** 記事ページの横に出す「同じチャンネルの動画」の1行。 */
export type ChannelVideo = { id: string; title: string; thumbnail_url: string; duration: string; published_at: string | null; read_at: string | null };

/** 同じチャンネルの動画を、公開日の古い順に返す（公開日が無ければ記事の作成日）。
 *  app/text-tube/watch/[id]/page.tsx が、前後の回と一覧を出すために呼ぶ。チャンネル名が空の動画は
 *  「同じチャンネル」とは言えないので、空を返す。text_tube_videos_channel_idx を使う。 */
export async function channelVideos(channelName: string): Promise<ChannelVideo[]> {
  if (!channelName) return [];
  await ensureSchema({ seed: false });
  const rows = (await env.DB.prepare("SELECT id,title,thumbnail_url,duration,published_at,read_at FROM text_tube_videos WHERE deleted_at IS NULL AND channel_name=? ORDER BY COALESCE(published_at, created_at) ASC, id ASC LIMIT 300").bind(channelName).all<ChannelVideo>()).results ?? [];
  return rows;
}
