/** Manage Asset でどちらのウォレットを表示するか（純関数、D1 を読まない）。
 *
 *  "1" = 本番のデータ（env.DB）、"2" = ダミーデータ（env.DB_WALLET2、
 *  app/lib/manage-asset-wallet2.ts が本番から作る）。
 *
 *  どちらを表示するかは、Manage Asset の設定タブで選ぶ（portal_settings の manage_asset_wallet）。
 *  未設定なら "1"。 */

export type AssetWallet = "1" | "2";

export const ASSET_WALLETS: readonly AssetWallet[] = ["1", "2"];

/** portal_settings のキー。 */
export const ASSET_WALLET_SETTING = "manage_asset_wallet";

export function parseAssetWallet(value: unknown): AssetWallet | null {
  return value === "1" || value === "2" ? value : null;
}
