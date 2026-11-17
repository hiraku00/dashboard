import { beforeAll, expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { GET as videosGet, POST as videosPost } from "@/app/api/text-tube/videos/route";
import { POST as readPost } from "@/app/api/text-tube/videos/[id]/read/route";
import { channelVideos } from "@/app/lib/queries/text-tube";
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

test("marking a video read sets read_at, the unread filter leaves it out, and it can be undone", async () => {
  const add = async (title: string) => (await (await videosPost(new Request("http://x/api/text-tube/videos", json("POST", { title, channelName: "read-test channel" })))).json() as { id: string }).id;
  const readId = await add("read-test A");
  const unreadId = await add("read-test B");
  const mark = (id: string, body: unknown) => readPost(new Request(`http://x/api/text-tube/videos/${id}/read`, json("POST", body)), context(id));
  const listed = async (query: string) => ((await (await videosGet(new Request(`http://x/api/text-tube/videos?${query}`))).json()) as { videos: Array<{ id: string; read_at: string | null }> }).videos;

  const marked = await mark(readId, { read: true });
  expect(marked.status).toBe(200);
  expect((await marked.json() as { readAt: string }).readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  const all = await listed("q=read-test");
  expect(all.find((video) => video.id === readId)?.read_at).toBeTruthy();
  expect(all.find((video) => video.id === unreadId)?.read_at).toBeNull();
  expect((await listed("q=read-test&unread=1")).map((video) => video.id)).toEqual([unreadId]);

  expect((await mark(readId, { read: false })).status).toBe(200);
  expect((await listed("q=read-test&unread=1")).map((video) => video.id).sort()).toEqual([readId, unreadId].sort());

  expect((await mark(readId, { read: "yes" })).status).toBe(400);
  expect((await mark("no-such-video", { read: true })).status).toBe(404);
});

test("channelVideos returns the channel's videos oldest first, and nothing for an empty channel name", async () => {
  const insert = (id: string, publishedAt: string | null, createdAt: string, channel = "order-test channel") => env.DB.prepare(
    "INSERT INTO text_tube_videos (id,title,channel_name,published_at,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  ).bind(id, id, channel, publishedAt, createdAt, createdAt).run();
  await insert("order-3", "2022-03-17T00:00:00Z", "2026-01-01T00:00:00Z");
  await insert("order-1", "2022-03-03T00:00:00Z", "2026-01-03T00:00:00Z");
  await insert("order-2", "2022-03-10T00:00:00Z", "2026-01-02T00:00:00Z");
  await insert("order-other", "2022-03-05T00:00:00Z", "2026-01-02T00:00:00Z", "another channel");
  expect((await channelVideos("order-test channel")).map((video) => video.id)).toEqual(["order-1", "order-2", "order-3"]);
  expect(await channelVideos("")).toEqual([]);
});
