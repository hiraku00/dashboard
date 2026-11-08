import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { ensureSchema, ensureWallet2Schema } from "@/db";
import { POST as measurePost } from "@/app/api/settings/storage/measure/route";
import { measureD1Tables, measuredToday } from "@/app/lib/d1-table-usage";
import { todoDate } from "@/app/lib/todo-date";

// 使用量画面の「今日の分を計測」ボタンの API。全テーブルを全件読むので、今日(バンコク時間)の分が無いときだけ測り、
// 押し直しても2回目は測らない(409)。ウォレット2(Manage Asset のダミーデータ、別の D1)の資産テーブルも一緒に測る。

beforeAll(async () => {
  await ensureSchema({ seed: false });
  await ensureWallet2Schema();
});

describe("POST /api/settings/storage/measure", () => {
  test("measures once per Bangkok day, then refuses", async () => {
    expect(await measuredToday(env.DB)).toBe(false);
    // A day measured before wallet 2 was added (production only) can be measured again.
    await measureD1Tables(env.DB);
    expect(await measuredToday(env.DB)).toBe(false);

    const first = await measurePost();
    expect(first.status).toBe(200);
    const body = (await first.json()) as { measured: boolean; date: string; tables: number };
    expect(body).toMatchObject({ measured: true, date: todoDate() });
    expect(body.tables).toBeGreaterThan(0);
    expect(await measuredToday(env.DB)).toBe(true);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS c FROM d1_table_usage_daily WHERE usage_date = ?").bind(todoDate()).first<{ c: number }>();
    expect(Number(rows?.c)).toBe(body.tables);
    // Wallet 2's asset tables (and only those) are recorded in production's table, with the wallet2. prefix.
    const wallet2 = (await env.DB.prepare("SELECT table_name FROM d1_table_usage_daily WHERE usage_date = ? AND table_name LIKE 'wallet2.%' ORDER BY table_name").bind(todoDate()).all<{ table_name: string }>()).results.map((row) => row.table_name);
    expect(wallet2).toEqual(["wallet2.asset_fx_rates", "wallet2.asset_history_records", "wallet2.asset_lido_rewards", "wallet2.asset_positions", "wallet2.asset_snapshots", "wallet2.asset_sources", "wallet2.asset_sync_runs"]);

    const second = await measurePost();
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ measured: false });
  });
});
