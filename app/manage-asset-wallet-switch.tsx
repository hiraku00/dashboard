"use client";

import { ASSET_WALLET_COOKIE, ASSET_WALLETS, type AssetWallet } from "@/app/lib/asset-wallet-choice";

/** 画面上の選択を、ブラウザを閉じるまで有効な cookie に書く（期限を付けない）。
 *  消すと、設定の既定値に戻る。 */
export function chooseAssetWallet(wallet: AssetWallet | null) {
  document.cookie = wallet
    ? `${ASSET_WALLET_COOKIE}=${wallet}; path=/; SameSite=Lax`
    : `${ASSET_WALLET_COOKIE}=; path=/; SameSite=Lax; max-age=0`;
}

/** Manage Asset のヘッダーの「ウォレット1 / ウォレット2」の切り替え。
 *
 *  どちらを選んでも、画面・API・ホームの資産合計は同じ cookie を読んで DB を選ぶ
 *  （app/lib/queries/asset-wallet.ts）。各タブが持っている取得済みのデータは前のウォレットの
 *  ものなので、選んだら読み込み直す。 */
export function AssetWalletSwitch({ wallet }: { wallet: AssetWallet }) {
  return (
    <span className="asset-wallet-switch" role="group" aria-label="ウォレット">
      {ASSET_WALLETS.map((id) => (
        <button
          key={id}
          type="button"
          className={wallet === id ? "active" : ""}
          aria-pressed={wallet === id}
          onClick={() => {
            if (wallet === id) return;
            chooseAssetWallet(id);
            window.location.reload();
          }}
        >
          ウォレット{id}
        </button>
      ))}
    </span>
  );
}
