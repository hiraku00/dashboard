/** グラフ期間の絞り込みと間引き。app-ui.js の assetPeriodRows/periodRows と
 *  sampledAssetTrendPoints/sampledChartPoints/samplePoints を統合したもの
 *  （資産推移・通貨推移の両方で同じ規則を使うため共通化）。 */

export type Period = "7" | "30" | "90" | "all";
export const periods: [Period, string][] = [["7", "7日"], ["30", "30日"], ["90", "90日"], ["all", "全期間"]];

/** 期間で対象日を絞る（最終日から period-1 日ぶん、all はそのまま）。 */
export function periodRows<T extends { date: string }>(rows: T[], period: Period): T[] {
  if (period === "all" || !rows.length) return rows;
  const cutoff = new Date(`${rows.at(-1)!.date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - Number(period) + 1);
  return rows.filter((row) => new Date(`${row.date}T00:00:00Z`) >= cutoff);
}

/** 30/90/all を選んだときに 15/18/24 点へ間引く（7日は間引かない）。 */
export function pointLimit(period: Period): number {
  return period === "7" ? Infinity : period === "30" ? 15 : period === "90" ? 18 : 24;
}

export function samplePoints<T>(points: T[], period: Period): T[] {
  const limit = pointLimit(period);
  if (points.length <= limit) return points;
  return Array.from({ length: limit }, (_, index) => points[Math.round((index * (points.length - 1)) / (limit - 1))]);
}

/** ?days= の再取得要否だけを判定する（実フェッチは呼び出し側）。 */
export function neededDays(period: Period): number {
  return period === "all" ? Infinity : Number(period);
}

/** Whether the history in hand stops short of the date stETH's two sources are
 *  joined on, so its chart would be wrong.
 *
 *  stETH's history is the Lido CSV (which ends on a fixed day) continued by
 *  snapshots from the migration boundary date on. A period window that starts
 *  AFTER that date drops the days in between, and the first snapshot row then
 *  carries the whole gap as one day's reward -- a spike that grows a little every
 *  day the window slides further past the boundary. So stETH needs the full
 *  history, but only when the window really is short of it: while the data still
 *  starts on or before the boundary, nothing more is needed.
 *
 *  `historyDays` is the window that was fetched (Infinity for the full history,
 *  which can never be short of it). Dates are compared as YYYY-MM-DD strings. */
export function historyMissesCutover(
  history: { snapshots: Array<Record<string, unknown>>; exchange_snapshots: Array<Record<string, unknown>> } | null,
  historyDays: number,
  cutoverDate: string,
): boolean {
  if (!history || historyDays === Infinity) return false;
  const dates = [...history.snapshots, ...history.exchange_snapshots].map((row) => String(row.as_of_date ?? "").slice(0, 10)).filter(Boolean);
  if (!dates.length) return false;
  return dates.reduce((oldest, date) => (date < oldest ? date : oldest)) > cutoverDate;
}
