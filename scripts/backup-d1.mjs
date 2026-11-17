#!/usr/bin/env node
// 本番の D1（hiraku-watch-list）を、SQL ファイル（スキーマ + 全データ）として手元に保存する。
//
//   node scripts/backup-d1.mjs [出力先ディレクトリ]      既定: ~/Backups/dashboard
//   node scripts/backup-d1.mjs --local [出力先]          ローカルの D1（wrangler dev 用）を保存する
//   node scripts/backup-d1.mjs --keep 8                   保存に成功したあと、このスクリプトが作った古いファイルを
//                                                         新しい8件だけ残して消す（--local のファイルは数えない）
//
// なぜ要るか: D1 の Time Travel（過去の時点への復元）は Cloudflare の側にあり、復元できる期間が限られる
// （Free プランは短い）。ここで手元に持っておけば、期間を過ぎた誤操作や、Cloudflare 側の障害にも備えられる。
// 復元の手順は docs/operations.md。
//
// 読み取りだけを行う（`wrangler d1 export` は全テーブルを1回読む。いまの規模は合計3万行ほどで、
// D1 の1日の読み取り枠 500万行に対してごくわずか）。繰り返し呼ぶ用途ではなく、週に1回ほどを想定している。
// R2（TextTube の詳細スクリプトと資産の原本）は含まない。D1 の台帳（storage_objects）には鍵が残る。
//
// 保存したファイルは個人データそのものなので、リポジトリの外に置くこと（既定の出力先はそうなっている）。
// 古いファイルは、--keep を付けたときだけ消す（名前が dashboard-d1-<日時>.sql のものに限る）。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const local = args.includes("--local");
const keepIndex = args.indexOf("--keep");
const keep = keepIndex >= 0 ? Number(args[keepIndex + 1]) : 0;
if (keepIndex >= 0 && !(Number.isInteger(keep) && keep >= 1)) {
  console.error("--keep には 1 以上の整数を指定してください。");
  process.exit(2);
}
// 出力先は、フラグでも --keep の値でもない最初の引数。
const outDir = path.resolve(args.find((arg, index) => !arg.startsWith("--") && index !== keepIndex + 1) ?? path.join(os.homedir(), "Backups", "dashboard"));
const root = path.resolve(import.meta.dirname, "..");

if (outDir === root || outDir.startsWith(root + path.sep)) {
  console.error(`出力先がリポジトリの中です（${outDir}）。個人データをコミットしてしまわないよう、外を指定してください。`);
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
const file = path.join(outDir, `dashboard-d1-${local ? "local-" : ""}${stamp}.sql`);

try {
  execFileSync("npx", ["wrangler", "d1", "export", "hiraku-watch-list", local ? "--local" : "--remote", "--output", file], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
} catch {
  console.error("wrangler d1 export が失敗しました。");
  fs.rmSync(file, { force: true });
  process.exit(1);
}

// 空や途中までのファイルを「成功」にしない: スキーマとデータの両方があることを確かめる。
const sql = fs.readFileSync(file, "utf8");
const tables = (sql.match(/^CREATE TABLE /gm) ?? []).length;
const inserts = (sql.match(/^INSERT INTO /gm) ?? []).length;
if (!tables || !inserts) {
  console.error(`保存したファイルが不完全です（テーブル ${tables} 個、INSERT ${inserts} 行）: ${file}`);
  process.exit(1);
}
fs.chmodSync(file, 0o600);
console.log(`保存しました: ${file}（${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB、テーブル ${tables} 個、INSERT ${inserts} 行）`);

// 古いバックアップを整理する。保存に成功したあとにだけ行い、名前がこのスクリプトの形式に合うものだけを対象にする
// （--local のファイルや、ほかのファイルには触れない）。名前に日時が入っているので、名前順が新しい順になる。
if (keep && !local) {
  const mine = fs.readdirSync(outDir).filter((name) => /^dashboard-d1-\d{8}-\d{6}Z\.sql$/.test(name)).sort();
  for (const name of mine.slice(0, Math.max(0, mine.length - keep))) {
    fs.rmSync(path.join(outDir, name));
    console.log(`古いバックアップを削除しました: ${name}`);
  }
}
