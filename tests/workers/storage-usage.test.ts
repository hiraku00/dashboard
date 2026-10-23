import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ensureSchema } from "@/db";
import { d1BackedUsage } from "@/app/lib/queries/storage-usage";
import { measureD1Tables } from "@/app/lib/d1-table-usage";
import { currentStorageBytes } from "@/app/lib/r2-storage";

// d1BackedUsage() is the D1 half of /settings/storage. The first block pins its
// whole result so its queries can be regrouped into fewer round trips without
// changing a number on the page. The last block pins the behaviour #35 added:
// when D1 fails the page must still render, so it returns { ok: false } with
// empty records instead of throwing.

const T0 = "2026-01-01T00:00:00.000Z";
const run = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).run();

beforeAll(async () => {
  await ensureSchema({ seed: false });
  // R2 objects: 3 live in two categories, 1 deleted (must not count).
  for (const [key, category, size, deleted] of [["k1", "manage-asset/raw", 1000, null], ["k2", "manage-asset/raw", 2000, null], ["k3", "text-tube/videos", 500, null], ["k4", "text-tube/videos", 9999, T0]] as const) {
    await run("INSERT INTO storage_objects (object_key, category, size_bytes, sha256, content_type, created_at, deleted_at) VALUES (?, ?, ?, 'sha', 'text/plain', ?, ?)", key, category, size, T0, deleted);
  }
  await run("INSERT INTO storage_usage_daily (usage_date, object_count, payload_bytes, class_a_estimate, class_b_estimate, source, updated_at) VALUES ('2026-09-19', 3, 3500, 4, 5, 'ledger', ?)", T0);
  await run("INSERT INTO storage_usage_daily (usage_date, object_count, payload_bytes, class_a_estimate, class_b_estimate, source, updated_at) VALUES ('2026-09-20', 3, 3600, 6, 7, 'ledger', ?)", T0);
  // Record counts: 2 live items (+1 deleted), 2 snapshots, 1 live video (+1 deleted).
  for (const [id, deleted] of [["i1", null], ["i2", null], ["i3", T0]] as const) {
    await run("INSERT INTO items (id, content_type, title, deleted_at, created_at, updated_at) VALUES (?, 'text', ?, ?, ?, ?)", id, id, deleted, T0, T0);
  }
  await run("INSERT INTO asset_sync_runs (id, client_run_id, started_at, status, received_at) VALUES ('r', 'r', ?, 'ok', ?)", T0, T0);
  await run("INSERT INTO asset_sources (id, source_type, provider, display_name, created_at) VALUES ('s', 'wallet', 'p', 's', ?)", T0);
  for (const d of ["2026-09-01", "2026-09-02"]) await run("INSERT INTO asset_snapshots (id, run_id, source_id, captured_at, as_of_date) VALUES (?, 'r', 's', ?, ?)", `snap-${d}`, T0, d);
  for (const [id, deleted] of [["v1", null], ["v2", T0]] as const) {
    await run("INSERT INTO text_tube_videos (id, title, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)", id, id, T0, T0, deleted);
  }
  // Transcript API usage: this month's supadata rows count; another provider and another month do not.
  for (const [id, provider, credits, created] of [["u1", "supadata", 3, "2026-09-02T01:00:00Z"], ["u2", "supadata", 2, "2026-09-15T05:00:00Z"], ["u3", "other", 50, "2026-09-10T00:00:00Z"], ["u4", "supadata", 40, "2026-08-31T23:00:00Z"]] as const) {
    await run("INSERT INTO text_tube_api_usage (id, provider, operation, http_status, credits, created_at) VALUES (?, ?, 'op', 200, ?, ?)", id, provider, credits, created);
  }
});

describe("d1BackedUsage (result that must not change)", () => {
  test("returns the full usage picture for the month", async () => {
    const usage = await d1BackedUsage("2026-09");
    expect(usage).toEqual({
      ok: true,
      error: null,
      usage: { bytes: 3500, count: 3 },
      categories: [
        { category: "manage-asset/raw", count: 2, bytes: 3000, bytes_30d_ago: 3000 },
        { category: "text-tube/videos", count: 1, bytes: 500, bytes_30d_ago: 500 },
      ],
      latest: { usage_date: "2026-09-20", object_count: 3, payload_bytes: 3600, class_a_estimate: 6, class_b_estimate: 7, source: "ledger", updated_at: T0 },
      databaseRecords: { watchList: 2, manageAsset: 2, textTube: 1, openchatNotes: 0, openchatComments: 0, todoTasks: 0, dailyReports: 0 },
      transcriptUsage: { credits: 5, attempts: 2, lastUsedAt: "2026-09-15T05:00:00Z" },
      // 容量の計測がまだ1回も無い
      tableUsage: { date: null, baseDate: null, days: 0, totalBytes: 0, baseTotalBytes: null, groups: [] },
    });
  });

  test("a month with no transcript calls reports zero credits", async () => {
    const usage = await d1BackedUsage("2020-01");
    expect(usage.transcriptUsage).toEqual({ credits: 0, attempts: 0, lastUsedAt: null });
    expect(usage.usage).toEqual({ bytes: 3500, count: 3 });
  });

  test("currentStorageBytes (also used by uploads and the sync route) still agrees", async () => {
    expect(await currentStorageBytes()).toEqual({ bytes: 3500, count: 3 });
  });
});

describe("d1BackedUsage reads", () => {
  test("goes to D1 with one batch and nothing else", async () => {
    await d1BackedUsage("2026-09"); // settle the one-time schema check
    const batch = vi.spyOn(env.DB, "batch");
    const prepare = vi.spyOn(env.DB, "prepare");
    await d1BackedUsage("2026-09");
    expect(batch).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(batch.mock.calls[0][0].length);
    vi.restoreAllMocks();
  });
});

describe("measureD1Tables (1日1回の容量の計測)", () => {
  test("records every app table with its row count and the summed value lengths, and the page reads them grouped", async () => {
    const first = await measureD1Tables(env.DB, new Date("2026-09-23T02:17:00Z"));
    const names = first.tables.map((table) => table.tableName);
    expect(names).toContain("items");
    expect(names).toContain("daily_reports");
    expect(names).toContain("d1_table_usage_daily");
    expect(names.some((name) => name.startsWith("sqlite_") || name.startsWith("_cf_") || name === "d1_migrations")).toBe(false);
    const items = first.tables.find((table) => table.tableName === "items")!;
    // 削除済みの行も容量を使っているので数える(件数の表示とは別)
    expect(items.rowCount).toBe(3);
    expect(items.payloadBytes).toBeGreaterThan(0);
    const stored = await env.DB.prepare("SELECT COUNT(*) AS c FROM d1_table_usage_daily WHERE usage_date='2026-09-23'").first<{ c: number }>();
    expect(Number(stored?.c)).toBe(names.length);

    // 30日後にもう一度。同じ日に測り直すと上書き(重複しない)
    await run("INSERT INTO items (id, content_type, title, created_at, updated_at) VALUES ('i4', 'text', 'a longer title for growth', ?, ?)", T0, T0);
    await measureD1Tables(env.DB, new Date("2026-10-23T02:17:00Z"));
    await measureD1Tables(env.DB, new Date("2026-10-23T09:00:00Z"));
    const latest = await env.DB.prepare("SELECT COUNT(*) AS c FROM d1_table_usage_daily WHERE usage_date='2026-10-23'").first<{ c: number }>();
    expect(Number(latest?.c)).toBe(names.length);

    const usage = await d1BackedUsage("2026-10");
    expect(usage.tableUsage).toMatchObject({ date: "2026-10-23", baseDate: "2026-09-23", days: 30 });
    const watchList = usage.tableUsage.groups.find((group) => group.key === "watchList")!;
    expect(watchList.bytes).toBeGreaterThan(watchList.baseBytes ?? Infinity);
    expect(watchList.tables.find((table) => table.name === "items")?.rows).toBe(4);
  });
});

describe("R2 のカテゴリごとの30日前の容量", () => {
  test("is read from the ledger: files added within 30 days are not counted, files deleted within 30 days still are", async () => {
    // 2026-10-20 に Manage Asset の原本を1つ追加、2026-10-21 に k1(1000)を削除
    await run("INSERT INTO storage_objects (object_key, category, size_bytes, sha256, content_type, created_at) VALUES ('k5', 'manage-asset/raw', 700, 'sha', 'text/plain', '2026-10-20T00:00:00.000Z')");
    await run("UPDATE storage_objects SET deleted_at='2026-10-21T00:00:00.000Z' WHERE object_key='k1'");
    const usage = await d1BackedUsage("2026-10", new Date("2026-10-23T00:00:00.000Z"));
    const raw = usage.categories.find((row) => row.category === "manage-asset/raw");
    // 今: k2(2000)+k5(700)。30日前(9/23): k1(1000)+k2(2000)
    expect(raw).toEqual({ category: "manage-asset/raw", count: 2, bytes: 2700, bytes_30d_ago: 3000 });
    await run("DELETE FROM storage_objects WHERE object_key='k5'");
    await run("UPDATE storage_objects SET deleted_at=NULL WHERE object_key='k1'");
  });
});

describe("d1BackedUsage when D1 fails (#35)", () => {
  test("returns ok:false with empty records instead of throwing", async () => {
    // Any one of its queries failing must degrade the whole result the same way.
    await run("DROP TABLE storage_usage_daily");
    const usage = await d1BackedUsage("2026-09");
    expect(usage.ok).toBe(false);
    expect(typeof usage.error).toBe("string");
    expect(usage.error).toBeTruthy();
    expect(usage.usage).toEqual({ bytes: 0, count: 0 });
    expect(usage.categories).toEqual([]);
    expect(usage.latest).toBeNull();
    expect(usage.databaseRecords).toEqual({ watchList: 0, manageAsset: 0, textTube: 0, openchatNotes: 0, openchatComments: 0, todoTasks: 0, dailyReports: 0 });
    expect(usage.transcriptUsage).toEqual({ credits: 0, attempts: 0, lastUsedAt: null });
    expect(usage.tableUsage.date).toBeNull();
  });
});
