import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ensureSchema } from "@/db";
import { d1BackedUsage } from "@/app/lib/queries/storage-usage";
import { currentStorageBytes } from "@/app/lib/portal";

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
        { category: "manage-asset/raw", count: 2, bytes: 3000 },
        { category: "text-tube/videos", count: 1, bytes: 500 },
      ],
      latest: { usage_date: "2026-09-20", object_count: 3, payload_bytes: 3600, class_a_estimate: 6, class_b_estimate: 7, source: "ledger", updated_at: T0 },
      databaseRecords: { watchList: 2, manageAsset: 2, textTube: 1 },
      transcriptUsage: { credits: 5, attempts: 2, lastUsedAt: "2026-09-15T05:00:00Z" },
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
    expect(usage.databaseRecords).toEqual({ watchList: 0, manageAsset: 0, textTube: 0 });
    expect(usage.transcriptUsage).toEqual({ credits: 0, attempts: 0, lastUsedAt: null });
  });
});
