import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ensureSchema } from "@/db";
import { assetHistory, assetState } from "@/app/lib/queries/manage-asset";
import { referenceAssetHistory, referenceAssetState } from "./fixtures/manage-asset-reference";

// assetState() and assetHistory() feed /manage-asset (through the page and the
// API routes). Their reads are regrouped into fewer D1 round trips, which must
// not change a single value on screen. So every case below runs the real
// function beside referenceAssetState/History (the one-query-at-a-time versions,
// see fixtures/manage-asset-reference.ts) on the same data and demands deep
// equality -- plus a few hand-checked facts, so equality cannot be vacuous.

const T0 = "2026-01-01T00:00:00.000Z";
const run = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).run();

async function snapshot(id: string, sourceId: string, asOf: string, capturedAt: string, runId: string, usd: number, jpy: number, positions: Array<{ symbol: string; qty: number; usd: number; debt?: number; protocol?: string }>) {
  await run("INSERT INTO asset_snapshots (id, run_id, source_id, captured_at, as_of_date, total_usd, total_jpy, fx_usdjpy) VALUES (?, ?, ?, ?, ?, ?, ?, 150)", id, runId, sourceId, capturedAt, asOf, usd, jpy);
  for (const [i, p] of positions.entries()) {
    await run("INSERT INTO asset_positions (id, snapshot_id, symbol, quantity, value_usd, value_jpy, is_debt, protocol) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", `${id}-p${i}`, id, p.symbol, p.qty, p.usd, p.usd * 150, p.debt ?? 0, p.protocol ?? "");
  }
}

async function legacyRecord(id: string, type: "wallet" | "exchange", sourceId: string, asOf: string, capturedAt: string, payload: Record<string, unknown>) {
  await run("INSERT INTO asset_history_records (id, record_type, source_id, as_of_date, captured_at, total_usd, total_jpy, payload_json) VALUES (?, ?, ?, ?, ?, 1, 1, ?)", id, type, sourceId, asOf, capturedAt, JSON.stringify(payload));
}

async function seed() {
  await run("INSERT INTO asset_sync_runs (id, client_run_id, started_at, status, received_at) VALUES ('run-a', 'run-a', ?, 'ok', '2026-09-01T10:00:00Z')", T0);
  await run("INSERT INTO asset_sync_runs (id, client_run_id, started_at, status, received_at) VALUES ('run-b', 'run-b', ?, 'ok', '2026-09-10T10:00:00Z')", T0);
  for (const [id, type, name, addr, enabled] of [["W1", "wallet", "Wallet One", "0xw1", 1], ["W2", "wallet", "Wallet Two", "0xw2", 1], ["X1", "exchange", "Exchange One", "", 1], ["W3", "wallet", "Wallet Three", "0xw3", 0]] as const) {
    await run("INSERT INTO asset_sources (id, source_type, provider, display_name, public_address, enabled, created_at) VALUES (?, ?, 'p', ?, ?, ?, ?)", id, type, name, addr, enabled, T0);
  }
  // Normalized snapshots. Latest date is 2026-09-10, so a 90-day window starts 2026-06-13.
  await snapshot("W1-0501", "W1", "2026-05-01", "2026-05-01T02:00:00Z", "run-a", 50, 7500, [{ symbol: "ETH", qty: 1, usd: 50 }]);
  await snapshot("W1-0705", "W1", "2026-07-05", "2026-07-05T02:00:00Z", "run-a", 80, 12000, [{ symbol: "ETH", qty: 1.5, usd: 60 }, { symbol: "USDC", qty: 20, usd: 20 }]);
  await snapshot("W1-0901", "W1", "2026-09-01", "2026-09-01T02:00:00Z", "run-a", 90, 13500, [{ symbol: "ETH", qty: 2, usd: 90 }]);
  await snapshot("W1-0910", "W1", "2026-09-10", "2026-09-10T02:00:00Z", "run-b", 100, 15000, [{ symbol: "ETH", qty: 2, usd: 70 }, { symbol: "stETH", qty: 1, usd: 30 }]);
  await snapshot("W2-0905", "W2", "2026-09-05", "2026-09-05T02:00:00Z", "run-a", 30, 4500, [{ symbol: "BTC", qty: 0.001, usd: 30 }]);
  await snapshot("W2-0910", "W2", "2026-09-10", "2026-09-10T03:00:00Z", "run-b", 35, 5250, [{ symbol: "BTC", qty: 0.001, usd: 35 }, { symbol: "DAI", qty: 5, usd: 5 }]);
  await snapshot("X1-0908", "X1", "2026-09-08", "2026-09-08T02:00:00Z", "run-a", 200, 30000, [{ symbol: "BTC", qty: 1, usd: 250, protocol: "spot" }, { symbol: "JPY", qty: -50, usd: -50, debt: 1, protocol: "margin" }]);
  await snapshot("X1-0910", "X1", "2026-09-10", "2026-09-10T02:30:00Z", "run-b", 210, 31500, [{ symbol: "BTC", qty: 1, usd: 260, protocol: "spot" }, { symbol: "JPY", qty: -50, usd: -50, debt: 1, protocol: "margin" }]);
  await snapshot("W3-0902", "W3", "2026-09-02", "2026-09-02T02:00:00Z", "run-a", 9, 1350, []); // disabled source, no positions

  // Legacy history rows (already in the frontend's shape).
  const wallet = (id: string, asOf: string, capturedAt: string, usd: number) => ({ wallet_id: id, wallet_name: id, as_of_date: asOf, captured_at: capturedAt, total_usd: usd, tokens: [{ symbol: "ETH", usd_value: usd }] });
  const exchange = (asOf: string, capturedAt: string, usd: number) => ({ source_id: "X1", account_name: "Exchange One", as_of_date: asOf, captured_at: capturedAt, totals: { net_asset_usd: usd }, positions: [] });
  // Same wallet+date as normalized W1-0705, captured EARLIER and with no sync_received_at: the normalized row is newer, so it must win.
  await legacyRecord("L1", "wallet", "W1", "2026-07-05", "2026-07-05T01:00:00Z", wallet("W1", "2026-07-05", "2026-07-05T01:00:00Z", 999));
  // Same wallet+date as normalized W2-0905 and captured LATER. A normalized row carries a sync time and a legacy one does not, and the
  // sync time is compared first -- so the normalized row still wins even though the legacy one was captured later.
  await legacyRecord("L2", "wallet", "W2", "2026-09-05", "2026-09-05T23:00:00Z", wallet("W2", "2026-09-05", "2026-09-05T23:00:00Z", 777));
  // Legacy-only rows: one inside the 90-day window, one long before it.
  await legacyRecord("L3", "wallet", "W2", "2026-08-15", "2026-08-15T02:00:00Z", wallet("W2", "2026-08-15", "2026-08-15T02:00:00Z", 25));
  // Two legacy rows for the same wallet+date (neither has a sync time): the later capture wins.
  await legacyRecord("L6", "wallet", "W2", "2026-08-15", "2026-08-15T09:00:00Z", wallet("W2", "2026-08-15", "2026-08-15T09:00:00Z", 26));
  await legacyRecord("L4", "wallet", "W1", "2026-04-01", "2026-04-01T02:00:00Z", wallet("W1", "2026-04-01", "2026-04-01T02:00:00Z", 40));
  await legacyRecord("L5", "exchange", "X1", "2026-08-20", "2026-08-20T02:00:00Z", exchange("2026-08-20", "2026-08-20T02:00:00Z", 180));
}

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

const WINDOWS = [null, "all", "7", "30", "90", "0", "abc"] as const;

describe("with no data at all", () => {
  test("assetState is identical to the reference and empty", async () => {
    const state = await assetState();
    expect(state).toEqual(await referenceAssetState());
    expect(state.snapshots).toEqual([]);
    expect(state.sources).toEqual([]);
  });

  test.each(WINDOWS)("assetHistory(%s) is identical to the reference and empty", async (days) => {
    const history = await assetHistory(days);
    expect(history).toEqual(await referenceAssetHistory(days));
    expect(history).toEqual({ snapshots: [], exchange_snapshots: [] });
  });
});

describe("with seeded data", () => {
  beforeAll(seed);

  test("assetState is identical to the reference", async () => {
    const state = await assetState();
    expect(state).toEqual(await referenceAssetState());
    // Hand-checked so equality is not vacuous: newest snapshot per source, positions attached, disabled source's snapshot still listed.
    const ids = state.snapshots.map((row) => (row as { wallet_id: string }).wallet_id).sort();
    expect(ids).toEqual(["W1", "W2", "W3"]);
    const w1 = state.snapshots.find((row) => (row as { wallet_id: string }).wallet_id === "W1") as { as_of_date: string; tokens: unknown[] };
    expect(w1.as_of_date).toBe("2026-09-10");
    expect(w1.tokens).toHaveLength(2);
    expect(state.exchange_snapshots).toHaveLength(1);
    expect(state.sources.map((source) => (source as { id: string }).id)).toEqual(["X1"]); // enabled exchange sources only
  });

  test.each(WINDOWS)("assetHistory(%s) is identical to the reference", async (days) => {
    expect(await assetHistory(days)).toEqual(await referenceAssetHistory(days));
  });

  test("the merge behaves as designed (so the equality above compares something real)", async () => {
    const full = await assetHistory("all");
    const wallet = (id: string, date: string) => full.snapshots.find((row) => (row as { wallet_id: string; as_of_date: string }).wallet_id === id && (row as { as_of_date: string }).as_of_date.startsWith(date)) as { total_usd: number } | undefined;
    expect(wallet("W1", "2026-07-05")?.total_usd).toBe(80); // normalized (newer) beats the legacy 999
    expect(wallet("W2", "2026-09-05")?.total_usd).toBe(30); // normalized (has a sync time) beats the legacy 777 captured later
    expect(wallet("W2", "2026-08-15")?.total_usd).toBe(26); // of two legacy rows, the later capture wins (25 loses)
    expect(wallet("W1", "2026-04-01")?.total_usd).toBe(40); // legacy-only row from before the window is in "all"
    expect(full.exchange_snapshots.map((row) => (row as { as_of_date: string }).as_of_date)).toEqual(["2026-08-20", "2026-09-08", "2026-09-10"]);

    const ninety = await assetHistory("90");
    expect(wallet("W1", "2026-04-01")).toBeDefined();
    expect(ninety.snapshots.some((row) => (row as { as_of_date: string }).as_of_date.startsWith("2026-04-01"))).toBe(false); // before the window
    expect(ninety.snapshots.some((row) => (row as { as_of_date: string }).as_of_date.startsWith("2026-05-01"))).toBe(false); // before the window
    const seven = await assetHistory("7");
    expect(seven.snapshots.every((row) => (row as { as_of_date: string }).as_of_date >= "2026-09-04")).toBe(true);
  });
});

describe("round trips to D1", () => {
  test("assetHistory reads its three tables in one batch, after only the window lookup", async () => {
    await assetHistory("90"); // settle the one-time schema check
    const batch = vi.spyOn(env.DB, "batch");
    const prepare = vi.spyOn(env.DB, "prepare");
    await assetHistory("90");
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(3);
    expect(prepare).toHaveBeenCalledTimes(4); // the window lookup + the three
    prepare.mockClear(); batch.mockClear();
    await assetHistory("all"); // no window to look up
    expect(batch).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });

  test("assetState reads sources and latest snapshots together, then the positions", async () => {
    await assetState();
    const batch = vi.spyOn(env.DB, "batch");
    const prepare = vi.spyOn(env.DB, "prepare");
    await assetState();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(2);
    expect(prepare).toHaveBeenCalledTimes(3); // sources + snapshots (batched) and the positions that depend on them
    vi.restoreAllMocks();
  });
});
