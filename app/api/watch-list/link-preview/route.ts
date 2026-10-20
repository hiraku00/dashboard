import { route } from "@/app/lib/route";
import { safeUrl } from "@/app/lib/openchat-meta";
import { fetchLinkPreview } from "@/app/lib/thumbnail-fetch";
import { youTubeVideoId } from "@/app/lib/youtube";
import { fetchYouTubeMetadata } from "@/app/lib/youtube-page-fetch";

/** リンクのページから、放送局(人物・媒体)・番組名(チャンネル名)・タイトルを読み取って返す。
 *  ちきりんオプチャ詳細の「リンクから番組情報を取得」と、Watch List の「リンクから入力」が同じこれを使う。
 *  YouTube は視聴ページ(と oEmbed)、TVer は公開JSON、NHK ONE・テレ東BIZ などはページのHTMLから読む。 */
export const POST = route(async (request: Request) => {
  const body = await request.json().catch(() => null) as { url?: unknown } | null;

  const videoId = youTubeVideoId(body?.url);
  if (videoId) {
    const result = await fetchYouTubeMetadata(videoId);
    if (!("metadata" in result)) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ preview: { creatorName: "", seriesTitle: result.metadata.seriesTitle, title: result.metadata.title }, url: `https://www.youtube.com/watch?v=${videoId}` });
  }

  const url = safeUrl(body?.url);
  if (!url) return Response.json({ error: "http:// または https:// で始まるURLを入力してください。" }, { status: 400 });
  const page = await fetchLinkPreview(url);
  if (!page) return Response.json({ error: "リンク先のページを読み取れませんでした。" }, { status: 422 });
  const { preview } = page;
  if (!preview.creatorName && !preview.seriesTitle && !preview.title) return Response.json({ error: "リンク先から番組情報を読み取れませんでした。" }, { status: 422 });
  return Response.json({ preview, url: page.url });
});
