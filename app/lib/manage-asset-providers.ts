/** 接続可能な取引所プロバイダの静的一覧。取引所の追加はMac側アプリの役目
 *  なので、ここは表示名解決だけに使う。`cloudflare:workers` を import しない
 *  クライアント安全なモジュールに置く必要がある -- queries/manage-asset.ts に
 *  置くと、それを import するだけの設定ビュー（client component）まで
 *  `env` ごとバンドルされてしまう。 */
export const PROVIDERS: Array<{ provider: string; label: string }> = [
  { provider: "binance", label: "Binance" },
  { provider: "bitflyer", label: "bitFlyer" },
  { provider: "bybit", label: "Bybit" },
  { provider: "aave", label: "Aave" },
];
