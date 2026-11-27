import { beforeAll, expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { GET as videosGet } from "@/app/api/text-tube/videos/route";
import { VIDEOS_PAGE_SIZE } from "@/app/lib/text-tube-query";

// The library used to return only the newest 100 videos, with each one's whole
// summary (tens of thousands of characters) in the list response, and had no way
// to reach the rest. These rows are written straight to D1 so the test controls
// created_at.
const TOTAL = VIDEOS_PAGE_SIZE + 5;

beforeAll(async () => {
  await ensureSchema({ seed: false });
  const statements = Array.from({ length: TOTAL }, (_, index) => {
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    return env.DB.prepare(
      "INSERT INTO text_tube_videos (id,title,channel_name,thumbnail_url,original_url,summary,published_at,view_count,channel_thumbnail_url,duration,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(`list-test-${String(index).padStart(3, "0")}`, `list-test video ${index}`, "list-test channel", "", "", "x".repeat(5000), null, 0, "", "", stamp, stamp);
  });
  for (let start = 0; start < statements.length; start += 50) await env.DB.batch(statements.slice(start, start + 50));
});

async function list(query: string) {
  const response = await videosGet(new Request(`http://x/api/text-tube/videos?${query}`));
  expect(response.status).toBe(200);
  return await response.json() as { videos: Array<Record<string, unknown>>; hasMore: boolean; channels?: Array<{ name: string; count: number }> };
}

test("the list pages through every video, newest first, without the summaries", async () => {
  const first = await list("q=list-test");
  expect(first.videos).toHaveLength(VIDEOS_PAGE_SIZE);
  expect(first.hasMore).toBe(true);
  expect(first.videos[0].id).toBe(`list-test-${TOTAL - 1}`);
  expect(first.videos.every((video) => !("summary" in video))).toBe(true);

  const second = await list(`q=list-test&offset=${first.videos.length}`);
  expect(second.videos).toHaveLength(TOTAL - VIDEOS_PAGE_SIZE);
  expect(second.hasMore).toBe(false);
  const ids = new Set([...first.videos, ...second.videos].map((video) => video.id));
  expect(ids.size).toBe(TOTAL);

  expect((await list(`q=list-test&offset=${TOTAL}`)).videos).toEqual([]);
});

test("a channel is narrowed on the server, so its videos past the first page are listed too", async () => {
  // 画面で絞っていたころは、先頭の100本に入っていない回が「チャンネルで絞る」で出なかった。
  // ここでは古い2本を別チャンネルにして、どのページにも混ざらない一覧が返ることを確かめる。
  const rows = [["chan-test-a1", "chan-test A"], ["chan-test-b1", "chan-test B"], ["chan-test-b2", "chan-test B"]];
  await env.DB.batch(rows.map(([id, channel], index) => {
    const stamp = new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString();
    return env.DB.prepare(
      "INSERT INTO text_tube_videos (id,title,channel_name,thumbnail_url,original_url,summary,published_at,view_count,channel_thumbnail_url,duration,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(id, `chan-test ${id}`, channel, "", "", "", null, 0, "", "", stamp, stamp);
  }));

  const narrowed = await list(`q=chan-test&channel=${encodeURIComponent("chan-test B")}`);
  expect(narrowed.videos.map((video) => video.id)).toEqual(["chan-test-b2", "chan-test-b1"]);
  // 選択肢はチャンネルの絞り込みを外して数える（選んだチャンネルだけにならない）。
  expect(narrowed.channels).toEqual([{ name: "chan-test A", count: 1 }, { name: "chan-test B", count: 2 }]);

  expect((await list("q=chan-test&channel=all")).videos).toHaveLength(3);
  // 続きのページでは選択肢を数え直さない。
  expect((await list("q=chan-test&offset=1")).channels).toBeUndefined();
});
