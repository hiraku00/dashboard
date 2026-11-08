import { portalSummary } from "@/app/lib/queries/portal";
import { route } from "@/app/lib/route";
import { assetWalletFor } from "@/app/lib/queries/asset-wallet";

export const GET = route(async () => {
  // ホームの資産合計も、Manage Asset の設定で選んだウォレットに合わせる（本番の合計がホームから見えないように）。
  return Response.json(await portalSummary((await assetWalletFor()).db));
});
