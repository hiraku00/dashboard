import type { AssetHistoryData, AssetStateData } from "./manage-asset-overview";
import type { AssetRow } from "@/app/lib/manage-asset-core";
import { assetHistory, assetState, latestSyncRun, lidoRewards, usdJpyRates } from "@/app/lib/queries/manage-asset";

export type ManageAssetInitial = {
  state: AssetStateData;
  history: AssetHistoryData;
  /** true: full rows (tokens, positions -- what the per-currency history reads).
   *  false: the asset overview's summary form (ids, dates, totals), ~1/6 the size. */
  historyDetail: boolean;
  /** null unless the currency view asked for them (see `currency` below). */
  lidoRewards: AssetRow[] | null;
  usdJpyRates: AssetRow[] | null;
  latestSyncRun: AssetRow | null;
};

/** 5つの /manage-asset* ページの Server Component が共通で呼ぶ初期データ取得。
 *
 *  以前は、どの view で開いても通貨推移まで揃うよう、全部を1回で取っていた
 *  (約1.2MB、うち履歴が896KB)。しかし最初に開く資産概要は、履歴から
 *  ID・日付・合計しか読まず、Lidoの報酬・為替・履歴の明細は通貨推移だけが
 *  使う。そこで通常は、state と「合計のみ」の履歴(約150KB)と最終同期だけを
 *  返し、通貨推移用のデータは、そのタブを開いたときにクライアントが取る
 *  (app/manage-asset-app.tsx)。通貨推移を最初に開くルート
 *  (/manage-asset/currencies、`currency: true`)は、待たせないよう、従来どおり
 *  全部を返す。 */
export async function fetchManageAssetInitial({ currency = false }: { currency?: boolean } = {}): Promise<ManageAssetInitial | null> {
  // Deliberately not surfaced as an error on failure: ManageAssetApp renders
  // with no initial data, which makes it fall back to fetching everything
  // itself on the client, exactly like the pre-RSC app did. See the matching
  // comment in app/watch-list/page.tsx.
  try {
    if (currency) {
      const [state, history, rewards, rates, run] = await Promise.all([assetState(), assetHistory("90"), lidoRewards(), usdJpyRates(), latestSyncRun()]);
      return { state: state as unknown as AssetStateData, history: history as unknown as AssetHistoryData, historyDetail: true, lidoRewards: rewards, usdJpyRates: rates, latestSyncRun: run };
    }
    const [state, history, run] = await Promise.all([assetState(), assetHistory("90", { summary: true }), latestSyncRun()]);
    return { state: state as unknown as AssetStateData, history: history as unknown as AssetHistoryData, historyDetail: false, lidoRewards: null, usdJpyRates: null, latestSyncRun: run };
  } catch {
    return null;
  }
}
