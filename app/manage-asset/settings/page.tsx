import { ManageAssetApp } from "../../manage-asset-app";
import { fetchManageAssetInitial } from "../../manage-asset-initial";

export default async function ManageAssetSettingsPage() {
  const initial = await fetchManageAssetInitial();
  return (
    <ManageAssetApp
      initialView="settings"
      initialState={initial?.state ?? null}
      initialHistory={initial?.history ?? null}
      initialLidoRewards={initial?.lidoRewards ?? null}
      initialUsdJpyRates={initial?.usdJpyRates ?? null}
      initialLatestSyncRun={initial?.latestSyncRun ?? null}
    />
  );
}
