import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ensureSchema } from "@/db";
import { portalSummary } from "@/app/lib/queries/portal";
import { assetState } from "@/app/lib/queries/manage-asset";
import { latestFx, total as manageAssetTotal } from "@/app/lib/manage-asset-core";

// portalSummary() feeds the home page and /api/portal/summary. The first block
// pins what it returns (counts, per-source latest snapshot). The asset totals use
// Manage Asset's own definition -- see app/lib/portal-summary.ts -- and the last
// blocks check that directly: the home page must show the same numbers as the
// Manage Asset overview computed from the same data.

const T0 = "2026-01-01T00:00:00.000Z";

async function run(sql: string, ...binds: unknown[]) {
  await env.DB.prepare(sql).bind(...binds).run();
}

async function snapshot(id: string, sourceId: string, asOf: string, capturedAt: string, usd: number, jpy: number, positions: Array<[number, number]> = [], fx: number | null = null) {
  await run("INSERT INTO asset_snapshots (id, run_id, source_id, captured_at, as_of_date, total_usd, total_jpy, fx_usdjpy) VALUES (?, 'run-1', ?, ?, ?, ?, ?, ?)", id, sourceId, capturedAt, asOf, usd, jpy, fx);
  for (const [i, [pUsd, pJpy]] of positions.entries()) {
    await run("INSERT INTO asset_positions (id, snapshot_id, symbol, value_usd, value_jpy) VALUES (?, ?, 'X', ?, ?)", `${id}-p${i}`, id, pUsd, pJpy);
  }
}

beforeAll(async () => {
  await ensureSchema({ seed: false });

  // Watch List: 3 live items (2 completed) and one deleted (must not count).
  for (const [id, status, deleted] of [["w1", "completed", null], ["w2", "completed", null], ["w3", "backlog", null], ["w4", "completed", T0]] as const) {
    await run("INSERT INTO items (id, content_type, title, status, deleted_at, created_at, updated_at) VALUES (?, 'text', ?, ?, ?, ?, ?)", id, id, status, deleted, T0, T0);
  }
  // TextTube: latest live video by created_at; a newer deleted one is ignored.
  for (const [id, created, deleted] of [["v-old", "2026-03-01T00:00:00Z", null], ["v-new", "2026-04-01T00:00:00Z", null], ["v-deleted", "2026-05-01T00:00:00Z", T0]] as const) {
    await run("INSERT INTO text_tube_videos (id, title, channel_name, created_at, updated_at, deleted_at) VALUES (?, ?, 'ch', ?, ?, ?)", id, `title ${id}`, created, created, deleted);
  }
  // To Do: today's tasks (3, one completed); a deleted one and another day's are ignored.
  const today = "strftime('%Y-%m-%d','now','+7 hours')";
  const task = (id: string, date: string, completed: string | null, deleted: string | null) =>
    env.DB.prepare(`INSERT INTO todo_tasks (id, board_id, column_id, title, occurrence_date, position, completed_at, deleted_at, created_at, updated_at) VALUES (?, 'b', 'c', ?, ${date}, 1, ?, ?, ?, ?)`).bind(id, id, completed, deleted, T0, T0).run();
  await task("t1", today, null, null);
  await task("t2", today, null, null);
  await task("t3", today, T0, null);
  await task("t4", today, null, T0);
  await task("t5", "'2000-01-01'", null, null);

  // Assets: one sync run, 4 sources (D disabled).
  await run("INSERT INTO asset_sync_runs (id, client_run_id, started_at, status, received_at) VALUES ('run-1', 'run-1', ?, 'ok', ?)", T0, T0);
  for (const [id, enabled] of [["A", 1], ["B", 1], ["C", 1], ["D", 0]] as const) {
    await run("INSERT INTO asset_sources (id, source_type, provider, display_name, enabled, created_at) VALUES (?, 'wallet', 'p', ?, ?, ?)", id, id, enabled, T0);
  }
  // A: newest date wins (200), the older 100 is ignored. Its rate (150) is the newest of all snapshots.
  await snapshot("A-old", "A", "2026-09-01", "2026-09-01T02:00:00Z", 100, 15000, [], 140);
  await snapshot("A-new", "A", "2026-09-10", "2026-09-10T02:00:00Z", 200, 30000, [], 150);
  // B: the newest snapshot's stored totals are 0 (DeBank rounds a tiny wallet to $0). Its positions (30+20 USD)
  // are NOT added in: the stored total is the declared total, as in Manage Asset. An older snapshot with a big
  // total must not be used either.
  await snapshot("B-old", "B", "2026-09-02", "2026-09-02T02:00:00Z", 999, 999);
  await snapshot("B-new", "B", "2026-09-05", "2026-09-05T02:00:00Z", 0, 0, [[30, 4500], [20, 3000]]);
  // C and D carry rates too (151, 152) but were captured earlier than A's, so they do not set the rate.
  await snapshot("C-new", "C", "2026-09-06", "2026-09-06T02:00:00Z", 10, 0, [[999, 1500]], 151);
  // D is disabled but its snapshot still counts today (the query never filtered on enabled).
  await snapshot("D-new", "D", "2026-09-07", "2026-09-07T02:00:00Z", 5, 750, [], 152);
});

describe("portalSummary (behaviour that must not change)", () => {
  test("counts, latest video, source count and today's tasks", async () => {
    const summary = await portalSummary();
    expect(summary.watch).toEqual({ total: 3, completed: 2 });
    expect(summary.textTube.total).toBe(2);
    expect(summary.textTube.latest).toEqual({ id: "v-new", title: "title v-new", channel_name: "ch" });
    expect(summary.assets.sourceCount).toBe(3);
    expect(summary.todo).toEqual({ total: 3, completed: 1 });
  });

  test("asset totals: each source's newest stored total, JPY at the newest snapshot's single rate", async () => {
    const { assets } = await portalSummary();
    // USD: A 200 + B 0 (positions ignored) + C 10 + D 5
    expect(assets.totalUsd).toBe(215);
    // JPY: 215 x 150, the rate of the newest snapshot (A). Summing each snapshot's own JPY would give 30750.
    expect(assets.totalJpy).toBe(215 * 150);
  });

  test("latestAt is the newest capture across all snapshots", async () => {
    expect((await portalSummary()).assets.latestAt).toBe("2026-09-10T02:00:00Z");
  });
});

describe("portalSummary reads", () => {
  test("goes to D1 with one batch and no separate queries", async () => {
    await portalSummary(); // settle the one-time schema check
    const batch = vi.spyOn(env.DB, "batch");
    const prepare = vi.spyOn(env.DB, "prepare");
    await portalSummary();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(batch.mock.calls[0][0].length);
    vi.restoreAllMocks();
  });
});

describe("portalSummary and Manage Asset pick the same snapshot", () => {
  test("when a source's dates and capture times disagree, the newest as_of_date wins (as in assetState)", async () => {
    const before = await portalSummary();
    // E: the older DATE was captured LATER (a re-sync of an old day). Picking by captured_at
    // would take the 1-USD row; picking by as_of_date takes the 700-USD one.
    await run("INSERT INTO asset_sources (id, source_type, provider, display_name, enabled, created_at) VALUES ('E', 'wallet', 'p', 'E', 1, ?)", T0);
    await snapshot("E-older-date", "E", "2026-09-01", "2026-09-20T09:00:00Z", 1, 1);
    await snapshot("E-newer-date", "E", "2026-09-08", "2026-09-08T02:00:00Z", 700, 70000);
    const after = await portalSummary();
    expect(after.assets.totalUsd - before.assets.totalUsd).toBe(700);
    expect(after.assets.totalJpy - before.assets.totalJpy).toBe(700 * 150); // E carries no rate, so 150 stays the newest

    const state = await assetState();
    const e = state.snapshots.find((row) => (row as { wallet_id?: unknown }).wallet_id === "E") as Record<string, unknown> | undefined;
    expect(e).toBeTruthy();
    expect(JSON.stringify(e)).toContain("2026-09-08");
  });
});

describe("the home page shows Manage Asset's numbers", () => {
  test("total USD and JPY equal what the Manage Asset overview computes from the same snapshots", async () => {
    const summary = await portalSummary();
    const state = await assetState();
    const usd = manageAssetTotal(state.snapshots as never[], state.exchange_snapshots as never[]);
    const fx = latestFx(state.snapshots as never[], state.exchange_snapshots as never[]);
    expect(usd).toBeGreaterThan(0);
    expect(fx).not.toBeNull();
    // Exactly what manage-asset-overview.tsx renders: total, and total * rate as the JPY line.
    expect(summary.assets.totalUsd).toBe(usd);
    expect(summary.assets.totalJpy).toBe(usd * fx!.rate);
  });
});
