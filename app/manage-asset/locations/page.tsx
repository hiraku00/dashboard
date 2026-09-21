import { ManageAssetApp } from "../../manage-asset-app";
import { fetchManageAssetInitial } from "../../manage-asset-initial";

export default async function ManageAssetLocationsPage() {
  const initial = await fetchManageAssetInitial();
  return (
    <ManageAssetApp
      initialView="locations"
      initialState={initial?.state ?? null}
      initialHistory={initial?.history ?? null}
      initialHistoryDetail={initial?.historyDetail ?? false}
      initialLidoRewards={initial?.lidoRewards ?? null}
      initialUsdJpyRates={initial?.usdJpyRates ?? null}
      initialLatestSyncRun={initial?.latestSyncRun ?? null}
    />
  );
}
