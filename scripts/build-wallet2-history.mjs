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
 *  その時点の本番から作った同じ結果になる）。テーブルが無ければ、本番と同じ定義で作る。
 *
 *  過去の倍率の調整（3つ目の引数、JSON ファイル）: 通貨ごとの倍率が違うと、ある通貨を別の通貨に
 *  替えた日に、ウォレット2の総額だけが段になる。それを消すため、決めた source・通貨・日付より前の
 *  数量だけ、別の倍率で数えられる。
 *    [{ "sourceId": "...", "symbol": "USDT", "before": "YYYY-MM-DD", "restFactor": 100,
 *       "lots": [{ "until": "YYYY-MM-DD", "quantity": 1234.5, "factor": 8 }] }]
 *  （"from": "YYYY-MM-DD" を足すと、その日以降だけに絞れる）
 *  `before` より前の日付で、その source のその通貨の数量のうち、`until` 以前の日なら lots の数量を
 *  その倍率で、残りを restFactor で数える（blendedFactor()）。それ以外は通常の倍率のまま。
 *  実際の数量が入るので、このファイルはリポジトリに置かない（collector/data/ など、手元だけに置く）。
 *  作り直すときは、毎回同じファイルを渡す（渡さないと調整の無い倍率に戻る）。 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { exchangePositions, walletPositions } from "../app/lib/manage-asset-core.ts";
import {
  blendedFactor,
  demoFactor,
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

/** その source・日付の、その通貨の数量に使う倍率の関数（調整が無ければ demoFactor そのもの）。 */
export function factorOfFor(adjustments, sourceId, date, quantityOf) {
  const rule = adjustments.find((candidate) => candidate.sourceId === sourceId && String(date) < candidate.before && (!candidate.from || String(date) >= candidate.from));
  if (!rule) return demoFactor;
  const symbol = String(rule.symbol).toLowerCase();
  const lots = (rule.lots ?? []).filter((lot) => !lot.until || String(date) <= lot.until);
  const factor = blendedFactor(quantityOf(rule.symbol), lots, rule.restFactor);
  return (candidate) => (String(candidate ?? "").trim().toLowerCase() === symbol ? factor : demoFactor(candidate));
}

/** 移行前の履歴1件の、ある通貨の数量（画面と同じ読み方。パネルの文字から読む分も含む）。 */
function payloadQuantity(record, payload, symbol) {
  const positions = record.record_type === "wallet" ? walletPositions([{ ...payload, wallet_id: record.source_id }]) : exchangePositions([{ ...payload, source_id: record.source_id }]);
  return positions.filter((position) => position.symbol.toLowerCase() === String(symbol).toLowerCase()).reduce((sum, position) => sum + (position.quantity ?? 0), 0);
}

/** 本番の資産テーブル（SQLite に読み込んだもの）から、ウォレット2に流す SQL の文を作る。
 *  `adjustments` は冒頭のコメントの「過去の倍率の調整」。 */
export function buildWallet2Statements(db, { adjustments = [] } = {}) {
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
    const positions = positionsBySnapshot.get(snapshot.id) ?? [];
    const factorOf = factorOfFor(adjustments, snapshot.source_id, snapshot.as_of_date, (symbol) => positions
      .filter((position) => String(position.symbol).toLowerCase() === String(symbol).toLowerCase())
      .reduce((sum, position) => sum + (Number(position.quantity) || 0), 0));
    const scaledPositions = positions.map((position) => {
      const { row, deltaUsd } = scalePositionRow(position, factorOf);
      delta += deltaUsd;
      return row;
    });
    // ウォレット2は R2 に原本を置かない（同期の archiveRaw: false と同じ状態にする）。
    emit("asset_snapshots", { ...scaleSnapshotTotals(snapshot, delta), raw_object_key: null, raw_sha256: null, raw_storage_status: "local_only" });
    for (const position of scaledPositions) emit("asset_positions", position);
  }

  // 移行前の履歴: payload を書き換え、列は history-import と同じく payload から出し直す。
  for (const record of all("SELECT * FROM asset_history_records ORDER BY as_of_date, source_id, captured_at")) {
    const original = JSON.parse(String(record.payload_json));
    const factorOf = factorOfFor(adjustments, record.source_id, String(record.as_of_date).slice(0, 10), (symbol) => payloadQuantity(record, original, symbol));
    const payload = scaleAssetRecord(original, factorOf).record;
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
  const [input, output, adjustmentsPath] = process.argv.slice(2);
  if (!input || !output) {
    console.error("Usage: node scripts/build-wallet2-history.mjs <prod-assets.db> <wallet2.sql> [adjustments.json]");
    process.exit(2);
  }
  const db = new DatabaseSync(input, { readOnly: true });
  const adjustments = adjustmentsPath ? JSON.parse(readFileSync(adjustmentsPath, "utf8")) : [];
  const { statements, counts } = buildWallet2Statements(db, { adjustments });
  if (adjustments.length) console.log(`adjustments: ${adjustments.length} rule(s) from ${adjustmentsPath}`);
  writeFileSync(output, `${statements.join("\n")}\n`);
  const rows = Object.values(counts).reduce((sum, count) => sum + count, 0);
  console.log(`${output}: ${statements.length} statements, ${rows} rows`);
  for (const table of ASSET_TABLES) console.log(`  ${table}: ${counts[table] ?? 0}`);
}
