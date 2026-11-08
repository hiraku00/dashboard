/** ポータルTOP (app/page.tsx -> PortalHome) の集計（D1呼び出しを伴う
 *  オーケストレーション層）。app/api/portal/summary/route.ts と、後続で
 *  RSC化するポータルTOPページの両方がこれを呼ぶ想定 -- 正はここに一本化
 *  する。
 *
 *  純粋な決定ロジック（総額のフォールバック判定）は
 *  app/lib/portal-summary.ts に分離してある。理由は
 *  app/lib/watch-list-query.ts と同じ。 */
import { env } from "cloudflare:workers";
import { ensureSchema, ensureWallet2Schema } from "@/db";
import { ROOM } from "@/app/lib/openchat-query";
import { assetTotals, type PortalSummary } from "@/app/lib/portal-summary";
import { LATEST_SNAPSHOT_JOIN } from "@/app/lib/manage-asset-latest-snapshot";
import { weekDates } from "@/app/lib/daily-report-summary";
import { todoDate } from "@/app/lib/todo-date";

export type { PortalSummary };

/** "Latest snapshot per source", via the same JOIN assetState() uses in
 *  app/lib/queries/manage-asset.ts, so the totals come out of the same rows
 *  Manage Asset totals -- see manage-asset-latest-snapshot.ts. */
const LATEST_SNAPSHOTS = `SELECT s.id, s.source_id, s.captured_at, s.as_of_date, s.fx_usdjpy, s.total_usd, s.total_jpy, a.source_type, a.display_name
  ${LATEST_SNAPSHOT_JOIN}
  ORDER BY s.total_usd DESC`;

/** `assetDb` は資産の合計を読む DB（Manage Asset で表示中のウォレット、app/lib/queries/asset-wallet.ts）。
 *  本番（env.DB）なら、従来どおり全部を1回の batch で読む。ウォレット2は別の DB で、
 *  batch は1つの DB の中でしか組めないので、資産の3つだけを別の batch にして同時に読む。 */
export async function portalSummary(assetDb: D1Database = env.DB): Promise<PortalSummary> {
  await ensureSchema({ seed: false });
  const sameDb = assetDb === env.DB;
  if (!sameDb) await ensureWallet2Schema();
  const week = weekDates(todoDate());
  // One D1 round trip for everything (two in parallel when the assets come from wallet 2).
  const assetStatements = (db: D1Database) => [
    db.prepare("SELECT MAX(captured_at) AS latest_at FROM asset_snapshots"),
    db.prepare("SELECT COUNT(*) AS count FROM asset_sources WHERE enabled=1"),
    db.prepare(LATEST_SNAPSHOTS),
  ];
  const [mainResults, separateAssetResults] = await Promise.all([env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND status='completed'"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM text_tube_videos WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT id,title,channel_name FROM text_tube_videos WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM todo_tasks WHERE deleted_at IS NULL AND occurrence_date = strftime('%Y-%m-%d','now','+7 hours')"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM todo_tasks WHERE deleted_at IS NULL AND occurrence_date = strftime('%Y-%m-%d','now','+7 hours') AND completed_at IS NOT NULL"),
    // /chikirin の一覧に載るノートと同じ条件(app/lib/openchat-query.ts の buildProgramsFilter の既定、kind=all)。
    // 2026-09-27: 一覧が全スレッドを出すようになった(#172)のに合わせて、この集計も全スレッドにする
    // (以前はちきりんが関わるスレッドだけを数えており、一覧の総数・最新日時とずれていた)。
    env.DB.prepare("SELECT COUNT(*) AS count, MAX(posted_at) AS latest_at FROM openchat_notes WHERE room = ? AND deleted_at IS NULL").bind(ROOM),
    env.DB.prepare("SELECT COUNT(*) AS count, MAX(report_date) AS latest_date FROM daily_reports"),
    // 今週(月曜始まり、To Do と同じ Asia/Bangkok の日付)の日報の日数と活動時間。ホームのカードの1日平均に使う
    env.DB.prepare("SELECT COUNT(DISTINCT report_date) AS days, COALESCE(SUM(minutes),0) AS minutes FROM daily_report_tag_days WHERE report_date BETWEEN ? AND ?").bind(week[0], week[6]),
    ...(sameDb ? assetStatements(env.DB) : []),
  ]), sameDb ? Promise.resolve(null) : assetDb.batch<Record<string, unknown>>(assetStatements(assetDb))]);
  const [watch, completed, textTube, latestVideo, todoTotal, todoCompleted, openchat, dailyReport, dailyReportWeek, ...sameDbAssets] = mainResults;
  const [latestAsset, sources, latestSnapshotResult] = separateAssetResults ?? sameDbAssets;
  const latestSnapshots = (latestSnapshotResult.results ?? []) as Array<Record<string, unknown>>;
  const totals = assetTotals(latestSnapshots);
  const number = (result: D1Result<Record<string, unknown>>, key: string) => Number(result.results?.[0]?.[key] ?? 0);
  return {
    watch: { total: number(watch, "count"), completed: number(completed, "count") },
    textTube: { total: number(textTube, "count"), latest: (latestVideo.results?.[0] as PortalSummary["textTube"]["latest"]) ?? null },
    assets: { totalUsd: totals.usd, totalJpy: totals.jpy, latestAt: (latestAsset.results?.[0]?.latest_at as string | undefined) ?? null, sourceCount: number(sources, "count") },
    todo: { total: number(todoTotal, "count"), completed: number(todoCompleted, "count") },
    openchat: { total: number(openchat, "count"), latestPostedAt: (openchat.results?.[0]?.latest_at as string | undefined) ?? null },
    dailyReport: {
      total: number(dailyReport, "count"),
      latestDate: (dailyReport.results?.[0]?.latest_date as string | null | undefined) ?? null,
      weekDays: number(dailyReportWeek, "days"),
      weekMinutes: number(dailyReportWeek, "minutes"),
    },
  };
}
