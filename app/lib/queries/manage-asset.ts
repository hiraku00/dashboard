/** Manage Asset の読み取りロジック（D1呼び出しを伴うオーケストレーション層）。
 *  app/api/manage-asset/state, /history の GET と、/manage-asset ページの
 *  Server Component の両方がこれを呼ぶ -- ロジックを複製すると「ページとAPIで
 *  表示がずれる」種類のバグを作るので、正はここに一本化する
 *  （app/lib/queries/watch-list.ts と同じ理由）。
 *
 *  state と history が同じ toLegacyWalletSnapshot / toLegacyExchangeSnapshot を
 *  通すことで、レガシーフロントに渡す形が二本の間でドリフトしない -- という
 *  元のルートのコメントが強調していた不変条件を、共有関数として構造で担保する。
 *
 *  書き込み系（同期の取り込み等）はここには置かない。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { toLegacyExchangeSnapshot, toLegacyWalletSnapshot } from "@/app/lib/manage-asset-legacy";

type Row = Record<string, unknown>;

export type AssetState = {
  sources: Row[];
  wallets: Array<{ wallet_id: unknown; name: unknown; address: unknown; enabled: boolean }>;
  snapshots: ReturnType<typeof toLegacyWalletSnapshot>[];
  exchange_snapshots: ReturnType<typeof toLegacyExchangeSnapshot>[];
  daily_update: { errors: Record<string, string> };
};

/** app/api/manage-asset/state の GET と、/manage-asset ページの初期表示が両方呼ぶ。 */
export async function assetState(): Promise<AssetState> {
  await ensureSchema({ seed: false });
  const sources = (await env.DB.prepare("SELECT * FROM asset_sources WHERE enabled=1 ORDER BY display_name").all<Row>()).results ?? [];
  // "Latest snapshot per source". This was a ROW_NUMBER() pass, which had to
  // read and rank every snapshot ever taken -- 4,200 rows to return 17. Since
  // asset_snapshots gained UNIQUE(source_id, as_of_date) there is exactly one
  // row per source and date, so the newest date per source identifies it
  // uniquely and the grouping can use asset_snapshots_source_date_idx instead
  // of scanning.
  const snapshotRows = (await env.DB.prepare(`SELECT s.*, a.source_type, a.display_name, a.provider, a.public_address
    FROM asset_snapshots s
    JOIN (SELECT source_id, MAX(as_of_date) AS as_of_date FROM asset_snapshots GROUP BY source_id) latest
      ON latest.source_id = s.source_id AND latest.as_of_date = s.as_of_date
    JOIN asset_sources a ON a.id = s.source_id
    ORDER BY s.total_usd DESC`).all<Row>()).results ?? [];
  // Reuse the snapshot ids already resolved above instead of re-running the
  // same "latest per source" lookup a second time for positions.
  const latestSnapshotIds = snapshotRows.map((row) => String(row.id ?? "")).filter(Boolean);
  const positions = latestSnapshotIds.length
    ? (await env.DB.prepare(`SELECT p.*, a.display_name, a.provider FROM asset_positions p JOIN asset_snapshots s ON s.id=p.snapshot_id JOIN asset_sources a ON a.id=s.source_id WHERE p.snapshot_id IN (${latestSnapshotIds.map(() => "?").join(",")}) ORDER BY p.value_usd DESC`).bind(...latestSnapshotIds).all<Row>()).results ?? []
    : [];
  const positionsBySnapshot = new Map<string, Row[]>();
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
    .map((source) => ({ wallet_id: source.id, name: source.display_name, address: source.public_address, enabled: Boolean(source.enabled) }));
  const exchangeSources = sources
    .filter((source) => String(source.source_type).toLowerCase() !== "wallet")
    .map((source) => ({ ...source, source_id: source.id, credential_configured: true }));
  // The page reads sources / wallets / snapshots / exchange_snapshots /
  // daily_update and nothing else; holdings shown on screen are computed from
  // the snapshots above via manage-asset-core, not taken from here.
  return { sources: exchangeSources, wallets: walletsConfig, snapshots, exchange_snapshots: exchangeSnapshots, daily_update: { errors: {} } };
}

function newestRecord(current: Row, previous: Row): boolean {
  const currentSync = String(current.sync_received_at ?? "");
  const previousSync = String(previous.sync_received_at ?? "");
  if (currentSync !== previousSync) return currentSync > previousSync;
  return String(current.captured_at ?? "") > String(previous.captured_at ?? "");
}

/** Resolves ?days= into the earliest as_of_date to return, or null for "all".
 *  Reproduces the set the client used to keep (`latest_date - (period - 1)`
 *  calendar days including the latest). The latest date spans both tables:
 *  normalized snapshots hold current data, asset_history_records the imported
 *  past, and callers merge them before picking their own latest. */
async function cutoffDate(days: string | null): Promise<string | null> {
  if (!days || days === "all") return null;
  const window = Number(days);
  if (!Number.isFinite(window) || window < 1) return null;
  const row = (await env.DB.prepare(`SELECT MAX(latest) AS latest FROM (
         SELECT MAX(as_of_date) AS latest FROM asset_snapshots
         UNION ALL SELECT MAX(as_of_date) FROM asset_history_records)`).all<{ latest: string | null }>()).results?.[0];
  const latest = row?.latest;
  if (!latest) return null;
  const date = new Date(`${latest}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - Math.trunc(window) + 1);
  return date.toISOString().slice(0, 10);
}

export type AssetHistory = { snapshots: Row[]; exchange_snapshots: Row[] };

/** app/api/manage-asset/history の GET と、/manage-asset ページの初期表示が
 *  両方呼ぶ。`days` は "7"/"30"/"90"/"all"/null（= 全期間）。 */
export async function assetHistory(days: string | null): Promise<AssetHistory> {
  await ensureSchema({ seed: false });
  const cutoff = await cutoffDate(days);
  const since = cutoff ?? "";
  const filterSql = cutoff ? " WHERE as_of_date >= ?" : "";
  const bind = cutoff ? [since] : [];
  const records = (await env.DB.prepare(`SELECT * FROM asset_history_records${filterSql} ORDER BY as_of_date ASC, captured_at ASC`).bind(...bind).all<Row>()).results ?? [];
  let snapshots = records.filter((row) => row.record_type === "wallet").map((row) => JSON.parse(String(row.payload_json)) as Row);
  let exchangeSnapshots = records.filter((row) => row.record_type === "exchange").map((row) => JSON.parse(String(row.payload_json)) as Row);

  // The daily collector writes the normalized current snapshot tables, while
  // the migration endpoint writes the legacy history table. Merge both here so
  // today's data is available to the same charts as imported history.
  const snapshotFilter = cutoff ? " WHERE s.as_of_date >= ?" : "";
  const normalized = (await env.DB.prepare(`SELECT s.*, a.source_type, a.display_name, a.public_address, r.received_at AS sync_received_at
    FROM asset_snapshots s JOIN asset_sources a ON a.id=s.source_id
    LEFT JOIN asset_sync_runs r ON r.id=s.run_id${snapshotFilter}
    ORDER BY s.as_of_date ASC, s.captured_at ASC`).bind(...bind).all<Row>()).results ?? [];
  const normalizedPositions = (await env.DB.prepare(`SELECT p.*, s.id AS snapshot_id, s.source_id, s.as_of_date, s.captured_at, a.source_type, a.display_name
    FROM asset_positions p JOIN asset_snapshots s ON s.id=p.snapshot_id JOIN asset_sources a ON a.id=s.source_id${snapshotFilter}
    ORDER BY s.as_of_date ASC, s.captured_at ASC`).bind(...bind).all<Row>()).results ?? [];
  const positionsBySnapshot = new Map<string, Row[]>();
  for (const position of normalizedPositions) {
    // Position rows belong to one concrete asset_snapshots row. Do not group by
    // source/date/captured_at: retries can create multiple snapshots with the
    // same values, and merging them multiplies every currency.
    const key = String(position.snapshot_id ?? "");
    if (!key) continue;
    const rows = positionsBySnapshot.get(key) ?? [];
    rows.push(position);
    positionsBySnapshot.set(key, rows);
  }
  for (const row of normalized) {
    const positions = positionsBySnapshot.get(String(row.id ?? "")) ?? [];
    if (String(row.source_type).toLowerCase() === "wallet") snapshots.push(toLegacyWalletSnapshot(row, positions));
    else exchangeSnapshots.push(toLegacyExchangeSnapshot(row, positions));
  }
  // A launchd retry can leave both a legacy-import row and a normalized row for
  // the same source/date. The charts must use exactly one, newest record per
  // source and date; otherwise today's stETH balance is multiplied.
  const newestWallets = new Map<string, Row>();
  for (const row of snapshots) {
    const key = `${String(row.wallet_id ?? "")}|${String(row.as_of_date ?? "").slice(0, 10)}`;
    const previous = newestWallets.get(key);
    if (key !== "|" && (!previous || newestRecord(row, previous))) newestWallets.set(key, row);
  }
  const newestExchanges = new Map<string, Row>();
  for (const row of exchangeSnapshots) {
    const key = `${String(row.source_id ?? "")}|${String(row.as_of_date ?? "").slice(0, 10)}`;
    const previous = newestExchanges.get(key);
    if (key !== "|" && (!previous || newestRecord(row, previous))) newestExchanges.set(key, row);
  }
  snapshots = [...newestWallets.values()].sort((a, b) => String(a.as_of_date ?? "").localeCompare(String(b.as_of_date ?? "")));
  exchangeSnapshots = [...newestExchanges.values()].sort((a, b) => String(a.as_of_date ?? "").localeCompare(String(b.as_of_date ?? "")));
  return { snapshots, exchange_snapshots: exchangeSnapshots };
}

/** app/api/lido-rewards の GET と、通貨推移ページの初期表示が両方呼ぶ。 */
export async function lidoRewards(): Promise<Row[]> {
  await ensureSchema({ seed: false });
  const rows = (await env.DB.prepare("SELECT payload_json FROM asset_lido_rewards ORDER BY reward_date ASC").all<{ payload_json: string }>()).results ?? [];
  return rows.map((row) => JSON.parse(row.payload_json));
}

/** app/api/usd-jpy-rates の GET と、通貨推移ページの初期表示が両方呼ぶ。 */
export async function usdJpyRates(): Promise<Row[]> {
  await ensureSchema({ seed: false });
  const rows = (await env.DB.prepare("SELECT payload_json FROM asset_fx_rates ORDER BY rate_date ASC").all<{ payload_json: string }>()).results ?? [];
  return rows.map((row) => JSON.parse(row.payload_json));
}

/** app/api/manage-asset/sync の GET と、データ更新ページの初期表示が両方呼ぶ。 */
export async function latestSyncRun(): Promise<Row | null> {
  await ensureSchema({ seed: false });
  return (await env.DB.prepare("SELECT * FROM asset_sync_runs ORDER BY received_at DESC LIMIT 1").all<Row>()).results?.[0] ?? null;
}
