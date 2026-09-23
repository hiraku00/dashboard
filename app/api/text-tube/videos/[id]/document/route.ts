import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { getPortalObject } from "@/app/lib/r2-storage";
import { saveVideoDocument } from "@/app/lib/text-tube-document";
import { route } from "@/app/lib/route";

type Context = { params: Promise<{ id: string }> };

export const GET = route(async (_request: Request, context: Context) => {
  await ensureSchema({ seed: false }); const { id } = await context.params;
  // This is the only reader of the detailed script body left (the watch
  // page no longer displays it -- see app/text-tube/watch/watch-app.tsx).
  // Studio's edit form is the caller, so a missing R2 object behind a
  // recorded key is a real data-integrity problem worth a 404 here, in
  // server logs or a direct API call, rather than silently degrading to "".
  const video = (await env.DB.prepare("SELECT detailed_script_object_key FROM text_tube_videos WHERE id=? AND deleted_at IS NULL").bind(id).all<{ detailed_script_object_key: string | null }>()).results?.[0];
  if (!video?.detailed_script_object_key) return new Response("", { headers: { "content-type": "text/markdown; charset=utf-8" } });
  const object = await getPortalObject(video.detailed_script_object_key); if (!object) return Response.json({ error: "本文ファイルが見つかりません。" }, { status: 404 });
  return new Response(object.body, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "private, max-age=300" } });
});

export const POST = route(async (request: Request, context: Context) => {
  await ensureSchema({ seed: false }); const { id } = await context.params;
  const video = (await env.DB.prepare("SELECT id FROM text_tube_videos WHERE id=? AND deleted_at IS NULL").bind(id).all()).results?.[0];
  if (!video) return Response.json({ error: "動画が見つかりません。" }, { status: 404 });
  const body = await request.arrayBuffer(); if (body.byteLength > 5 * 1024 * 1024) return Response.json({ error: "本文は5MB以内にしてください。" }, { status: 413 });
  const stored = await saveVideoDocument(id, body);
  return Response.json({ ok: true, ...stored });
});
