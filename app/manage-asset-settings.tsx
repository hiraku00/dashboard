"use client";

import { useEffect, useState } from "react";
import { PROVIDERS } from "@/app/lib/manage-asset-providers";
import { ASSET_WALLETS, parseAssetWallet, type AssetWallet } from "@/app/lib/asset-wallet-choice";
import { chooseAssetWallet } from "./manage-asset-wallet-switch";
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
export function SettingsView({ state, wallet, active }: { state: AssetStateData | null; wallet: AssetWallet; active: boolean }) {
  const sources = (state as { sources?: Array<Record<string, unknown>> } | null)?.sources ?? [];
  const wallets = (state as { wallets?: Array<Record<string, unknown>> } | null)?.wallets ?? [];

  return (
    <>
      <DefaultWalletSetting wallet={wallet} active={active} />
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

/** 既定で表示するウォレット（portal_settings、/api/manage-asset/settings）。
 *
 *  ここで変えるのは「ヘッダーで選んでいないときに出すウォレット」。保存したら、ヘッダーで
 *  選んだもの（ブラウザを閉じるまで有効な cookie）を消し、新しい既定値で読み込み直す。
 *  ポータル側で書き込める唯一の設定（他は Mac 側アプリが書く）。 */
function DefaultWalletSetting({ wallet, active }: { wallet: AssetWallet; active: boolean }) {
  const [saved, setSaved] = useState<AssetWallet | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");

  // 設定タブを初めて開いたときに一度だけ読む（他のタブでは要らない）。
  useEffect(() => {
    if (!active || saved) return;
    let cancelled = false;
    fetch("/api/manage-asset/settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => { if (!cancelled) setSaved(parseAssetWallet((body as { defaultWallet?: unknown } | null)?.defaultWallet) ?? "1"); })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [active, saved]);

  const save = async (next: AssetWallet) => {
    if (next === saved) return;
    setStatus("saving");
    try {
      const response = await fetch("/api/manage-asset/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultWallet: next }) });
      if (!response.ok) throw new Error(String(response.status));
      setSaved(next);
      chooseAssetWallet(null);
      if (next !== wallet) window.location.reload();
      else setStatus("idle");
    } catch {
      setStatus("error");
    }
  };

  return (
    <section className="asset-panel settings-panel">
      <div className="panel-heading">
        <div>
          <h2>表示するウォレット</h2>
          <span>Manage Assetを開いたときに表示するウォレットです。ヘッダーで切り替えた場合は、ブラウザを閉じるまでそちらを表示します。</span>
        </div>
      </div>
      <div className="settings-list">
        <div className="settings-item">
          <div className="asset-wallet-switch" role="radiogroup" aria-label="既定で表示するウォレット">
            {ASSET_WALLETS.map((id) => (
              <button key={id} type="button" role="radio" aria-checked={saved === id} className={saved === id ? "active" : ""} disabled={!saved || status === "saving"} onClick={() => save(id)}>
                ウォレット{id}
              </button>
            ))}
          </div>
          <span className={status === "error" ? "status-muted" : undefined}>
            {status === "error" ? "保存できませんでした。もう一度お試しください。" : status === "saving" ? "保存しています…" : saved ? `既定: ウォレット${saved}（表示中: ウォレット${wallet}）` : "読み込んでいます…"}
          </span>
        </div>
      </div>
    </section>
  );
}
