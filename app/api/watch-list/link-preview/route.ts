import { route } from "@/app/lib/route";
import { parseLinkPreview } from "@/app/lib/link-preview";
import { safeUrl } from "@/app/lib/openchat-meta";
import { fetchPageHead } from "@/app/lib/thumbnail-fetch";

/** Watch List の編集画面: 1つ目のリンクのページから、放送局・番組名・タイトルを読み取って返す(YouTube は youtube-preview が担当)。 */
export const POST = route(async (request: Request) => {
  const body = await request.json().catch(() => null) as { url?: unknown } | null;
  const url = safeUrl(body?.url);
  if (!url) return Response.json({ error: "http:// または https:// で始まるURLを入力してください。" }, { status: 400 });
  const page = await fetchPageHead(url);
  if (!page) return Response.json({ error: "リンク先のページを読み取れませんでした。" }, { status: 422 });
  const preview = parseLinkPreview(page.html, page.url);
  if (!preview.creatorName && !preview.seriesTitle && !preview.title) return Response.json({ error: "リンク先から番組情報を読み取れませんでした。" }, { status: 422 });
  return Response.json({ preview });
});
