import { ManageAssetApp } from "../manage-asset-app";
import { fetchManageAssetInitial } from "../manage-asset-initial";

// Server Component: fetches state/history/lidoRewards/usdJpyRates directly
// from D1 at render time, the same way app/watch-list/page.tsx does (see
// app/lib/queries/manage-asset.ts for the shared query -- the /api/manage-asset
// routes call the same functions). Shared by all /manage-asset* pages so any
// view can render fully seeded on first paint.
export default async function ManageAssetPage() {
  const initial = await fetchManageAssetInitial();
  return (
    <ManageAssetApp
      initialView="overview"
      initialState={initial?.state ?? null}
      initialHistory={initial?.history ?? null}
      initialLidoRewards={initial?.lidoRewards ?? null}
      initialUsdJpyRates={initial?.usdJpyRates ?? null}
      initialLatestSyncRun={initial?.latestSyncRun ?? null}
    />
  );
}
