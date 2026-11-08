/** Manage Asset でどちらのウォレットを表示するか（純関数、D1 を読まない）。
 *
 *  "1" = 本番のデータ（env.DB）、"2" = ダミーデータ（env.DB_WALLET2、
 *  app/lib/manage-asset-wallet2.ts が本番から作る）。画面には「ウォレット1 / ウォレット2」
 *  としか出さない。
 *
 *  決め方: 画面上の切り替えが書く cookie（ブラウザを閉じるまで有効）があればそれ、
 *  なければ設定の既定値（portal_settings の manage_asset_wallet）、それもなければ "1"。 */

export type AssetWallet = "1" | "2";

export const ASSET_WALLETS: readonly AssetWallet[] = ["1", "2"];

/** 画面上の切り替えが書く cookie の名前。 */
export const ASSET_WALLET_COOKIE = "asset_wallet";

/** portal_settings のキー。 */
export const ASSET_WALLET_SETTING = "manage_asset_wallet";

export function parseAssetWallet(value: unknown): AssetWallet | null {
  return value === "1" || value === "2" ? value : null;
}

/** Cookie ヘッダーから、画面上の切り替えで選んだウォレットを読む。なければ null。 */
export function assetWalletFromCookieHeader(header: string | null | undefined): AssetWallet | null {
  for (const part of String(header ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === ASSET_WALLET_COOKIE) return parseAssetWallet(decodeURIComponent(value.join("=")));
  }
  return null;
}

/** cookie → 設定の既定値 → "1" の順に決める。 */
export function resolveAssetWallet(cookieChoice: AssetWallet | null, defaultChoice: AssetWallet | null): AssetWallet {
  return cookieChoice ?? defaultChoice ?? "1";
}
