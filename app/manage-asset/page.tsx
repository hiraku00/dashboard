import { ManageAssetApp } from "../manage-asset-app";
import type { AssetHistoryData, AssetStateData } from "../manage-asset-overview";
import { assetHistory, assetState } from "@/app/lib/queries/manage-asset";

// Server Component: fetches the asset state and 90-day history directly from D1
// at render time, the same way app/watch-list/page.tsx does (see
// app/lib/queries/manage-asset.ts for the shared query -- /api/manage-asset/state
// and /history call the same functions).
export default async function ManageAssetPage() {
  const initial = await fetchInitial();
  return <ManageAssetApp initialView="overview" initialState={initial?.state ?? null} initialHistory={initial?.history ?? null} />;
}

async function fetchInitial() {
  // Deliberately not surfaced as an error on failure: AssetOverview renders with
  // no initial data, which makes it fall back to fetching /api/manage-asset/state
  // and /history itself on the client, exactly like the pre-RSC app did. See the
  // matching comment in app/watch-list/page.tsx.
  try {
    const [state, history] = await Promise.all([assetState(), assetHistory("90")]);
    return { state: state as unknown as AssetStateData, history: history as unknown as AssetHistoryData };
  } catch {
    return null;
  }
}
