import type { AssetHistoryData, AssetStateData } from "./manage-asset-overview";
import type { AssetRow } from "@/app/lib/manage-asset-core";
import { assetHistory, assetState, lidoRewards, usdJpyRates } from "@/app/lib/queries/manage-asset";

export type ManageAssetInitial = {
  state: AssetStateData;
  history: AssetHistoryData;
  lidoRewards: AssetRow[];
  usdJpyRates: AssetRow[];
};

/** 5つの /manage-asset* ページの Server Component が共通で呼ぶ初期データ取得。
 *  どの view で開いても資産概要/保管場所/通貨推移が揃って表示できるよう、
 *  レガシーアプリの load() が起動時に読んでいたのと同じ4本をまとめて取る。 */
export async function fetchManageAssetInitial(): Promise<ManageAssetInitial | null> {
  // Deliberately not surfaced as an error on failure: ManageAssetApp renders
  // with no initial data, which makes it fall back to fetching everything
  // itself on the client, exactly like the pre-RSC app did. See the matching
  // comment in app/watch-list/page.tsx.
  try {
    const [state, history, rewards, rates] = await Promise.all([assetState(), assetHistory("90"), lidoRewards(), usdJpyRates()]);
    return { state: state as unknown as AssetStateData, history: history as unknown as AssetHistoryData, lidoRewards: rewards, usdJpyRates: rates };
  } catch {
    return null;
  }
}
