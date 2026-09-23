/** Saves a TextTube video's detailed-script body to R2 and records the
 *  revision. Moved out of app/api/text-tube/videos/[id]/document/route.ts's
 *  POST handler so app/lib/text-tube-import.ts (the Watch List auto-import)
 *  can save the transcript it fetches through the same path Studio's edit
 *  form uses -- one place writing text_tube_video_revisions means the two
 *  callers cannot record it differently. */
import { env } from "cloudflare:workers";
import { putPortalObject, sha256 } from "@/app/lib/r2-storage";

export async function saveVideoDocument(videoId: string, body: ArrayBuffer) {
  const hash = await sha256(body);
  const key = `text-tube/videos/${videoId}/document-${hash.slice(0, 16)}.md`;
  const stored = await putPortalObject({
    key,
    body,
    category: "text-tube/videos",
    contentType: "text/markdown",
    sha: hash,
  });
  const now = new Date().toISOString();
  const revision =
    Number(
      (
        await env.DB.prepare(
          "SELECT COALESCE(MAX(revision_number),0) AS value FROM text_tube_video_revisions WHERE video_id=?",
        )
          .bind(videoId)
          .all<{ value: number }>()
      ).results?.[0]?.value ?? 0,
    ) + 1;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE text_tube_videos SET detailed_script_object_key=?,detailed_script_sha256=?,detailed_script_size=?,updated_at=? WHERE id=?",
    ).bind(key, hash, body.byteLength, now, videoId),
    env.DB.prepare(
      "INSERT INTO text_tube_video_revisions (id,video_id,revision_number,document_object_key,document_sha256,document_size,created_at) VALUES (?,?,?,?,?,?,?)",
    ).bind(crypto.randomUUID(), videoId, revision, key, hash, stored.size, now),
  ]);
  return { key, sha256: hash, size: body.byteLength };
}
