import { assetState } from "@/app/lib/queries/manage-asset";
import { route } from "@/app/lib/route";

// The read logic lives in app/lib/queries/manage-asset.ts so this endpoint and
// the /manage-asset page's Server Component produce the same shape.
export const GET = route(async () => Response.json(await assetState()));
