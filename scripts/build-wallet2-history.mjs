#!/usr/bin/env node
/** ウォレット2（ダミーデータ）の過去分を、本番の資産テーブルから一度だけ作る。
 *
 *  朝の同期は、本番に書くたびにウォレット2にも倍率を掛けて書く（app/api/manage-asset/sync）。
 *  それより前の分（過去のスナップショット、移行前の履歴、Lido の報酬、為替）は、このスクリプトで作る。
 *  倍率と書き換えは、同期と同じ app/lib/manage-asset-wallet2.ts の関数を使う。
 *
 *  手順（docs/manage-asset.md の「ウォレット2」も参照）:
 *    1. 本番の資産テーブルを書き出す（D1 は書き出しの数秒間、他の問い合わせを待たせる）
 *       npx wrangler d1 export hiraku-watch-list --remote --no-schema=false \
 *         --table asset_sources --table asset_sync_runs --table asset_snapshots --table asset_positions \
 *         --table asset_history_records --table asset_lido_rewards --table asset_fx_rates --output <dir>/prod-assets.sql
 *    2. 手元の SQLite に読み込む:  sqlite3 <dir>/prod-assets.db < <dir>/prod-assets.sql
 *    3. このスクリプトで、ウォレット2に流す SQL を作る:
 *       node scripts/build-wallet2-history.mjs <dir>/prod-assets.db <dir>/wallet2.sql
 *    4. ウォレット2に流す:
 *       npx wrangler d1 execute hiraku-manage-asset-wallet2 --remote --file <dir>/wallet2.sql
 *
 *  作る SQL は、ウォレット2の資産テーブルを空にしてから全部を入れ直す（何度流しても、
 *  その時点の本番から作った同じ結果になる）。テーブルが無ければ、本番と同じ定義で作る。 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import {
  scaleAssetRecord,
  scaleLidoReward,
  scalePositionRow,
  scaleSnapshotTotals,
  wallet2Address,
} from "../app/lib/manage-asset-wallet2.ts";

/** 親から子の順（外部キーの向き）。空にするときは逆順。 */
export const ASSET_TABLES = [
  "asset_sources",
  "asset_sync_runs",
  "asset_snapshots",
  "asset_positions",
  "asset_history_records",
  "asset_lido_rewards",
  "asset_fx_rates",
];

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function insert(table, row) {
  const columns = Object.keys(row);
  return `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((column) => sqlValue(row[column])).join(",")});`;
}

/** app/api/manage-asset/history-import/route.ts と同じ読み方（"$"・桁区切りを外し、読めなければ0）。 */
function number(value) {
  const parsed = Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 本番の資産テーブル（SQLite に読み込んだもの）から、ウォレット2に流す SQL の文を作る。 */
export function buildWallet2Statements(db) {
  const statements = [];
  const counts = {};
  const all = (sql) => db.prepare(sql).all();

  // テーブルと索引の定義は、本番の実物をそのまま（無ければ作る）。
  const definitions = db.prepare(`SELECT type, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name IN (${ASSET_TABLES.map(() => "?").join(",")})`).all(...ASSET_TABLES);
  const order = (row) => ASSET_TABLES.indexOf(row.tbl_name) * 2 + (row.type === "table" ? 0 : 1);
  for (const definition of definitions.sort((a, b) => order(a) - order(b))) {
    statements.push(`${definition.sql.replace(/^CREATE (UNIQUE )?(TABLE|INDEX)(?! IF NOT EXISTS)/i, (match) => `${match} IF NOT EXISTS`)};`);
  }
  for (const table of [...ASSET_TABLES].reverse()) statements.push(`DELETE FROM ${table};`);

  const emit = (table, row) => {
    statements.push(insert(table, row));
    counts[table] = (counts[table] ?? 0) + 1;
  };

  for (const source of all("SELECT * FROM asset_sources ORDER BY id")) emit("asset_sources", { ...source, public_address: wallet2Address(String(source.public_address ?? "")) });
  for (const run of all("SELECT * FROM asset_sync_runs ORDER BY received_at")) emit("asset_sync_runs", run);

  // スナップショットの総額は、その明細から出した差分で作り直す（同期の scaleAssetRecord と同じ考え方）。
  const positionsBySnapshot = new Map();
  for (const position of all("SELECT * FROM asset_positions ORDER BY snapshot_id, id")) {
    const rows = positionsBySnapshot.get(position.snapshot_id) ?? [];
    rows.push(position);
    positionsBySnapshot.set(position.snapshot_id, rows);
  }
  for (const snapshot of all("SELECT * FROM asset_snapshots ORDER BY as_of_date, source_id")) {
    let delta = 0;
    const scaledPositions = (positionsBySnapshot.get(snapshot.id) ?? []).map((position) => {
      const { row, deltaUsd } = scalePositionRow(position);
      delta += deltaUsd;
      return row;
    });
    // ウォレット2は R2 に原本を置かない（同期の archiveRaw: false と同じ状態にする）。
    emit("asset_snapshots", { ...scaleSnapshotTotals(snapshot, delta), raw_object_key: null, raw_sha256: null, raw_storage_status: "local_only" });
    for (const position of scaledPositions) emit("asset_positions", position);
  }

  // 移行前の履歴: payload を書き換え、列は history-import と同じく payload から出し直す。
  for (const record of all("SELECT * FROM asset_history_records ORDER BY as_of_date, source_id, captured_at")) {
    const payload = scaleAssetRecord(JSON.parse(String(record.payload_json))).record;
    emit("asset_history_records", {
      ...record,
      total_usd: number(payload.total_usd ?? payload.totals?.net_asset_usd),
      total_jpy: number(payload.total_jpy),
      payload_json: JSON.stringify(payload),
    });
  }

  for (const reward of all("SELECT * FROM asset_lido_rewards ORDER BY reward_date, id")) {
    const payload = scaleLidoReward(JSON.parse(String(reward.payload_json)));
    const scaled = scaleLidoReward({ change: reward.change, change_usd: reward.change_usd, balance: reward.balance });
    emit("asset_lido_rewards", { ...reward, change: scaled.change, change_usd: scaled.change_usd, balance: scaled.balance, payload_json: JSON.stringify(payload) });
  }

  // 為替レートは金額ではないので、そのまま。
  for (const rate of all("SELECT * FROM asset_fx_rates ORDER BY rate_date")) emit("asset_fx_rates", rate);

  return { statements, counts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("Usage: node scripts/build-wallet2-history.mjs <prod-assets.db> <wallet2.sql>");
    process.exit(2);
  }
  const db = new DatabaseSync(input, { readOnly: true });
  const { statements, counts } = buildWallet2Statements(db);
  writeFileSync(output, `${statements.join("\n")}\n`);
  const rows = Object.values(counts).reduce((sum, count) => sum + count, 0);
  console.log(`${output}: ${statements.length} statements, ${rows} rows`);
  for (const table of ASSET_TABLES) console.log(`  ${table}: ${counts[table] ?? 0}`);
}
