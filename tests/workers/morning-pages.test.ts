import { beforeAll, describe, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { POST as ingestPost } from "@/app/api/morning-pages/route";
import { buildMorningModel } from "@/app/lib/morning-page-model";
import { morningPageView } from "@/app/lib/queries/morning-page";

// モーニングページの取り込みAPIと読み出し: 作成 → 同じ内容で skipped → 内容変更で updated → 不正な件の error と、
// Service Token 以外からの拒否、月ごとの集計・検索を、実際の(ephemeralな)D1で確かめる。
// 実際のページは個人的な内容を含むので、書式だけを写した架空の内容を使う。

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

const assertion = (payload: Record<string, unknown>) => {
  const part = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${part({ alg: "RS256", kid: "test" })}.${part(payload)}.signature`;
};
const SERVICE = { "cf-access-jwt-assertion": assertion({ common_name: "test-client.access", sub: "" }) };
const BROWSER = { "cf-access-jwt-assertion": assertion({ email: "someone@example.com", sub: "user" }) };

type Json = Record<string, unknown>;
type Result = { date: string; status: string; error?: string };

async function ingest(body: unknown, headers: Record<string, string> = SERVICE) {
  const response = await ingestPost(new Request("http://x/api/morning-pages", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { response, body: (await response.json()) as Json & { results: Result[] } };
}

const page = (date: string, patch: Record<string, unknown> = {}) => ({
  date, startedAt: "08:00", endedAt: "08:40", minutes: 40, place: "自宅", chars: 2000,
  yesterday: ["図書館へ行った"], plan: ["ブログを書く"], notes: ["自転車のタイヤの空気が少ない"], extracted: true, ...patch,
});

describe("POST /api/morning-pages", () => {
  test("creates, then skips the same content, then updates a changed page", async () => {
    const first = await ingest({ pages: [page("2023-06-15"), page("2023-06-16")] });
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({ created: 2, updated: 0, skipped: 0, errors: 0 });

    const again = await ingest({ pages: [page("2023-06-15"), page("2023-06-16")] });
    expect(again.body).toMatchObject({ created: 0, updated: 0, skipped: 2 });

    const changed = await ingest({ pages: [page("2023-06-15", { notes: ["別の気がかり"] }), page("2023-06-16")] });
    expect(changed.body).toMatchObject({ created: 0, updated: 1, skipped: 1 });
  });

  test("a bad page is that page's error only, and a duplicate date in one request is refused", async () => {
    const { response, body } = await ingest({ pages: [page("2023-07-01"), { ...page("2023-07-02"), minutes: 5000 }, page("2023-07-01")] });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ created: 1, errors: 2 });
    expect(body.results.filter((r) => r.status === "error").map((r) => r.date).sort()).toEqual(["2023-07-01", "2023-07-02"]);
  });

  test("rejects an empty or oversized request and every caller that is not a service token", async () => {
    expect((await ingest({ pages: [] })).response.status).toBe(400);
    expect((await ingest({})).response.status).toBe(400);
    expect((await ingest({ pages: Array.from({ length: 51 }, (_, i) => page(`2023-08-${String((i % 28) + 1).padStart(2, "0")}`)) })).response.status).toBe(400);
    for (const headers of [{}, BROWSER, { "cf-access-jwt-assertion": "not-a-jwt" }]) {
      expect((await ingest({ pages: [page("2023-09-01")] }, headers)).response.status).toBe(403);
    }
  });
});

describe("morningPageView + buildMorningModel", () => {
  test("opens the newest month by default, aggregates every month, and searches all of them", async () => {
    await ingest({ pages: [
      page("2024-02-10", { minutes: 30, chars: 1000, notes: ["引っ越しの手続きが心配"] }),
      page("2024-02-11", { minutes: 50, chars: 3000, extracted: false, yesterday: [], plan: [], notes: [] }),
      page("2024-03-01", { place: "ホテル(Hi Hotel Bangkok)", minutes: null, chars: null, plan: ["引っ越し先を探す"], notes: [] }),
    ] });

    const latest = buildMorningModel(await morningPageView(null, ""));
    expect(latest.month).toBe("2024-03");
    expect(latest.days.map((d) => d.date)).toEqual(["2024-03-01"]);
    expect(latest.days[0]).toMatchObject({ minutes: null, chars: null, place: "ホテル(Hi Hotel Bangkok)" });

    const feb = buildMorningModel(await morningPageView("2024-02", ""));
    expect(feb.stats).toMatchObject({ pages: 2, avgMinutes: 40, avgChars: 2000 });
    expect(feb.trend.find((t) => t.month === "2024-02")).toMatchObject({ pages: 2, avgMinutes: 40 });
    expect(feb.notes).toEqual([{ date: "2024-02-10", text: "引っ越しの手続きが心配" }]);
    expect(feb.extractedDays).toBe(1);

    const found = buildMorningModel(await morningPageView("2024-03", "引っ越し"));
    expect(found.search?.hits.map((h) => [h.date, h.kind]).sort()).toEqual([["2024-02-10", "notes"], ["2024-03-01", "plan"]]);
    // LIKE の特殊文字は文字として探す(% や _ で全件にならない)
    expect((await morningPageView("2024-03", "100%")).search?.hits).toEqual([]);
    expect((await morningPageView("2024-03", "_")).search?.hits).toEqual([]);
  });
});
