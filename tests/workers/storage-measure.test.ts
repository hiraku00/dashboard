import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { POST as measurePost } from "@/app/api/settings/storage/measure/route";
import { measuredToday } from "@/app/lib/d1-table-usage";
import { todoDate } from "@/app/lib/todo-date";

// 使用量画面の「今日の分を計測」ボタンの API。全テーブルを全件読むので、今日(バンコク時間)の分が無いときだけ測り、
// 押し直しても2回目は測らない(409)。

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

describe("POST /api/settings/storage/measure", () => {
  test("measures once per Bangkok day, then refuses", async () => {
    expect(await measuredToday(env.DB)).toBe(false);

    const first = await measurePost();
    expect(first.status).toBe(200);
    const body = (await first.json()) as { measured: boolean; date: string; tables: number };
    expect(body).toMatchObject({ measured: true, date: todoDate() });
    expect(body.tables).toBeGreaterThan(0);
    expect(await measuredToday(env.DB)).toBe(true);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS c FROM d1_table_usage_daily WHERE usage_date = ?").bind(todoDate()).first<{ c: number }>();
    expect(Number(rows?.c)).toBe(body.tables);

    const second = await measurePost();
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ measured: false });
  });
});
