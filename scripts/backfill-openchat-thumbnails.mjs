// ちきりんオプチャ一覧のサムネイルを、既存のスレッドについて一度だけ取得して保存する(移行用)。
// 新しいスレッドは同期時に、リンクを直したときは放送情報の保存時に取得されるので、通常は使わない。
//
// 使い方(プロジェクトのルートで):
//   node scripts/backfill-openchat-thumbnails.mjs            # 取得だけして結果を表示(何も書き込まない)
//   node scripts/backfill-openchat-thumbnails.mjs --apply    # 本番のD1に書き込む
// 本番D1の読み取りは最初の1回だけ(日次の読み取り上限を使い切らないため)。書き込みは INSERT OR IGNORE なので、
// すでに取得済みの行は上書きしない。テーブルが無ければ migrations/0013 と同じ定義で作る。
import { execFileSync } from "node:child_process";
import { metaFromRow } from "../app/lib/openchat-meta.ts";
import { youTubeThumbnailFromLinks } from "../app/lib/thumbnail.ts";
import { fetchPageThumbnail } from "../app/lib/thumbnail-fetch.ts";

const apply = process.argv.includes("--apply");
const d1 = (sql) => JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "hiraku-watch-list", "--remote", "--json", "--command", sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const rows = d1(`SELECT n.id, n.link_url, m.links_json FROM openchat_notes n
  LEFT JOIN openchat_note_meta m ON m.note_id = n.id
  WHERE n.deleted_at IS NULL`)[0].results;

const statements = [];
for (const row of rows) {
  const url = metaFromRow(row).links[0]?.url || row.link_url;
  if (!url || youTubeThumbnailFromLinks([{ url }])) continue;
  const found = await fetchPageThumbnail(url);
  console.log(found ? "found  " : "none   ", url);
  statements.push(`INSERT OR IGNORE INTO openchat_note_thumbnails (note_id, source_url, thumbnail_url, checked_at) VALUES (${q(row.id)}, ${q(url)}, ${q(found)}, ${q(new Date().toISOString())})`);
}
console.log(`${statements.length} 件を取得しました(見つかった: ${statements.filter((s) => !/, '', '/.test(s)).length})`);
const ddl = "CREATE TABLE IF NOT EXISTS openchat_note_thumbnails (note_id TEXT PRIMARY KEY, source_url TEXT NOT NULL, thumbnail_url TEXT NOT NULL DEFAULT '', checked_at TEXT NOT NULL)";
if (apply && statements.length) { d1([ddl, ...statements].join(";\n")); console.log("本番D1に書き込みました。"); }
else console.log(apply ? "書き込む行はありません。" : "--apply を付けると書き込みます。");
