import { parseAssetWallet } from "@/app/lib/asset-wallet-choice";
import { defaultAssetWallet, saveDefaultAssetWallet } from "@/app/lib/queries/asset-wallet";
import { route } from "@/app/lib/route";

// Manage Asset の設定のうち、ポータル側で変えられるもの。今は既定で表示するウォレットだけ
// （"1" / "2"、app/lib/asset-wallet-choice.ts）。他の設定（取引所・ウォレットの追加や認証情報）は
// 今まで通り Mac 側アプリだけが書く。
export const GET = route(async () => Response.json({ defaultWallet: await defaultAssetWallet() }));

export const POST = route(async (request: Request) => {
  const body = await request.json().catch(() => null) as { defaultWallet?: unknown } | null;
  const wallet = parseAssetWallet(body?.defaultWallet);
  if (!wallet) return Response.json({ error: "defaultWalletは\"1\"か\"2\"です。" }, { status: 400 });
  await saveDefaultAssetWallet(wallet);
  return Response.json({ ok: true, defaultWallet: wallet });
});
