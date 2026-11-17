import { beforeAll, expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { POST as videosPost } from "@/app/api/text-tube/videos/route";
import { DELETE as videoDelete, PATCH as videoPatch } from "@/app/api/text-tube/videos/[id]/route";

// A video added by hand used to be saved without youtube_video_id, the column
// the Watch List auto-import looks a link up by, and saving or deleting a video
// that does not exist answered as if it had worked.

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

const json = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const youtubeId = async (id: string) => (await env.DB.prepare("SELECT youtube_video_id FROM text_tube_videos WHERE id = ?").bind(id).first<{ youtube_video_id: string | null }>())?.youtube_video_id;

test("a hand-added video stores its YouTube id, and an edit keeps it in step with the URL", async () => {
  const created = await videosPost(new Request("http://x/api/text-tube/videos", json("POST", { title: "manual video", originalUrl: "https://www.youtube.com/watch?v=abcdefghijk" })));
  expect(created.status).toBe(201);
  const { id } = await created.json() as { id: string };
  expect(await youtubeId(id)).toBe("abcdefghijk");

  const edited = await videoPatch(new Request(`http://x/api/text-tube/videos/${id}`, json("PATCH", { title: "manual video", originalUrl: "https://youtu.be/ZYXWVUTSRQP" })), context(id));
  expect(edited.status).toBe(200);
  expect(await youtubeId(id)).toBe("ZYXWVUTSRQP");

  const cleared = await videoPatch(new Request(`http://x/api/text-tube/videos/${id}`, json("PATCH", { title: "manual video", originalUrl: "" })), context(id));
  expect(cleared.status).toBe(200);
  expect(await youtubeId(id)).toBeNull();
});

test("saving or deleting a video that is not there is a 404", async () => {
  const missing = "no-such-video";
  expect((await videoPatch(new Request(`http://x/api/text-tube/videos/${missing}`, json("PATCH", { title: "x" })), context(missing))).status).toBe(404);
  expect((await videoDelete(new Request(`http://x/api/text-tube/videos/${missing}`, json("DELETE")), context(missing))).status).toBe(404);

  const created = await videosPost(new Request("http://x/api/text-tube/videos", json("POST", { title: "to delete" })));
  const { id } = await created.json() as { id: string };
  expect((await videoDelete(new Request(`http://x/api/text-tube/videos/${id}`, json("DELETE")), context(id))).status).toBe(200);
  expect((await videoDelete(new Request(`http://x/api/text-tube/videos/${id}`, json("DELETE")), context(id))).status).toBe(404);
});
