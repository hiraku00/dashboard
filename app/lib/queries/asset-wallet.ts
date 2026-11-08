/** Manage Asset とホームが、どちらのウォレットの DB を読むかを決める（D1 を読む側）。
 *  決め方そのものは app/lib/asset-wallet-choice.ts（純関数）にある。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { ASSET_WALLET_SETTING, parseAssetWallet, type AssetWallet } from "@/app/lib/asset-wallet-choice";

/** 設定で選んだウォレット。未設定や読めない値は "1"（本番）。 */
export async function defaultAssetWallet(): Promise<AssetWallet> {
  await ensureSchema({ seed: false });
  const row = (await env.DB.prepare("SELECT value FROM portal_settings WHERE key=?").bind(ASSET_WALLET_SETTING).all<{ value: string }>()).results?.[0];
  return parseAssetWallet(row?.value) ?? "1";
}

export async function saveDefaultAssetWallet(wallet: AssetWallet): Promise<void> {
  await ensureSchema({ seed: false });
  await env.DB.prepare("INSERT INTO portal_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .bind(ASSET_WALLET_SETTING, wallet, new Date().toISOString()).run();
}

/** そのウォレットの資産テーブルを持つ DB。 */
export function assetDatabase(wallet: AssetWallet): D1Database {
  return wallet === "2" ? env.DB_WALLET2 : env.DB;
}

/** 設定で選んだウォレットと、その DB。 */
export async function assetWalletFor(): Promise<{ wallet: AssetWallet; db: D1Database }> {
  const wallet = await defaultAssetWallet();
  return { wallet, db: assetDatabase(wallet) };
}
