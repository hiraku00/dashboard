import { beforeAll, describe, expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { POST as ingestPost } from "@/app/api/daily-reports/route";
import { POST as reparsePost } from "@/app/api/daily-reports/reparse/route";
import { DELETE as reportDelete } from "@/app/api/daily-reports/[date]/route";
import { PARSER_VERSION } from "@/app/lib/daily-report-parse";

// 作業日報の取り込みAPI: 作成 → 同じ内容で skipped → 内容変更で updated と改訂の退避 → reparse → delete と、
// Service Token 以外からの拒否を、実際の(ephemeralな)D1で確かめる。
// 実際の日報は個人的な内容を含むので、書式だけを写した架空の日報を使う。

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
type Result = { date: string; status: string; parseStatus?: string; warnings?: string[]; error?: string };

async function ingest(body: unknown, headers: Record<string, string> = SERVICE) {
  const response = await ingestPost(new Request("http://x/api/daily-reports", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { response, body: (await response.json()) as Json & { results: Result[] } };
}

const report = (date: string, extra = "") => `# 作業日報 ${date.slice(2)}
記録期間: 08:00~10:00(約2時間)
キャプチャ回数: 120回

## 1. 本日のメイン作業
### 1.英語学習
- Ankiで英単語を復習
${extra}
## 2. アプリ使用状況
| アプリ/ツール | 使用回数 | 主な用途 |
|---|---|---|
| Gemini／Anki | 30+ | 英語学習 |

## 3. 作業詳細
| 時間帯 | 作業内容 | 所要時間 |
|---|---|---|
| 08:00～09:00 | Ankiで英語学習 | 1時間 |
| 09:00～09:30 | （ログなし：記録欠落） | 30分 |
| 09:30～10:00 | YouTube視聴 | 30分 |

## 4. 得られた知見・メモ
- 復習は朝が良い
`;

const count = async (table: string, date: string) =>
  Number((await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE report_date=?`).bind(date).all<{ c: number }>()).results?.[0]?.c ?? 0);

describe("POST /api/daily-reports", () => {
  const date = "2026-10-01";

  test("creates the report with its normalized rows and tags", async () => {
    const { response, body } = await ingest({ reports: [{ date, markdown: report(date) }] });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ created: 1, updated: 0, skipped: 0, errors: 0 });
    expect(body.results).toEqual([{ date, status: "created", parseStatus: "ok", warnings: [] }]);

    const row = (await env.DB.prepare("SELECT * FROM daily_reports WHERE report_date=?").bind(date).all<Json>()).results?.[0];
    expect(row).toMatchObject({ record_start: "08:00", record_end: "10:00", recorded_minutes: 120, capture_count: 120, capture_count_is_min: 0, gap_minutes: 30, parser_version: PARSER_VERSION, parse_status: "ok", parse_warnings: "[]" });
    expect(row?.markdown).toBe(report(date));
    expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await count("daily_report_work_items", date)).toBe(1);
    expect(await count("daily_report_app_usage", date)).toBe(1);
    expect(await count("daily_report_time_blocks", date)).toBe(3);
    expect(await count("daily_report_notes", date)).toBe(1);
    const app = (await env.DB.prepare("SELECT app_key, usage_count, usage_is_min FROM daily_report_app_usage WHERE report_date=?").bind(date).all<Json>()).results?.[0];
    expect(app).toEqual({ app_key: "gemini", usage_count: 30, usage_is_min: 1 });
    const tagDays = (await env.DB.prepare("SELECT tag, minutes, work_item_count FROM daily_report_tag_days WHERE report_date=? ORDER BY tag").bind(date).all<Json>()).results;
    // 「ログなし」の30分は数えない
    expect(tagDays).toEqual([{ tag: "english", minutes: 60, work_item_count: 1 }, { tag: "media", minutes: 30, work_item_count: 0 }]);
  });

  test("the same content sent again is skipped and writes nothing", async () => {
    const before = (await env.DB.prepare("SELECT updated_at FROM daily_reports WHERE report_date=?").bind(date).all<{ updated_at: string }>()).results?.[0];
    const { body } = await ingest({ reports: [{ date, markdown: report(date) }] });
    expect(body).toMatchObject({ created: 0, updated: 0, skipped: 1, errors: 0 });
    expect(body.results[0]).toEqual({ date, status: "skipped", parseStatus: "ok", warnings: [] });
    const after = (await env.DB.prepare("SELECT updated_at FROM daily_reports WHERE report_date=?").bind(date).all<{ updated_at: string }>()).results?.[0];
    expect(after).toEqual(before);
    expect(await count("daily_report_revisions", date)).toBe(0);
  });

  test("changed content is updated, keeping the replaced original as a revision", async () => {
    const original = report(date);
    const { body } = await ingest({ reports: [{ date, markdown: report(date, "- 例文を5個作った\n") }] });
    expect(body).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    expect(await count("daily_report_work_items", date)).toBe(2);
    const revisions = (await env.DB.prepare("SELECT revision_number, markdown FROM daily_report_revisions WHERE report_date=?").bind(date).all<Json>()).results;
    expect(revisions).toEqual([{ revision_number: 1, markdown: original }]);

    await ingest({ reports: [{ date, markdown: report(date, "- もう一度直した\n") }] });
    expect(await count("daily_report_revisions", date)).toBe(2);
    expect(await count("daily_report_work_items", date)).toBe(2);
  });

  test("keeps an unreadable report as failed, and reports bad items without failing the others", async () => {
    const { response, body } = await ingest({
      reports: [
        { date: "2026-10-02", markdown: "ただの文章です。" },
        { date: "2026-02-30", markdown: report("2026-02-28") },
        { date: "2026-10-03", markdown: "" },
        { date: "2026-10-04", markdown: "x".repeat(64 * 1024 + 1) },
      ],
    });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ created: 1, errors: 3 });
    expect(body.results.map((r) => [r.date, r.status, r.parseStatus])).toEqual([
      ["2026-10-02", "created", "failed"],
      ["2026-02-30", "error", undefined],
      ["2026-10-03", "error", undefined],
      ["2026-10-04", "error", undefined],
    ]);
    expect(await count("daily_reports", "2026-10-02")).toBe(1);
  });

  test("rejects a malformed body or too many reports as a whole", async () => {
    expect((await ingest({})).response.status).toBe(400);
    expect((await ingest({ reports: [] })).response.status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, markdown: "x" }));
    expect((await ingest({ reports: many })).response.status).toBe(400);
  });

  test("only a service token may call it, not a person signed in through the browser", async () => {
    for (const headers of [{}, BROWSER, { "cf-access-jwt-assertion": "not-a-jwt" }]) {
      const { response } = await ingest({ reports: [{ date: "2026-10-05", markdown: report("2026-10-05") }] }, headers);
      expect(response.status).toBe(403);
    }
    expect(await count("daily_reports", "2026-10-05")).toBe(0);
    expect((await reparsePost(new Request("http://x/api/daily-reports/reparse", { method: "POST", headers: BROWSER }))).status).toBe(403);
    const del = await reportDelete(new Request("http://x/api/daily-reports/2026-10-01", { method: "DELETE", headers: BROWSER }), { params: Promise.resolve({ date: "2026-10-01" }) });
    expect(del.status).toBe(403);
    expect(await count("daily_reports", "2026-10-01")).toBe(1);
  });
});

describe("POST /api/daily-reports/reparse", () => {
  test("re-parses reports parsed by an older version from the stored original", async () => {
    const date = "2026-10-06";
    await ingest({ reports: [{ date, markdown: report(date) }] });
    await env.DB.batch([
      env.DB.prepare("UPDATE daily_reports SET parser_version=0 WHERE report_date=?").bind(date),
      env.DB.prepare("DELETE FROM daily_report_tag_days WHERE report_date=?").bind(date),
    ]);
    const response = await reparsePost(new Request("http://x/api/daily-reports/reparse", { method: "POST", headers: SERVICE }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reparsed: 1, remaining: 0 });
    const row = (await env.DB.prepare("SELECT parser_version FROM daily_reports WHERE report_date=?").bind(date).all<{ parser_version: number }>()).results?.[0];
    expect(row?.parser_version).toBe(PARSER_VERSION);
    expect(await count("daily_report_tag_days", date)).toBe(2);
    expect(await count("daily_report_revisions", date)).toBe(0);

    const again = await reparsePost(new Request("http://x/api/daily-reports/reparse", { method: "POST", headers: SERVICE }));
    expect(await again.json()).toEqual({ reparsed: 0, remaining: 0 });
  });
});

describe("DELETE /api/daily-reports/[date]", () => {
  const del = (date: string) => reportDelete(new Request(`http://x/api/daily-reports/${date}`, { method: "DELETE", headers: SERVICE }), { params: Promise.resolve({ date }) });

  test("removes the report and every derived row, revisions included", async () => {
    const date = "2026-10-01";
    const response = await del(date);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: date });
    for (const table of ["daily_reports", "daily_report_revisions", "daily_report_work_items", "daily_report_app_usage", "daily_report_time_blocks", "daily_report_notes", "daily_report_item_tags", "daily_report_tag_days"]) {
      expect(await count(table, date)).toBe(0);
    }
    expect((await del(date)).status).toBe(404);
    expect((await del("2026-13-01")).status).toBe(400);
  });
});
