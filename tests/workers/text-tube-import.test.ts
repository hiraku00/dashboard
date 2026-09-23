import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { dismissTextTubeImport, pendingTextTubeImports, runTextTubeImport } from "@/app/lib/text-tube-import";
import { MISSING_VIDEO_ID } from "./fixtures/outbound-mocks";

// Covers app/lib/text-tube-import.ts, the Watch List -> TextTube
// auto-import this session added: a video is fetched (YouTube Data API +
// Supadata, both mocked -- see fixtures/outbound-mocks.ts) and saved into
// text_tube_videos/R2 without a summary, an already-reflected video is a
// no-op, a failure is recorded and surfaced by pendingTextTubeImports(),
// and dismissing one hides it again.

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

/** Eleven-character ids the videoIdPattern in
 *  app/lib/text-tube-import.ts accepts, each unique per test so runs don't
 *  interfere with each other's text_tube_imports/text_tube_videos rows. */
function videoId(tag: string) {
  return (tag + "00000000000").slice(0, 11);
}

test("creates the video and its document, and marks the import done", async () => {
  const id = videoId("run1");
  const result = await runTextTubeImport(id, null);
  if (result.status !== "done") throw new Error(`expected done, got ${result.status}`);

  const video = await env.DB.prepare("SELECT title, summary, youtube_video_id, detailed_script_object_key FROM text_tube_videos WHERE id=?")
    .bind(result.videoId)
    .first<{ title: string; summary: string; youtube_video_id: string; detailed_script_object_key: string | null }>();
  expect(video?.title).toBe("Sample Video");
  // The summary is deliberately left for the person to write by hand --
  // this is Watch List auto-import, not the AI-summarization feature that
  // was explicitly declined in favor of this simpler design.
  expect(video?.summary).toBe("");
  expect(video?.youtube_video_id).toBe(id);
  expect(video?.detailed_script_object_key).toBeTruthy();

  const importRow = await env.DB.prepare("SELECT status, video_id FROM text_tube_imports WHERE youtube_video_id=?")
    .bind(id)
    .first<{ status: string; video_id: string }>();
  expect(importRow?.status).toBe("done");
  expect(importRow?.video_id).toBe(result.videoId);
});

test("a video already reflected in TextTube is a no-op -- no new import row, no new video", async () => {
  const id = videoId("run2");
  const first = await runTextTubeImport(id, null);
  if (first.status !== "done") throw new Error(`expected done, got ${first.status}`);

  const before = await env.DB.prepare("SELECT COUNT(*) AS c FROM text_tube_imports WHERE youtube_video_id=?").bind(id).first<{ c: number }>();
  const second = await runTextTubeImport(id, null);
  expect(second).toEqual({ status: "reflected", videoId: first.videoId });
  const after = await env.DB.prepare("SELECT COUNT(*) AS c FROM text_tube_imports WHERE youtube_video_id=?").bind(id).first<{ c: number }>();
  expect(after!.c).toBe(before!.c); // no second attempt was recorded
});

test("a video the YouTube Data API doesn't recognize is recorded as failed and surfaced by pendingTextTubeImports()", async () => {
  const response = await runTextTubeImport(MISSING_VIDEO_ID, "item-for-banner");
  expect(response.status).toBe("failed");

  // Give the item a title so pendingTextTubeImports()'s LEFT JOIN has
  // something to show in the Watch List banner.
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO items (id,content_type,title,status,version,created_at,updated_at) VALUES (?,?,?,?,1,?,?) ON CONFLICT(id) DO NOTHING",
  ).bind("item-for-banner", "movie", "バナー確認用の項目", "backlog", now, now).run();

  const pending = await pendingTextTubeImports();
  const entry = pending.find((row) => row.youtubeVideoId === MISSING_VIDEO_ID);
  expect(entry).toBeTruthy();
  expect(entry?.status).toBe("failed");
  expect(entry?.itemId).toBe("item-for-banner");
  expect(entry?.itemTitle).toBe("バナー確認用の項目");
  expect(entry?.error).toBeTruthy();

  await dismissTextTubeImport(entry!.id);
  const pendingAfterDismiss = await pendingTextTubeImports();
  expect(pendingAfterDismiss.some((row) => row.id === entry!.id)).toBe(false);
});

test("a running import older than 10 minutes is treated as stuck, not blocking a fresh retry", async () => {
  const id = videoId("stuck1");
  const staleId = crypto.randomUUID();
  const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO text_tube_imports (id,youtube_video_id,item_id,status,attempts,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).bind(staleId, id, null, "running", 1, "", staleTime, staleTime).run();

  const pending = await pendingTextTubeImports();
  const stuckEntry = pending.find((row) => row.youtubeVideoId === id);
  expect(stuckEntry?.status).toBe("stuck");

  // A fresh call is not blocked by the stale running row (which would
  // otherwise leave this video stuck forever with no way to retry).
  const result = await runTextTubeImport(id, null);
  expect(result.status).toBe("done");

  // The newer 'done' row is now the latest for this youtube_video_id, so it
  // no longer shows up as needing attention.
  const pendingAfter = await pendingTextTubeImports();
  expect(pendingAfter.some((row) => row.youtubeVideoId === id)).toBe(false);
});

test("rejects a malformed video id without touching D1", async () => {
  const result = await runTextTubeImport("not-a-valid-id", null);
  expect(result).toEqual({ status: "failed", error: "YouTube動画IDが不正です。" });
});
