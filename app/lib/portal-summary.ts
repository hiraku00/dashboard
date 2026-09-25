/** Pure decision logic for the portal summary's asset totals -- no D1, no
 *  I/O. Kept separate from app/lib/queries/portal.ts (which does the actual
 *  D1 calls) for the same reason as app/lib/watch-list-query.ts: a module
 *  that imports "cloudflare:workers" cannot be loaded under vitest's
 *  plain-Node "node" project at all, let alone unit tested. */

export type PortalSummary = {
  watch: { total: number; completed: number };
  textTube: { total: number; latest: { id: string; title: string; channel_name: string } | null };
  assets: { totalUsd: number; totalJpy: number; latestAt: string | null; sourceCount: number };
  todo: { total: number; completed: number };
  /** ちきりんオプチャ: 一覧に載る番組(ちきりんが関わるノート)の数と、その最新の投稿日時。 */
  openchat: { total: number; latestPostedAt: string | null };
};

/** The home page's asset totals, by the SAME definition Manage Asset uses, so the
 *  two screens can never show different numbers for "total assets".
 *
 *  - USD is the sum of every source's latest snapshot's own stored total
 *    (manage-asset-core's total()): "the snapshot's declared total is the truth".
 *    A snapshot whose stored total is 0 counts as 0 -- this used to fall back to
 *    summing that snapshot's positions, which made the home page higher by a few
 *    cents whenever DeBank's integer rounding stored a tiny wallet as $0
 *    (found on production: $0.65 across four such wallets).
 *  - JPY is that USD total times ONE rate, the newest snapshot's fx_usdjpy
 *    (manage-asset-core's latestFx()), which is how Manage Asset's "円換算" is
 *    computed. It used to sum each snapshot's own stored JPY, each converted at
 *    its own capture-time rate, which differed by ~10,000 yen on ~53M. Only when
 *    no snapshot carries a rate does it fall back to the sum of the stored JPY.
 *
 *  The rows are the same "latest snapshot per source" rows assetState() reads
 *  (source_id, display_name, source_type, captured_at, as_of_date, fx_usdjpy,
 *  total_usd, total_jpy), passed through the same legacy mappers so wallets and
 *  exchanges are split and read exactly as the Manage Asset page reads them.
 *  Imports use explicit .ts extensions for the same reason as
 *  app/lib/watch-list-item-input.ts. */
import { latestFx, total as totalUsdOf } from "./manage-asset-core.ts";
import { toLegacyExchangeSnapshot, toLegacyWalletSnapshot } from "./manage-asset-legacy.ts";

export function assetTotals(snapshots: Array<Record<string, unknown>>): { usd: number; jpy: number } {
  const isWallet = (row: Record<string, unknown>) => String(row.source_type).toLowerCase() === "wallet";
  const wallets = snapshots.filter(isWallet).map((row) => toLegacyWalletSnapshot(row, []));
  const exchanges = snapshots.filter((row) => !isWallet(row)).map((row) => toLegacyExchangeSnapshot(row, []));
  const usd = totalUsdOf(wallets, exchanges);
  const fx = latestFx(wallets, exchanges);
  if (fx) return { usd, jpy: usd * fx.rate };
  return { usd, jpy: snapshots.reduce((sum, row) => sum + (Number(row.total_jpy) || 0), 0) };
}
