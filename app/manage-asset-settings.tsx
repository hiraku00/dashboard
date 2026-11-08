"use client";

import { useState } from "react";
import { PROVIDERS } from "@/app/lib/manage-asset-providers";
import { ASSET_WALLETS, type AssetWallet } from "@/app/lib/asset-wallet-choice";
import type { AssetStateData } from "./manage-asset-overview";

const providerLabels = new Map(PROVIDERS.map(({ provider, label }) => [provider, label]));

function shortenAddress(address: unknown): string {
  const value = String(address ?? "");
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/** 設定は読み取り専用。追加・認証情報の変更・ウォレット編集・削除フォームは
 *  レガシーUIにはあったが、それらが叩く /api/sources・/api/wallets 系の書き込み
 *  ルートはこのポータルに一度も実装されていない（Mac側アプリだけが書き込む）ため、
 *  この移行では意図的に持ち込まない。 */
export function SettingsView({ state, wallet }: { state: AssetStateData | null; wallet: AssetWallet }) {
  const sources = (state as { sources?: Array<Record<string, unknown>> } | null)?.sources ?? [];
  const wallets = (state as { wallets?: Array<Record<string, unknown>> } | null)?.wallets ?? [];

  return (
    <>
      <WalletSetting wallet={wallet} />
      <section className="asset-panel settings-panel">
        <div className="panel-heading">
          <div>
            <h2>接続済み取引所</h2>
            <span>秘密鍵・APIシークレットはMacのKeychainだけに保存されます。追加・認証情報の変更はMac側アプリで行います。</span>
          </div>
        </div>
        {sources.length ? (
          <div className="settings-list">
            {sources.map((source) => (
              <div className="settings-item" key={String(source.source_id)}>
                <div>
                  <strong>{String(source.display_name ?? "")}</strong>
                  <span>{providerLabels.get(String(source.provider)) ?? String(source.provider ?? "")}</span>
                </div>
                <span className={source.credential_configured ? "status-good" : "status-muted"}>
                  {source.credential_configured ? "認証情報あり" : "未設定"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted-copy">取引所はまだ登録されていません。</p>
        )}
      </section>

      <section className="asset-panel settings-panel">
        <div className="panel-heading">
          <div>
            <h2>ウォレット設定</h2>
            <span>公開アドレスだけを保存します。追加・変更はMac側アプリで行います。</span>
          </div>
        </div>
        {wallets.length ? (
          <div className="settings-list">
            {wallets.map((wallet) => (
              <div className="settings-item" key={String(wallet.wallet_id)}>
                <div>
                  <strong>{String(wallet.name ?? "")}</strong>
                  <span>{shortenAddress(wallet.address)}</span>
                </div>
                <span className={wallet.enabled === false ? "status-muted" : "status-good"}>
                  {wallet.enabled === false ? "無効" : "有効"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted-copy">ウォレットが未登録です。</p>
        )}
      </section>
    </>
  );
}

/** 表示するウォレット（portal_settings、/api/manage-asset/settings）。
 *
 *  Manage Asset とホームの資産合計は、ここで選んだウォレットの DB を読む。選んだら保存し、
 *  新しいウォレットのデータで読み込み直す（各タブが持っている取得済みのデータは前のウォレットのもの）。
 *  ポータル側で書き込める唯一の設定（他は Mac 側アプリが書く）。 */
function WalletSetting({ wallet }: { wallet: AssetWallet }) {
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");

  const save = async (next: AssetWallet) => {
    if (next === wallet) return;
    setStatus("saving");
    try {
      const response = await fetch("/api/manage-asset/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultWallet: next }) });
      if (!response.ok) throw new Error(String(response.status));
      window.location.reload();
    } catch {
      setStatus("error");
    }
  };

  return (
    <section className="asset-panel settings-panel">
      <div className="panel-heading">
        <div>
          <h2>表示するウォレット</h2>
          <span>Manage Assetとホームに表示するウォレットです。</span>
        </div>
      </div>
      <div className="settings-list">
        <div className="settings-item">
          <div className="asset-wallet-switch" role="radiogroup" aria-label="表示するウォレット">
            {ASSET_WALLETS.map((id) => (
              <button key={id} type="button" role="radio" aria-checked={wallet === id} className={wallet === id ? "active" : ""} disabled={status === "saving"} onClick={() => save(id)}>
                ウォレット{id}
              </button>
            ))}
          </div>
          {status !== "idle" && (
            <span className={status === "error" ? "status-muted" : undefined}>
              {status === "error" ? "保存できませんでした。もう一度お試しください。" : "保存しています…"}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
