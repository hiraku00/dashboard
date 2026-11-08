import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { ASSET_TABLES, buildWallet2Statements } from "../scripts/build-wallet2-history.mjs";
import { wallet2Address } from "../app/lib/manage-asset-wallet2.ts";

// scripts/build-wallet2-history.mjs は、本番の資産テーブルからウォレット2の過去分を一度だけ作る。
// 本番と同じ定義（migrations）のテーブルに数行入れ、作った SQL を空の DB に流して、
// 倍率どおり・同じ形になることと、二度流しても同じになることを確かめる。

const REAL_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

function productionLike() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["0001_portal.sql", "0004_dedupe_asset_snapshots.sql", "0006_asset_history_lido_fx.sql"]) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  db.exec(`
    INSERT INTO asset_sources VALUES ('w1','wallet','debank','Main','${REAL_ADDRESS}',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    INSERT INTO asset_sources VALUES ('x1','exchange','bitflyer','bitFlyer','',1,NULL,'2026-01-01T00:00:00Z');
    INSERT INTO asset_sync_runs VALUES ('r1','c1','v','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z','completed',2,2,0,'2026-01-01T00:00:00Z');
    INSERT INTO asset_snapshots VALUES ('s1','r1','w1','2026-01-01T00:00:00Z','2026-01-01',4031,604650,150,'manage-asset/raw/x.json','sha',10,'stored');
    INSERT INTO asset_positions VALUES ('p1','s1','stETH',1,4000,4000,600000,'defi','Lido','asset',0);
    INSERT INTO asset_positions VALUES ('p2','s1','USDT',10,1,10,1500,'wallet','','asset',0);
    INSERT INTO asset_positions VALUES ('p3','s1','ETH',0.01,2000,20,3000,'wallet','','asset',0);
    INSERT INTO asset_snapshots VALUES ('s2','r1','x1','2026-01-01T00:01:00Z','2026-01-01',900,135000,150,NULL,NULL,NULL,'local_only');
    INSERT INTO asset_positions VALUES ('p4','s2','BTC',0.01,100000,1000,150000,'exchange','spot','asset',0);
    INSERT INTO asset_positions VALUES ('p5','s2','JPY',15000,0.00666,-100,-15000,'exchange','margin','debt',1);
  `);
  const payload = { wallet_id: "w1", address: REAL_ADDRESS, as_of_date: "2025-12-01", captured_at: "2025-12-01T00:00:00Z", total_usd: "3020", tokens: [{ symbol: "ETH", amount_display: "0.0100", usd_value_display: "$20.00" }], protocols: [{ name: "Lido", panels: [{ assets: [], display_text: "USD Value stETH 1.0000 stETH $3,000.00" }] }] };
  db.prepare("INSERT INTO asset_history_records VALUES (?,?,?,?,?,?,?,?,?)").run("h1", "wallet", "w1", "2025-12-01", "2025-12-01T00:00:00Z", 3020, 0, 150, JSON.stringify(payload));
  db.prepare("INSERT INTO asset_lido_rewards VALUES (?,?,?,?,?,?,?,?)").run("l1", "2025-11-01", "reward", 0.001, 4, 2.8, 1, JSON.stringify({ date: "2025-11-01", type: "reward", change: 0.001, change_USD: 4, apr: 2.8, balance: 1 }));
  db.prepare("INSERT INTO asset_fx_rates VALUES (?,?,?)").run("2025-11-01", 150, JSON.stringify({ date: "2025-11-01", rate: 150 }));
  return db;
}

function applyTo(target, statements) {
  target.exec("PRAGMA foreign_keys = ON;");
  target.exec(statements.join("\n"));
}

test("builds wallet 2 from production: scaled per currency, same columns, look-alike address", () => {
  const { statements, counts } = buildWallet2Statements(productionLike());
  expect(counts).toEqual({ asset_sources: 2, asset_sync_runs: 1, asset_snapshots: 2, asset_positions: 5, asset_history_records: 1, asset_lido_rewards: 1, asset_fx_rates: 1 });

  const wallet2 = new DatabaseSync(":memory:");
  applyTo(wallet2, statements);
  const one = (sql) => wallet2.prepare(sql).get();

  expect(one("SELECT public_address FROM asset_sources WHERE id='w1'").public_address).toBe(wallet2Address(REAL_ADDRESS));
  expect(one("SELECT display_name FROM asset_sources WHERE id='x1'").display_name).toBe("bitFlyer");

  // stETH x8, USDT x1000, ETH x100. The 1 USD gap DeBank's rounding left (4031 vs 4030) stays.
  const delta = 4000 * 7 + 10 * 999 + 20 * 99;
  const wallet = one("SELECT * FROM asset_snapshots WHERE id='s1'");
  expect(wallet.total_usd).toBe(4031 + delta);
  expect(wallet.total_jpy).toBeCloseTo(604650 + delta * 150, 6);
  expect(wallet.raw_object_key).toBe(null);
  expect(wallet.raw_storage_status).toBe("local_only");
  expect(one("SELECT quantity, price_usd, value_usd FROM asset_positions WHERE id='p1'")).toEqual({ quantity: 8, price_usd: 4000, value_usd: 32000 });
  // BTC x20; a liability is scaled as a liability.
  expect(one("SELECT total_usd FROM asset_snapshots WHERE id='s2'").total_usd).toBe(900 + 1000 * 19 - 100 * 99);
  expect(one("SELECT quantity, value_usd, is_debt FROM asset_positions WHERE id='p5'")).toEqual({ quantity: 1500000, value_usd: -10000, is_debt: 1 });

  const history = one("SELECT * FROM asset_history_records WHERE id='h1'");
  const payload = JSON.parse(history.payload_json);
  expect(payload.address).toBe(wallet2Address(REAL_ADDRESS));
  expect(payload.tokens[0].amount_display).toBe("1.0000");
  expect(payload.protocols[0].panels[0].display_text).toBe("USD Value stETH 8.0000 stETH $24,000.00");
  expect(history.total_usd).toBe(3020 + 20 * 99 + 3000 * 7);

  expect(one("SELECT change, change_usd, apr, balance FROM asset_lido_rewards").balance).toBe(8);
  expect(JSON.parse(one("SELECT payload_json FROM asset_lido_rewards").payload_json)).toEqual({ date: "2025-11-01", type: "reward", change: 0.008, change_USD: 32, apr: 2.8, balance: 8 });
  expect(one("SELECT rate FROM asset_fx_rates").rate).toBe(150);

  // The same tables and columns as production.
  for (const table of ASSET_TABLES) {
    const columns = (db) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    expect(columns(wallet2)).toEqual(columns(productionLike()));
  }
});

test("running it twice gives the same wallet 2 (it empties the tables first)", () => {
  const { statements } = buildWallet2Statements(productionLike());
  const wallet2 = new DatabaseSync(":memory:");
  applyTo(wallet2, statements);
  const snapshot = () => ASSET_TABLES.map((table) => wallet2.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  const first = snapshot();
  applyTo(wallet2, statements);
  expect(snapshot()).toEqual(first);
});
