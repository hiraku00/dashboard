import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { toLegacyExchangeSnapshot, toLegacyWalletSnapshot } from "@/app/lib/manage-asset-legacy";
import { route } from "@/app/lib/route";

export const GET = route(async () => {
  await ensureSchema({ seed: false });
  const sources = (await env.DB.prepare("SELECT * FROM asset_sources WHERE enabled=1 ORDER BY display_name").all<Record<string, unknown>>()).results ?? [];
  // "Latest snapshot per source". This was a ROW_NUMBER() pass, which had to
  // read and rank every snapshot ever taken -- 4,200 rows to return 17. Since
  // asset_snapshots gained UNIQUE(source_id, as_of_date) there is exactly one
  // row per source and date, so the newest date per source identifies it
  // uniquely and the grouping can use asset_snapshots_source_date_idx instead
  // of scanning. Verified against production data: both forms select the same
  // 17 snapshot ids, with no row in one and not the other.
  const snapshotRows = (await env.DB.prepare(`SELECT s.*, a.source_type, a.display_name, a.provider, a.public_address
    FROM asset_snapshots s
    JOIN (SELECT source_id, MAX(as_of_date) AS as_of_date FROM asset_snapshots GROUP BY source_id) latest
      ON latest.source_id = s.source_id AND latest.as_of_date = s.as_of_date
    JOIN asset_sources a ON a.id = s.source_id
    ORDER BY s.total_usd DESC`).all<Record<string, unknown>>()).results ?? [];
  // Reuse the snapshot ids already resolved above instead of re-running the
  // same "latest per source" lookup a second time for positions.
  const latestSnapshotIds = snapshotRows.map((row) => String(row.id ?? "")).filter(Boolean);
  const positions = latestSnapshotIds.length
    ? (await env.DB.prepare(`SELECT p.*, a.display_name, a.provider FROM asset_positions p JOIN asset_snapshots s ON s.id=p.snapshot_id JOIN asset_sources a ON a.id=s.source_id WHERE p.snapshot_id IN (${latestSnapshotIds.map(() => "?").join(",")}) ORDER BY p.value_usd DESC`).bind(...latestSnapshotIds).all<Record<string, unknown>>()).results ?? []
    : [];
  const positionsBySnapshot = new Map<string, Record<string, unknown>[]>();
  for (const position of positions) {
    const rows = positionsBySnapshot.get(String(position.snapshot_id)) ?? [];
    rows.push(position);
    positionsBySnapshot.set(String(position.snapshot_id), rows);
  }
  // Response shape expected by the original Manage Asset frontend; the same
  // mappers /api/manage-asset/history uses, so the two endpoints cannot drift.
  const snapshots = snapshotRows
    .filter((row) => String(row.source_type).toLowerCase() === "wallet")
    .map((row) => toLegacyWalletSnapshot(row, positionsBySnapshot.get(String(row.id)) ?? []));
  const exchangeSnapshots = snapshotRows
    .filter((row) => String(row.source_type).toLowerCase() !== "wallet")
    .map((row) => toLegacyExchangeSnapshot(row, positionsBySnapshot.get(String(row.id)) ?? []));
  const walletsConfig = sources
    .filter((source) => String(source.source_type).toLowerCase() === "wallet")
    .map((source) => ({
      wallet_id: source.id,
      name: source.display_name,
      address: source.public_address,
      enabled: Boolean(source.enabled),
    }));
  const exchangeSources = sources
    .filter((source) => String(source.source_type).toLowerCase() !== "wallet")
    .map((source) => ({
      ...source,
      source_id: source.id,
      credential_configured: true,
    }));
  // The page reads sources / wallets / snapshots / exchange_snapshots /
  // daily_update and nothing else. It used to also receive history, runs,
  // positions and holdings: the first two were never referenced at all, and
  // the holdings shown on screen are computed client-side by
  // Core.holdings(state) from the snapshots above, not taken from here.
  //
  // Producing them cost a GROUP BY over every snapshot, a scan of
  // asset_sync_runs, and a full read of asset_history_records (for a holdings
  // fallback that the page never displayed) on every page view.
  return Response.json({
    sources: exchangeSources,
    wallets: walletsConfig,
    snapshots,
    exchange_snapshots: exchangeSnapshots,
    daily_update: { errors: {} },
  });
});
