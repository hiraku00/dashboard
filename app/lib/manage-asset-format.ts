/** Manage Asset の表示整形ヘルパ。public/manage-asset-original/app-ui.js の
 *  fixed/money/yen/formatQuantity/formatDate/shortDate/localDate と、
 *  display-config.js の桁数設定を逐語移植したもの。クライアント島でもサーバーでも
 *  使える純粋関数（cloudflare:workers を import しない）。 */

// display-config.js の DisplayConfig 相当。
const fiatDecimals: Record<string, number> = { USD: 2, JPY: 0 };
const tokenDecimals = {
  defaults: { balance: 2, change: 4 } as Record<string, number>,
  currencyOverrides: {
    stETH: { balance: 4, change: 5 },
    BTC: { balance: 5, change: 6 },
    USDT: { balance: 2, change: 3 },
    ETH: { balance: 4, change: 5 },
  } as Record<string, Record<string, number>>,
};
export const metricDecimals = { fxRate: 2, apr: 2 };

/** 文字列中の $ / , を除いて数値化。取れなければ 0（Core.number と同じ）。 */
export function number(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

// Pinned to a fixed locale (not the runtime default): the same value must
// format identically on the server and in the browser, or a value rendered in
// a Server Component and re-rendered on hydration triggers a mismatch. en-US
// grouping (1,234.50) matches what the legacy app showed a ja-JP browser.
export const fixed = (value: unknown, digits: number): string =>
  Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fiatDigits = (currency: string): number => fiatDecimals[currency] ?? (currency === "JPY" ? 0 : 2);

export const money = (value: unknown): string => `$${fixed(number(value), fiatDigits("USD"))}`;
export const yen = (value: unknown): string => `¥${fixed(number(value), fiatDigits("JPY"))}`;

export const tokenDigits = (symbol: string, key: string): number =>
  tokenDecimals.currencyOverrides?.[symbol]?.[key] ?? tokenDecimals.defaults?.[key] ?? 2;

export const formatQuantity = (value: number | null | undefined, symbol: string): string =>
  value == null ? "—" : fixed(value, tokenDigits(symbol, "balance"));

/** 通貨推移テーブルの数量セル（balance/change で桁数が変わる）。 */
export const currencyQuantity = (value: number | null | undefined, symbol: string, key: "balance" | "change"): string =>
  value == null ? "—" : fixed(value, tokenDigits(symbol, key));

/** 通貨推移テーブルの USD/JPY セル。currency は "USD" | "JPY"。 */
export const currencyFiat = (value: number | null | undefined, currency: "USD" | "JPY"): string =>
  value == null ? "—" : `${currency === "USD" ? "$" : "¥"}${fixed(value, fiatDigits(currency))}`;

export const signedCurrencyFiat = (value: number | null | undefined, currency: "USD" | "JPY"): string =>
  value == null ? "—" : `${value > 0 ? "+" : value < 0 ? "-" : ""}${currencyFiat(Math.abs(value), currency)}`;

export const formatDate = (value: unknown): string =>
  value ? new Date(String(value)).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" }) : "—";

export const shortDate = (value: unknown): string => {
  const parts = String(value).split("-");
  return parts.length >= 3 ? `${Number(parts.at(-2))}/${Number(parts.at(-1))}` : String(value);
};

/** ブラウザのタイムゾーン基準の今日（YYYY-MM-DD）。「古いデータ」判定に使う。 */
export const localDate = (): string => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
