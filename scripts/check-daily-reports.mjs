#!/usr/bin/env node
// 手元の作業日報を一括で解析・タグ付けし、取り込む前に結果を確かめる(D1・ネットワークには触れない)。
// 日報は個人的な内容を含むので、このリポジトリには置かず、パスで渡す。
//
//   node scripts/check-daily-reports.mjs ~/Practice/auto-daily-report/outputs
//
// failed が1件でもあれば終了コード1。
import fs from "node:fs";
import path from "node:path";
import { parseDailyReport } from "../app/lib/daily-report-parse.ts";
import { OTHER_TAG, tagDailyReport } from "../app/lib/daily-report-tags.ts";

const [dir] = process.argv.slice(2);
if (!dir) {
  console.error("Usage: node scripts/check-daily-reports.mjs <daily_report_YYYY-MM-DD.md のあるディレクトリ>");
  process.exit(1);
}

const files = fs.readdirSync(dir).filter((name) => /^daily_report_\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort();
const statuses = { ok: 0, partial: 0, failed: 0 };
const minutesByTag = new Map();
for (const name of files) {
  const date = name.slice("daily_report_".length, -".md".length);
  const report = parseDailyReport(fs.readFileSync(path.join(dir, name), "utf8"), date);
  statuses[report.status] += 1;
  if (report.status !== "ok") console.log(`${date} ${report.status}: ${report.warnings.join(" / ")}`);
  for (const day of tagDailyReport(report).tagDays) minutesByTag.set(day.tag, (minutesByTag.get(day.tag) ?? 0) + day.minutes);
}

const total = [...minutesByTag.values()].reduce((sum, minutes) => sum + minutes, 0) || 1;
console.log(`\n${files.length}件: ok ${statuses.ok} / partial ${statuses.partial} / failed ${statuses.failed}`);
console.log("タグ別の時間:");
for (const [tag, minutes] of [...minutesByTag].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tag.padEnd(14)} ${String(Math.round(minutes / 60)).padStart(5)}h ${((100 * minutes) / total).toFixed(1).padStart(5)}%${tag === OTHER_TAG ? "  ← どのタグにも当たらない" : ""}`);
}
process.exitCode = statuses.failed ? 1 : 0;
