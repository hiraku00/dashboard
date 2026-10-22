/** 作業日報の週次・月次サマリの D1 への書き込み(docs/daily-report-ingest-design.md §10)。
 *  日報(daily-report-store.ts)と違い解析・タグ付けはせず、原本の Markdown をそのまま置く。 */

import { env } from "cloudflare:workers";
import { isReportDate, MAX_MARKDOWN_BYTES, sha256Hex } from "./daily-report-store.ts";

/** 1リクエストの件数の上限(1件は日報と同じ64KBまで。現状のサマリは5〜10KB) */
export const MAX_SUMMARIES_PER_REQUEST = 20;

export type SummaryKind = "week" | "month";

export type SummaryIngestResult = {
  kind: string;
  periodStart: string;
  status: "created" | "updated" | "skipped" | "error";
  error?: string;
};

export function isSummaryKind(value: unknown): value is SummaryKind {
  return value === "week" || value === "month";
}

/** 期間の始まりが kind に合っているか(週は月曜、月は1日)。 */
export function isPeriodStart(kind: SummaryKind, periodStart: unknown): periodStart is string {
  if (!isReportDate(periodStart)) return false;
  const start = new Date(`${periodStart}T00:00:00Z`);
  return kind === "week" ? start.getUTCDay() === 1 : start.getUTCDate() === 1;
}

/** 期間の終わり。週は始まりの6日後(日曜)、月はその月の末日。 */
export function periodEndOf(kind: SummaryKind, periodStart: string): string {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = kind === "week"
    ? new Date(start.getTime() + 6 * 86_400_000)
    : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return end.toISOString().slice(0, 10);
}

/** 1件の形と期間を確かめる。誤りがあればその説明を返す。 */
function validate(summary: { kind: unknown; periodStart: unknown; periodEnd: unknown; markdown: unknown }): string | null {
  if (!isSummaryKind(summary.kind)) return "kindはweekかmonthにしてください。";
  if (!isPeriodStart(summary.kind, summary.periodStart)) {
    return summary.kind === "week" ? "週のperiodStartは月曜日のYYYY-MM-DDにしてください。" : "月のperiodStartは1日のYYYY-MM-DDにしてください。";
  }
  const expectedEnd = periodEndOf(summary.kind, summary.periodStart);
  if (summary.periodEnd !== expectedEnd) {
    return summary.kind === "week" ? `週のperiodEndはperiodStartの6日後(${expectedEnd})にしてください。` : `月のperiodEndはその月の末日(${expectedEnd})にしてください。`;
  }
  if (typeof summary.markdown !== "string" || !summary.markdown.trim()) return "markdownが空です。";
  if (new TextEncoder().encode(summary.markdown).byteLength > MAX_MARKDOWN_BYTES) return `markdownは1件${MAX_MARKDOWN_BYTES / 1024}KBまでです。`;
  return null;
}

/** POST /api/daily-report-summaries の1件ずつの処理。同じ本文(sha256)が登録済みなら何も書かない。
 *  1件の誤りはその件の error にして、ほかの件は続ける。 */
export async function ingestDailyReportSummaries(
  summaries: Array<{ kind: unknown; periodStart: unknown; periodEnd: unknown; markdown: unknown }>,
): Promise<SummaryIngestResult[]> {
  const key = (kind: string, periodStart: string) => `${kind}/${periodStart}`;
  const valid = summaries.filter((s) => isSummaryKind(s.kind) && isReportDate(s.periodStart)) as Array<{ kind: SummaryKind; periodStart: string }>;
  const stored = new Map<string, string>();
  if (valid.length) {
    const rows = await env.DB.prepare(`SELECT kind,period_start,sha256 FROM daily_report_summaries WHERE ${valid.map(() => "(kind=? AND period_start=?)").join(" OR ")}`)
      .bind(...valid.flatMap((s) => [s.kind, s.periodStart])).all<{ kind: string; period_start: string; sha256: string }>();
    for (const row of rows.results ?? []) stored.set(key(row.kind, row.period_start), row.sha256);
  }

  const results: SummaryIngestResult[] = [];
  for (const summary of summaries) {
    const kind = typeof summary.kind === "string" ? summary.kind : String(summary.kind ?? "");
    const periodStart = typeof summary.periodStart === "string" ? summary.periodStart : String(summary.periodStart ?? "");
    const invalid = validate(summary);
    if (invalid) {
      results.push({ kind, periodStart, status: "error", error: invalid });
      continue;
    }
    try {
      const markdown = summary.markdown as string;
      const sha256 = await sha256Hex(markdown);
      const existing = stored.get(key(kind, periodStart));
      if (existing === sha256) {
        results.push({ kind, periodStart, status: "skipped" });
        continue;
      }
      const now = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO daily_report_summaries (kind,period_start,period_end,markdown,sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(kind,period_start) DO UPDATE SET period_end=excluded.period_end,markdown=excluded.markdown,sha256=excluded.sha256,updated_at=excluded.updated_at`)
        .bind(kind, periodStart, summary.periodEnd, markdown, sha256, now, now).run();
      // 同じリクエストに同じ期間が2回あっても、2回目を正しく判定できるようにする
      stored.set(key(kind, periodStart), sha256);
      results.push({ kind, periodStart, status: existing ? "updated" : "created" });
    } catch (error) {
      console.error(error);
      results.push({ kind, periodStart, status: "error", error: error instanceof Error ? error.message : "保存に失敗しました。" });
    }
  }
  return results;
}

/** その期間のサマリを消す。無ければ false。 */
export async function deleteDailyReportSummary(kind: SummaryKind, periodStart: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM daily_report_summaries WHERE kind=? AND period_start=?").bind(kind, periodStart).run();
  return Number(result.meta.changes ?? 0) > 0;
}
