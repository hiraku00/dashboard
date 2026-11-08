import { assetState } from "@/app/lib/queries/manage-asset";
import { route } from "@/app/lib/route";
import { assetWalletFor } from "@/app/lib/queries/asset-wallet";

// The read logic lives in app/lib/queries/manage-asset.ts so this endpoint and
// the /manage-asset page's Server Component produce the same shape.
// 設定で選んだウォレットの DB を読む。app/lib/queries/asset-wallet.ts 参照。
export const GET = route(async () => Response.json(await assetState((await assetWalletFor()).db)));
