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
import { currencyFields } from "@/app/lib/manage-asset-history-fields";
import { LATEST_SNAPSHOT_JOIN } from "@/app/lib/manage-asset-latest-snapshot";

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
  // The sources and the latest snapshots do not depend on each other, so they
  // share one D1 round trip; only the positions need the snapshot ids and follow.
  const [sourceResult, snapshotResult] = await env.DB.batch<Row>([
    env.DB.prepare("SELECT * FROM asset_sources WHERE enabled=1 ORDER BY display_name"),
    // "Latest snapshot per source". This was a ROW_NUMBER() pass, which had to
    // read and rank every snapshot ever taken -- 4,200 rows to return 17. Since
    // asset_snapshots gained UNIQUE(source_id, as_of_date) there is exactly one
    // row per source and date, so the newest date per source identifies it
    // uniquely and the grouping can use asset_snapshots_source_date_idx instead
    // of scanning.
    env.DB.prepare(`SELECT s.*, a.source_type, a.display_name, a.provider, a.public_address
    ${LATEST_SNAPSHOT_JOIN}
    ORDER BY s.total_usd DESC`),
  ]);
  const sources = sourceResult.results ?? [];
  const snapshotRows = snapshotResult.results ?? [];
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

/** One record per source and date, newest wins, oldest date first.
 *
 *  A launchd retry can leave both a legacy-import row and a normalized row for
 *  the same source/date. The charts must use exactly one, newest record per
 *  source and date; otherwise today's stETH balance is multiplied. Shared by the
 *  detailed and the summary reads, so both pick the very same rows. */
function newestPerSourceAndDate(wallets: Row[], exchanges: Row[]): AssetHistory {
  const newestWallets = new Map<string, Row>();
  for (const row of wallets) {
    const key = `${String(row.wallet_id ?? "")}|${String(row.as_of_date ?? "").slice(0, 10)}`;
    const previous = newestWallets.get(key);
    if (key !== "|" && (!previous || newestRecord(row, previous))) newestWallets.set(key, row);
  }
  const newestExchanges = new Map<string, Row>();
  for (const row of exchanges) {
    const key = `${String(row.source_id ?? "")}|${String(row.as_of_date ?? "").slice(0, 10)}`;
    const previous = newestExchanges.get(key);
    if (key !== "|" && (!previous || newestRecord(row, previous))) newestExchanges.set(key, row);
  }
  const byDate = (a: Row, b: Row) => String(a.as_of_date ?? "").localeCompare(String(b.as_of_date ?? ""));
  return { snapshots: [...newestWallets.values()].sort(byDate), exchange_snapshots: [...newestExchanges.values()].sort(byDate) };
}

/** app/api/manage-asset/history の GET と、/manage-asset ページの初期表示が
 *  両方呼ぶ。`days` は "7"/"30"/"90"/"all"/null（= 全期間）。
 *
 *  形は3つ: 指定なし = 全項目、`summary` = 資産概要が使う ID・日付・合計だけ、
 *  `fields: "currency"` = 通貨推移が読む項目だけ（全項目の約半分）。 */
export async function assetHistory(days: string | null, options: { summary?: boolean; fields?: "currency" } = {}): Promise<AssetHistory> {
  await ensureSchema({ seed: false });
  const cutoff = await cutoffDate(days);
  if (options.summary) return assetHistorySummary(cutoff);
  const since = cutoff ?? "";
  const filterSql = cutoff ? " WHERE as_of_date >= ?" : "";
  const bind = cutoff ? [since] : [];
  // The legacy history rows, the normalized snapshots and their positions all
  // filter on the same window, so they share one D1 round trip (the window
  // lookup above has to come first: it produces the bound date).
  const snapshotFilter = cutoff ? " WHERE s.as_of_date >= ?" : "";
  const [recordResult, normalizedResult, positionResult] = await env.DB.batch<Row>([
    env.DB.prepare(`SELECT * FROM asset_history_records${filterSql} ORDER BY as_of_date ASC, captured_at ASC`).bind(...bind),
    // The daily collector writes the normalized current snapshot tables, while
    // the migration endpoint writes the legacy history table. Both are read here
    // and merged below so today's data is available to the same charts as
    // imported history.
    env.DB.prepare(`SELECT s.*, a.source_type, a.display_name, a.public_address, r.received_at AS sync_received_at
    FROM asset_snapshots s JOIN asset_sources a ON a.id=s.source_id
    LEFT JOIN asset_sync_runs r ON r.id=s.run_id${snapshotFilter}
    ORDER BY s.as_of_date ASC, s.captured_at ASC`).bind(...bind),
    env.DB.prepare(`SELECT p.*, s.id AS snapshot_id, s.source_id, s.as_of_date, s.captured_at, a.source_type, a.display_name
    FROM asset_positions p JOIN asset_snapshots s ON s.id=p.snapshot_id JOIN asset_sources a ON a.id=s.source_id${snapshotFilter}
    ORDER BY s.as_of_date ASC, s.captured_at ASC`).bind(...bind),
  ]);
  const records = recordResult.results ?? [];
  const normalized = normalizedResult.results ?? [];
  const normalizedPositions = positionResult.results ?? [];
  const snapshots = records.filter((row) => row.record_type === "wallet").map((row) => JSON.parse(String(row.payload_json)) as Row);
  const exchangeSnapshots = records.filter((row) => row.record_type === "exchange").map((row) => JSON.parse(String(row.payload_json)) as Row);
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
  const merged = newestPerSourceAndDate(snapshots, exchangeSnapshots);
  // `fields: "currency"`: only what the per-currency history reads (see manage-asset-history-fields.ts).
  return options.fields === "currency" ? currencyFields(merged) : merged;
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

/** The history the asset overview needs -- and nothing more.
 *
 *  The overview's trend line and its "前日保存比" read exactly these fields of a
 *  history row: wallet_id / source_id, as_of_date, captured_at, and the total
 *  (total_usd, or totals.net_asset_usd for an exchange), plus fx_usdjpy for the
 *  previous day's rate shown beside the current one. Everything else in a
 *  full row -- every token and position, addresses, names, raw payload -- is only
 *  for the per-currency history, and is most of the bytes: on production a
 *  90-day window is 896KB in full and ~170KB as this, and it skips the two
 *  heaviest reads (the 12,000-row positions join and parsing 588KB of legacy
 *  payload JSON).
 *
 *  The legacy rows' columns are written from their own payload by
 *  app/api/manage-asset/history-import/route.ts (source_id = wallet_id ?? source_id,
 *  the date cut to 10 characters, the total from total_usd or totals.net_asset_usd),
 *  and were checked equal to the payload on every production row (422 of 422),
 *  so the columns can stand in for parsing it.
 *
 *  It goes through the same newest-per-source-and-date merge as the full read,
 *  so both pick the same rows; tests/workers/manage-asset-queries.test.ts holds
 *  the two together on the same data. */
async function assetHistorySummary(cutoff: string | null): Promise<AssetHistory> {
  const filterSql = cutoff ? " WHERE as_of_date >= ?" : "";
  const snapshotFilter = cutoff ? " WHERE s.as_of_date >= ?" : "";
  const bind = cutoff ? [cutoff] : [];
  const [recordResult, normalizedResult] = await env.DB.batch<Row>([
    env.DB.prepare(`SELECT record_type, source_id, as_of_date, captured_at, total_usd, fx_usdjpy FROM asset_history_records${filterSql} ORDER BY as_of_date ASC, captured_at ASC`).bind(...bind),
    env.DB.prepare(`SELECT s.source_id, s.as_of_date, s.captured_at, s.total_usd, s.fx_usdjpy, a.source_type, r.received_at AS sync_received_at
    FROM asset_snapshots s JOIN asset_sources a ON a.id=s.source_id
    LEFT JOIN asset_sync_runs r ON r.id=s.run_id${snapshotFilter}
    ORDER BY s.as_of_date ASC, s.captured_at ASC`).bind(...bind),
  ]);
  const wallets: Row[] = [];
  const exchanges: Row[] = [];
  const add = (isWallet: boolean, row: Row, syncReceivedAt?: unknown) => {
    const summary: Row = isWallet
      ? { wallet_id: row.source_id, as_of_date: row.as_of_date, captured_at: row.captured_at, total_usd: row.total_usd, fx_usdjpy: row.fx_usdjpy }
      : { source_id: row.source_id, as_of_date: row.as_of_date, captured_at: row.captured_at, totals: { net_asset_usd: row.total_usd }, fx_usdjpy: row.fx_usdjpy };
    // newestRecord() compares the sync time first; it is dropped again below.
    if (syncReceivedAt !== undefined) summary.sync_received_at = syncReceivedAt;
    (isWallet ? wallets : exchanges).push(summary);
  };
  for (const row of recordResult.results ?? []) {
    if (row.record_type === "wallet") add(true, row);
    else if (row.record_type === "exchange") add(false, row);
  }
  for (const row of normalizedResult.results ?? []) add(String(row.source_type).toLowerCase() === "wallet", row, row.sync_received_at);
  const merged = newestPerSourceAndDate(wallets, exchanges);
  const withoutSyncTime = (rows: Row[]) => rows.map((row) => {
    const copy = { ...row };
    delete copy.sync_received_at;
    return copy;
  });
  return { snapshots: withoutSyncTime(merged.snapshots), exchange_snapshots: withoutSyncTime(merged.exchange_snapshots) };
}
