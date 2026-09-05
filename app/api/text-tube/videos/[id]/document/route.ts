import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { getPortalObject } from "@/app/lib/portal";
import { putPortalObject, sha256 } from "@/app/lib/portal";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  await ensureSchema({ seed: false }); const { id } = await context.params;
  // Deliberately not routed through getVideoDocument() in
  // app/lib/queries/text-tube.ts: that helper folds a missing R2 object into
  // an empty string (matching the SSR watch page's needs), while this route
  // still needs to tell the two cases apart -- a 404 here is what makes the
  // data-integrity problem (a key recorded with no object behind it)
  // visible at all, in server logs or a direct API call.
  const video = (await env.DB.prepare("SELECT detailed_script_object_key FROM text_tube_videos WHERE id=? AND deleted_at IS NULL").bind(id).all<{ detailed_script_object_key: string | null }>()).results?.[0];
  if (!video?.detailed_script_object_key) return new Response("", { headers: { "content-type": "text/markdown; charset=utf-8" } });
  const object = await getPortalObject(video.detailed_script_object_key); if (!object) return Response.json({ error: "本文ファイルが見つかりません。" }, { status: 404 });
  return new Response(object.body, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "private, max-age=300" } });
}

export async function POST(request: Request, context: Context) {
  await ensureSchema({ seed: false }); const { id } = await context.params;
  const video = (await env.DB.prepare("SELECT id FROM text_tube_videos WHERE id=? AND deleted_at IS NULL").bind(id).all()).results?.[0];
  if (!video) return Response.json({ error: "動画が見つかりません。" }, { status: 404 });
  const body = await request.arrayBuffer(); if (body.byteLength > 5 * 1024 * 1024) return Response.json({ error: "本文は5MB以内にしてください。" }, { status: 413 });
  const hash = await sha256(body); const key = `text-tube/videos/${id}/document-${hash.slice(0,16)}.md`; const stored = await putPortalObject({ key, body, category: "text-tube/videos", contentType: "text/markdown", sha: hash });
  const now = new Date().toISOString(); const revision = Number((await env.DB.prepare("SELECT COALESCE(MAX(revision_number),0) AS value FROM text_tube_video_revisions WHERE video_id=?").bind(id).all<{value:number}>()).results?.[0]?.value ?? 0) + 1;
  await env.DB.batch([
    env.DB.prepare("UPDATE text_tube_videos SET detailed_script_object_key=?,detailed_script_sha256=?,detailed_script_size=?,updated_at=? WHERE id=?").bind(key,hash,body.byteLength,now,id),
    env.DB.prepare("INSERT INTO text_tube_video_revisions (id,video_id,revision_number,document_object_key,document_sha256,document_size,created_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),id,revision,key,hash,stored.size,now),
  ]);
  return Response.json({ ok: true, key, sha256: hash, size: body.byteLength });
}
