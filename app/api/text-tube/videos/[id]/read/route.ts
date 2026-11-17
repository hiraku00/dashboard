import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { route } from "@/app/lib/route";

type Context = { params: Promise<{ id: string }> };

/** 動画を読了にする（`{ read: true }`）、または未読に戻す（`{ read: false }`）。
 *
 *  動画の PATCH とは別にしてあるのは、あちらが全項目を上書きする保存だから -- 記事ページは
 *  要約の全文を送り返さずに、この1列だけを変えたい。updated_at は変えない（内容の更新ではないので）。 */
export const POST = route(async (request: Request, context: Context) => {
  await ensureSchema({ seed: false });
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { read?: unknown } | null;
  if (typeof body?.read !== "boolean") return Response.json({ error: "read は true か false で指定してください。" }, { status: 400 });
  const readAt = body.read ? new Date().toISOString() : null;
  const result = await env.DB.prepare("UPDATE text_tube_videos SET read_at=? WHERE id=? AND deleted_at IS NULL").bind(readAt, id).run();
  if (!result.meta.changes) return Response.json({ error: "動画が見つかりません。" }, { status: 404 });
  return Response.json({ ok: true, readAt });
});
