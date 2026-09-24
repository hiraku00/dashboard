import { beforeAll, describe, expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { POST as syncPost } from "@/app/api/openchat/sync/route";
import { GET as programsGet } from "@/app/api/openchat/programs/route";
import { GET as ledgerGet } from "@/app/api/openchat/ledger/route";
import { latestOpenchatRun, listPrograms } from "@/app/lib/queries/openchat";

// ちきりんオプチャ: 同期API(start → notes → complete)と、画面用の一覧・台帳の復元。
// 実際の(ephemeralな)D1に対して行う。ちきりんさん以外のコメント本文が一覧に出ないことも確かめる。

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

let seq = 0;
const uid = (prefix: string) => `${prefix}${String(++seq).padStart(4, "0")}-0000-4000-8000-000000000000`;

type Json = Record<string, unknown>;

async function sync(body: Record<string, unknown>) {
  const response = await syncPost(new Request("http://x/api/openchat/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { response, body: (await response.json()) as Json };
}

const comment = (over: Record<string, unknown> = {}) => ({
  id: uid("c"), ordinal: 0, authorName: "参加者", isTarget: false, bodyText: "他の人のコメント本文", postedAt: "2026-09-23T14:00:00Z",
  postedAtPrecision: "exact", postedAtRaw: "昨日 午後 11:00", ocrMinConfidence: 1, firstSeenAt: "2026-09-24T03:00:00Z", lastSeenAt: "2026-09-24T03:00:00Z", deletedAt: null, ...over,
});

const note = (over: Record<string, unknown> = {}) => ({
  id: uid("n"), room: "atsumare-tv", authorName: "参加者B", authorIsTarget: false, programTitle: "8/23放送 NHKスペシャル", linkTitle: "地球超解析",
  linkUrl: "https://www.nhk-ondemand.jp/x", bodyText: "他の人が立てたノートの本文", bodyComplete: false, postedAt: "2026-09-21T06:47:00Z", postedAtPrecision: "exact",
  postedAtRaw: "9.21 午後 3:47", commentCount: 0, needsRecheck: false, firstSeenAt: "2026-09-24T03:00:00Z", lastCheckedAt: "2026-09-24T03:00:00Z", deletedAt: null, comments: [], ...over,
});

let run = "";
async function startRun() {
  run = `run-${uid("r")}`;
  const { response, body } = await sync({ action: "start", clientRunId: run, clientVersion: "test" });
  expect(response.status).toBe(200);
  return body.runId as string;
}
const send = (notes: unknown[]) => sync({ action: "notes", clientRunId: run, notes });

describe("sync API", () => {
  test("start is idempotent for a retried request and unknown runs are rejected", async () => {
    const id1 = await startRun();
    const again = await sync({ action: "start", clientRunId: run });
    expect(again.body.runId).toBe(id1);
    const unknown = await sync({ action: "notes", clientRunId: "nope", notes: [note()] });
    expect(unknown.response.status).toBe(404);
    expect((await sync({ action: "bogus", clientRunId: run })).response.status).toBe(400);
    expect((await syncPost(new Request("http://x", { method: "POST", body: "not json" }))).status).toBe(400);
  });

  test("saves a note with its comments, and the same request sent twice changes nothing", async () => {
    await startRun();
    const n = note({ commentCount: 2, comments: [comment({ ordinal: 0 }), comment({ ordinal: 1, isTarget: true, authorName: "ちきりん", bodyText: "ちきりんさんの一つ目" })] });
    const first = await send([n]);
    expect(first.response.status).toBe(200);
    expect(first.body.ok).toBe(true);
    const again = await send([n]);
    expect(again.body.ok).toBe(true);
    const rows = (await env.DB.prepare("SELECT COUNT(*) AS c FROM openchat_comments WHERE note_id=?").bind(n.id).all<{ c: number }>()).results?.[0];
    expect(rows?.c).toBe(2);
    const stored = (await env.DB.prepare("SELECT target_comment_count, comment_count, posted_at FROM openchat_notes WHERE id=?").bind(n.id).all<Record<string, number | string>>()).results?.[0];
    expect(stored).toMatchObject({ target_comment_count: 1, comment_count: 2, posted_at: "2026-09-21T06:47:00Z" });
  });

  test("comments of one note split over several requests add up (multiple comments by the target)", async () => {
    await startRun();
    const n = note({ authorName: "ちきりん", authorIsTarget: true, bodyText: "ちきりんさんのスレッド", programTitle: "分割テスト", commentCount: 3 });
    const t1 = comment({ ordinal: 0, isTarget: true, authorName: "ちきりん", bodyText: "本人コメント1" });
    const t2 = comment({ ordinal: 2, isTarget: true, authorName: "ちきりん", bodyText: "本人コメント2" });
    await send([{ ...n, comments: [t1, comment({ ordinal: 1 })] }]);
    await send([{ ...n, comments: [t2] }]);
    const stored = (await env.DB.prepare("SELECT target_comment_count FROM openchat_notes WHERE id=?").bind(n.id).all<{ target_comment_count: number }>()).results?.[0];
    expect(stored?.target_comment_count).toBe(2);
    // 1件が削除された(deletedAt)と、数え直される
    await send([{ ...n, comments: [{ ...t1, deletedAt: "2026-09-24T05:00:00Z" }] }]);
    const after = (await env.DB.prepare("SELECT target_comment_count FROM openchat_notes WHERE id=?").bind(n.id).all<{ target_comment_count: number }>()).results?.[0];
    expect(after?.target_comment_count).toBe(1);
  });

  test("first_seen_at is kept from the first sighting", async () => {
    await startRun();
    const n = note({ firstSeenAt: "2026-09-20T00:00:00Z" });
    await send([n]);
    await send([{ ...n, firstSeenAt: "2026-09-25T00:00:00Z", commentCount: 4 }]);
    const row = (await env.DB.prepare("SELECT first_seen_at, comment_count FROM openchat_notes WHERE id=?").bind(n.id).all<Record<string, string | number>>()).results?.[0];
    expect(String(row?.first_seen_at)).toContain("2026-09-20");
    expect(row?.comment_count).toBe(4);
  });

  test("one invalid note is reported but does not stop the valid ones", async () => {
    await startRun();
    const good = note();
    const bad = note({ postedAt: "yesterday" });
    const { response, body } = await send([good, bad]);
    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    const byId = Object.fromEntries((body.results as Array<{ id: string; error?: string }>).map((r) => [r.id, r]));
    expect(byId[good.id].error).toBeUndefined();
    expect(byId[bad.id].error).toBeTruthy();
    const saved = (await env.DB.prepare("SELECT COUNT(*) AS c FROM openchat_notes WHERE id=?").bind(good.id).all<{ c: number }>()).results?.[0];
    expect(saved?.c).toBe(1);
  });

  test("malformed batches are rejected outright", async () => {
    await startRun();
    expect((await send([])).response.status).toBe(400);
    expect((await sync({ action: "notes", clientRunId: run, notes: "x" })).response.status).toBe(400);
    expect((await send(Array.from({ length: 11 }, () => note()))).response.status).toBe(400);
  });

  test("complete records the run summary", async () => {
    await startRun();
    const { response } = await sync({ action: "complete", clientRunId: run, status: "partial", stats: { notesScanned: 30, notesOpened: 4, commentsNew: 12, targetCommentsNew: 2 }, warnings: ["件数不一致"] });
    expect(response.status).toBe(200);
    const latest = await latestOpenchatRun();
    expect(latest).toMatchObject({ status: "partial", notesScanned: 30, notesOpened: 4, commentsNew: 12, targetCommentsNew: 2, warningCount: 1 });
    expect((await sync({ action: "complete", clientRunId: run, status: "weird" })).response.status).toBe(400);
  });
});

describe("programs list", () => {
  const SECRET = "ほかの人だけが知っている秘密のコメント文言";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await ensureSchema({ seed: false });
    await startRun();
    const threadMine = note({ authorName: "ちきりん", authorIsTarget: true, programTitle: "一覧テスト: 本人スレッド", bodyText: "ちきりんさんが立てた本文", bodyComplete: true,
      postedAt: "2026-09-22T12:00:00Z", comments: [comment({ ordinal: 0, authorName: "ちきりん", isTarget: true, bodyText: "本人スレッドへの補足", postedAt: "2026-09-22T13:00:00Z" }), comment({ ordinal: 1, bodyText: SECRET })] });
    const commentedOthers = note({ programTitle: "一覧テスト: 他人のノートに複数コメント", bodyText: "他人のノート本文(表示されない)", postedAt: "2026-09-21T06:00:00Z",
      comments: [comment({ ordinal: 0, authorName: "ちきりん", isTarget: true, bodyText: "一つ目のコメント 鉄道会社", postedAt: "2026-09-21T07:00:00Z" }),
        comment({ ordinal: 1, bodyText: SECRET }),
        comment({ ordinal: 2, authorName: "ちきりん", isTarget: true, bodyText: "二つ目のコメント", postedAt: "2026-09-21T09:00:00Z", postedAtPrecision: "approx_hour" })] });
    const noTarget = note({ programTitle: "一覧テスト: ちきりんさん無し", bodyText: "無関係", postedAt: "2026-09-20T06:00:00Z", comments: [comment({ bodyText: SECRET })] });
    const deleted = note({ programTitle: "一覧テスト: 削除済み", authorName: "ちきりん", authorIsTarget: true, deletedAt: "2026-09-24T00:00:00Z", postedAt: "2026-09-19T06:00:00Z" });
    ids.mine = threadMine.id; ids.others = commentedOthers.id; ids.none = noTarget.id; ids.deleted = deleted.id;
    for (const n of [threadMine, commentedOthers, noTarget, deleted]) await send([n]);
  });

  test("lists only notes with the target's thread or comments, newest first", async () => {
    const page = await listPrograms({});
    const titles = page.programs.map((p) => p.programTitle).filter((t) => t.startsWith("一覧テスト"));
    expect(titles).toEqual(["一覧テスト: 本人スレッド", "一覧テスト: 他人のノートに複数コメント"]);
  });

  test("a note the target commented on more than once carries every one of her comments, oldest first", async () => {
    const p = (await listPrograms({ q: "他人のノートに複数" })).programs[0];
    expect(p.noteByTarget).toBe(false);
    expect(p.targetBody).toBeNull();
    expect(p.targetComments.map((c) => c.bodyText)).toEqual(["一つ目のコメント 鉄道会社", "二つ目のコメント"]);
    expect(p.targetComments[1].precision).toBe("approx_hour");
  });

  test("the target's own thread shows her body and her comments on it", async () => {
    const p = (await listPrograms({ q: "本人スレッド" })).programs[0];
    expect(p.noteByTarget).toBe(true);
    expect(p.targetBody).toBe("ちきりんさんが立てた本文");
    expect(p.targetComments.map((c) => c.bodyText)).toEqual(["本人スレッドへの補足"]);
  });

  test("other people's comments and note bodies never appear in any response, and cannot be found by search", async () => {
    const everything = JSON.stringify(await listPrograms({ limit: 50 }));
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("他人のノート本文(表示されない)");
    expect((await listPrograms({ q: "秘密のコメント" })).programs).toEqual([]);
    expect((await listPrograms({ q: "他人のノート本文" })).programs).toEqual([]);
    const viaApi = await (await programsGet(new Request("http://x/api/openchat/programs?limit=50"))).text();
    expect(viaApi).not.toContain(SECRET);
  });

  test("search finds titles and the target's own text; kind filters work", async () => {
    expect((await listPrograms({ q: "鉄道会社" })).programs.map((p) => p.programTitle)).toEqual(["一覧テスト: 他人のノートに複数コメント"]);
    expect((await listPrograms({ q: "ちきりんさんが立てた" })).programs).toHaveLength(1);
    const threads = (await listPrograms({ kind: "thread" })).programs.filter((p) => p.programTitle.startsWith("一覧テスト"));
    expect(threads.map((p) => p.noteByTarget)).toEqual([true]);
    const comments = (await listPrograms({ kind: "comment" })).programs.filter((p) => p.programTitle.startsWith("一覧テスト"));
    expect(comments).toHaveLength(2);       // 本人スレッドにも本人のコメントがある
  });

  test("keyset pagination returns every program once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page = await listPrograms({ limit: 1, cursor });
      seen.push(...page.programs.map((p) => p.noteId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining([ids.mine, ids.others]));
    expect(seen).not.toContain(ids.none);
    expect(seen).not.toContain(ids.deleted);
  });

  test("a comment marked deleted is no longer listed", async () => {
    const p = (await listPrograms({ q: "他人のノートに複数" })).programs[0];
    const target = p.targetComments[0];
    await startRun();
    await send([note({ id: ids.others, room: "atsumare-tv", programTitle: "一覧テスト: 他人のノートに複数コメント", postedAt: "2026-09-21T06:00:00Z",
      comments: [comment({ id: target.id, ordinal: 0, authorName: "ちきりん", isTarget: true, bodyText: target.bodyText, postedAt: target.postedAt, deletedAt: "2026-09-24T05:00:00Z" })] })]);
    const after = (await listPrograms({ q: "他人のノートに複数" })).programs[0];
    expect(after.targetComments.map((c) => c.bodyText)).toEqual(["二つ目のコメント"]);
  });
});

describe("ledger restore", () => {
  test("requires an explicit confirmation and returns only what matching needs", async () => {
    expect((await ledgerGet(new Request("http://x/api/openchat/ledger"))).status).toBe(400);
    await startRun();
    const long = "あ".repeat(500);
    const n = note({ programTitle: "台帳テスト", bodyText: long, comments: [comment({ bodyText: long })] });
    await send([n]);
    const response = await ledgerGet(new Request("http://x/api/openchat/ledger?confirm=restore"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { notes: Array<Json & { bodyHead: string }>; comments: Array<Json & { bodyHead: string }>; truncated: boolean };
    const got = body.notes.find((x) => x.id === n.id)!;
    expect(got.bodyHead.length).toBe(200);
    expect(got).not.toHaveProperty("bodyText");
    expect(body.comments.find((c) => c.noteId === n.id)!.bodyHead.length).toBe(200);
    expect(body.truncated).toBe(false);
  });
});

describe("Python collector contract", () => {
  test("the payload the collector's uploader produces (from a simulated LINE session) is accepted as-is", async () => {
    const fixture = (await import("./fixtures/openchat-sync-payload.json")).default as { notes: Array<{ id: string; authorIsTarget: boolean; comments: Array<{ isTarget: boolean }> }> };
    await startRun();
    const { response, body } = await send(fixture.notes);
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    const targetComments = fixture.notes.flatMap((n) => n.comments).filter((c) => c.isTarget).length;
    expect(targetComments).toBeGreaterThanOrEqual(2);
    const ids = fixture.notes.map((n) => n.id);
    const rows = (await env.DB.prepare(`SELECT SUM(target_comment_count) AS t FROM openchat_notes WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ t: number }>()).results?.[0];
    expect(rows?.t).toBe(targetComments);
    const listed = await listPrograms({ limit: 50 });
    expect(listed.programs.some((p) => p.noteByTarget && p.targetComments.length >= 1)).toBe(true);
  });
});
