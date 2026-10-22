import { beforeAll, describe, expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { POST as ingestPost } from "@/app/api/daily-report-summaries/route";
import { DELETE as summaryDelete } from "@/app/api/daily-report-summaries/[kind]/[periodStart]/route";

// 週次・月次サマリの取り込みAPI: 作成 → 同じ内容で skipped → 内容変更で updated → 期間の検証エラー → delete と、
// Service Token 以外からの拒否を、実際の(ephemeralな)D1で確かめる。
// 実際のサマリは個人的な内容を含むので、書式だけを写した架空のサマリを使う。

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

/** Access が付ける assertion の形だけを真似る。ACCESS_TEAM_DOMAIN が未設定のテスト環境では署名は確かめない。 */
const assertion = (payload: Record<string, unknown>) => {
  const part = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${part({ alg: "RS256", kid: "test" })}.${part(payload)}.signature`;
};
const SERVICE = { "cf-access-jwt-assertion": assertion({ common_name: "test-client.access", sub: "" }) };
const BROWSER = { "cf-access-jwt-assertion": assertion({ email: "someone@example.com", sub: "user" }) };

type Json = Record<string, unknown>;
type Result = { kind: string; periodStart: string; status: string; error?: string };

async function ingest(body: unknown, headers: Record<string, string> = SERVICE) {
  const response = await ingestPost(new Request("http://x/api/daily-report-summaries", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { response, body: (await response.json()) as Json & { results: Result[] } };
}

const summary = (title: string, extra = "") => `# ${title}

## 1. 概要
英語学習を中心に進めた。
${extra}
## 2. 主な取り組み
- Ankiで英単語を復習

## 3. 成果・進捗
- 例文を作った

## 4. 得られた知見
- 復習は朝が良い

## 5. 次に向けて
- 続ける
`;

const week = (extra = "") => ({ kind: "week", periodStart: "2026-10-12", periodEnd: "2026-10-18", markdown: summary("週次サマリ 2026-10-12〜2026-10-18", extra) });
const month = { kind: "month", periodStart: "2026-02-01", periodEnd: "2026-02-28", markdown: summary("月次サマリ 2026-02") };

const row = async (kind: string, periodStart: string) =>
  (await env.DB.prepare("SELECT * FROM daily_report_summaries WHERE kind=? AND period_start=?").bind(kind, periodStart).all<Json>()).results?.[0];

describe("POST /api/daily-report-summaries", () => {
  test("creates a week and a month summary as sent", async () => {
    const { response, body } = await ingest({ summaries: [week(), month] });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ created: 2, updated: 0, skipped: 0, errors: 0 });
    expect(body.results).toEqual([
      { kind: "week", periodStart: "2026-10-12", status: "created" },
      { kind: "month", periodStart: "2026-02-01", status: "created" },
    ]);
    const stored = await row("week", "2026-10-12");
    expect(stored).toMatchObject({ period_end: "2026-10-18", markdown: week().markdown });
    expect(stored?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await row("month", "2026-02-01")).toMatchObject({ period_end: "2026-02-28", markdown: month.markdown });
  });

  test("the same content sent again is skipped and writes nothing", async () => {
    const before = await row("week", "2026-10-12");
    const { body } = await ingest({ summaries: [week()] });
    expect(body).toMatchObject({ created: 0, updated: 0, skipped: 1, errors: 0 });
    expect(body.results).toEqual([{ kind: "week", periodStart: "2026-10-12", status: "skipped" }]);
    expect(await row("week", "2026-10-12")).toEqual(before);
  });

  test("changed content is updated in place", async () => {
    const before = await row("week", "2026-10-12");
    const { body } = await ingest({ summaries: [week("書き直した。\n")] });
    expect(body).toMatchObject({ created: 0, updated: 1, skipped: 0, errors: 0 });
    const after = await row("week", "2026-10-12");
    expect(after?.markdown).toBe(week("書き直した。\n").markdown);
    expect(after?.sha256).not.toBe(before?.sha256);
    expect(after?.created_at).toBe(before?.created_at);
    const total = await env.DB.prepare("SELECT COUNT(*) AS c FROM daily_report_summaries WHERE kind='week'").all<{ c: number }>();
    expect(total.results?.[0]?.c).toBe(1);
  });

  test("reports a period that does not fit its kind without failing the others", async () => {
    const { response, body } = await ingest({
      summaries: [
        { ...week(), periodStart: "2026-10-13", periodEnd: "2026-10-19" }, // 火曜始まり
        { ...week(), periodStart: "2026-10-19", periodEnd: "2026-10-24" }, // 6日後ではない
        { ...month, periodStart: "2026-02-02", periodEnd: "2026-02-28" }, // 1日始まりでない
        { ...month, periodEnd: "2026-02-29" }, // 末日でない(実在しない)
        { ...month, kind: "year" },
        { ...month, periodStart: "2026-03-01", periodEnd: "2026-03-31", markdown: "" },
        { ...month, periodStart: "2026-04-01", periodEnd: "2026-04-30", markdown: "x".repeat(64 * 1024 + 1) },
        { kind: "month", periodStart: "2024-02-01", periodEnd: "2024-02-29", markdown: summary("月次サマリ 2024-02") }, // うるう年
      ],
    });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ created: 1, errors: 7 });
    expect(body.results.map((r) => [r.kind, r.periodStart, r.status])).toEqual([
      ["week", "2026-10-13", "error"],
      ["week", "2026-10-19", "error"],
      ["month", "2026-02-02", "error"],
      ["month", "2026-02-01", "error"],
      ["year", "2026-02-01", "error"],
      ["month", "2026-03-01", "error"],
      ["month", "2026-04-01", "error"],
      ["month", "2024-02-01", "created"],
    ]);
    expect(body.results.slice(0, 7).every((r) => typeof r.error === "string" && r.error)).toBe(true);
    expect(await row("week", "2026-10-13")).toBeUndefined();
    expect(await row("month", "2026-02-01")).toMatchObject({ period_end: "2026-02-28" });
  });

  test("rejects a malformed body or too many summaries as a whole", async () => {
    expect((await ingest({})).response.status).toBe(400);
    expect((await ingest({ summaries: [] })).response.status).toBe(400);
    expect((await ingest({ summaries: Array.from({ length: 21 }, () => week()) })).response.status).toBe(400);
  });

  test("only a service token may call it, not a person signed in through the browser", async () => {
    const other = { kind: "week", periodStart: "2026-10-05", periodEnd: "2026-10-11", markdown: summary("週次サマリ") };
    for (const headers of [{}, BROWSER, { "cf-access-jwt-assertion": "not-a-jwt" }]) {
      const { response } = await ingest({ summaries: [other] }, headers);
      expect(response.status).toBe(403);
    }
    expect(await row("week", "2026-10-05")).toBeUndefined();
    const del = await summaryDelete(new Request("http://x/api/daily-report-summaries/week/2026-10-12", { method: "DELETE", headers: BROWSER }), { params: Promise.resolve({ kind: "week", periodStart: "2026-10-12" }) });
    expect(del.status).toBe(403);
    expect(await row("week", "2026-10-12")).toBeDefined();
  });
});

describe("DELETE /api/daily-report-summaries/[kind]/[periodStart]", () => {
  const del = (kind: string, periodStart: string) =>
    summaryDelete(new Request(`http://x/api/daily-report-summaries/${kind}/${periodStart}`, { method: "DELETE", headers: SERVICE }), { params: Promise.resolve({ kind, periodStart }) });

  test("removes only that summary", async () => {
    const response = await del("week", "2026-10-12");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: { kind: "week", periodStart: "2026-10-12" } });
    expect(await row("week", "2026-10-12")).toBeUndefined();
    expect(await row("month", "2026-02-01")).toBeDefined();
    expect((await del("week", "2026-10-12")).status).toBe(404);
    expect((await del("year", "2026-10-12")).status).toBe(400);
    expect((await del("week", "2026-10-13")).status).toBe(400);
    expect((await del("month", "2026-13-01")).status).toBe(400);
  });
});
