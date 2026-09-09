import { PROVIDERS } from "@/app/lib/manage-asset-providers";
import { route } from "@/app/lib/route";
export const GET = route(async () => Response.json({ providers: PROVIDERS }));
