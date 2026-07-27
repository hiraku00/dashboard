"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PortalHeader } from "./portal-nav";

type Row = Record<string, any>;
type State = { sources: Row[]; snapshots: Row[]; history: Row[]; runs: Row[]; positions: Row[]; holdings: Row[] };
type Historical = { points?: { date: string; value: number }[]; holdings?: { symbol: string; quantity: number; valueUsd: number; unitPriceUsd: number | null; locations: string[] }[]; symbols?: string[]; currencies?: Record<string, Row[]>; lido_rewards: Row[]; rates: Row[] };
type View = "overview" | "locations" | "currencies" | "sync" | "settings";

const usd = (value: unknown) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(value ?? 0));
const yen = (value: unknown) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(Number(value ?? 0));
const date = (value: unknown) => value ? new Date(String(value)).toLocaleString("ja-JP") : "—";
const colors = ["#0A84FF", "#5856D6", "#30A46C", "#C16B16", "#AF52DE", "#6E6E73"];
const tabs: [View, string, string][] = [["overview", "資産概要", "/manage-asset"], ["locations", "保管場所", "/manage-asset/locations"], ["currencies", "通貨推移", "/manage-asset/currencies"], ["sync", "データ更新", "/manage-asset/sync"], ["settings", "設定", "/manage-asset/settings"]];

function periodRows<T extends { date: string }>(rows: T[], period: string) {
  if (period === "all" || !rows.length) return rows;
  const end = new Date(`${rows.at(-1)!.date}T00:00:00Z`);
  const days = Number(period);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - days + 1);
  return rows.filter((row) => new Date(`${row.date}T00:00:00Z`) >= start);
}

export function ManageAssetApp({ initialView = "overview" }: { initialView?: View }) {
  const [state, setState] = useState<State | null>(null);
  const [history, setHistory] = useState<Historical | null>(null);
  const [error, setError] = useState("");
  async function load() {
    try {
      const [stateResponse, historyResponse] = await Promise.all([fetch("/api/manage-asset/state"), fetch("/api/manage-asset/history")]);
      if (!stateResponse.ok || !historyResponse.ok) throw new Error("資産データを読み込めませんでした。");
      setState(await stateResponse.json()); setHistory(await historyResponse.json()); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "資産データを読み込めませんでした。"); }
  }
  useEffect(() => { load(); }, []);
  return <main className="portal-shell asset-workspace">
    <PortalHeader kicker="PRIVATE LEDGER" title="Manage Asset" active="/manage-asset" />
    <div className="page-toolbar"><p>Macで取得した読み取り専用スナップショットを表示します。秘密情報はこのポータルへ保存しません。</p><span className="sync-pill">{state?.runs[0] ? `最終同期 ${date(state.runs[0].received_at)}` : "同期情報を読み込み中"}</span></div>
    <nav className="asset-tabs" aria-label="Manage Asset メニュー">{tabs.map(([key, label, href]) => <Link key={key} className={initialView === key ? "active" : ""} href={href}>{label}</Link>)}</nav>
    {error && <p className="notice" role="alert">{error}</p>}
    {initialView === "overview" && <Overview state={state} history={history} />}
    {initialView === "locations" && <Locations state={state} />}
    {initialView === "currencies" && <Currencies state={state} history={history} />}
    {initialView === "sync" && <Sync state={state} reload={load} />}
    {initialView === "settings" && <Settings state={state} />}
  </main>;
}

function Overview({ state, history }: { state: State | null; history: Historical | null }) {
  const [period, setPeriod] = useState("30");
  const total = state?.snapshots.reduce((sum, row) => sum + Number(row.total_usd ?? 0), 0) ?? 0;
  const points = periodRows(history?.points ?? [], period);
  const allPoints = history?.points ?? [];
  const previous = allPoints.length > 1 ? allPoints.at(-2)?.value ?? null : null;
  const delta = previous == null ? null : total - previous;
  const holdings = state?.holdings ?? [];
  const fx = Number(history?.rates.at(-1)?.rate ?? 0) || null;
  return <>
    <section className="asset-hero"><div><p className="app-kicker">TOTAL PORTFOLIO</p><strong>{usd(total)}</strong><p>{fx ? `円換算 ${yen(total * fx)}` : "円換算レート未取得"}</p></div><div className="asset-freshness"><span>前回保存比</span><strong>{delta == null ? "比較データなし" : `${delta >= 0 ? "+" : "−"}${usd(Math.abs(delta))}`}</strong><span>{fx ? `USD/JPY ${fx.toFixed(2)}` : "USD/JPY —"}</span></div></section>
    <section className="asset-dashboard-grid"><section className="asset-panel"><div className="panel-heading"><div><h2>資産推移</h2><span>{points.length ? `${points[0].date} — ${points.at(-1)?.date}` : "履歴なし"}</span></div><PeriodControl value={period} onChange={setPeriod} /></div><TrendChart points={points} fx={fx} /></section><section className="asset-panel"><div className="panel-heading"><div><h2>資産配分</h2><span>総額との差は明示します</span></div></div><Allocation holdings={holdings} total={total} /></section></section>
    <section className="asset-panel asset-table-panel"><div className="panel-heading"><div><h2>保有資産</h2><span>DeFi内のstETHを含む、保管場所横断の集計です。</span></div></div><Holdings rows={holdings} total={total} /></section>
  </>;
}

function PeriodControl({ value, onChange }: { value: string; onChange: (value: string) => void }) { return <div className="period-control" aria-label="グラフ期間">{[["7", "7日"], ["30", "30日"], ["90", "90日"], ["all", "全期間"]].map(([key, label]) => <button type="button" className={value === key ? "active" : ""} onClick={() => onChange(key)} key={key}>{label}</button>)}</div>; }

function TrendChart({ points, fx }: { points: { date: string; value: number }[]; fx: number | null }) {
  if (points.length < 2) return <div className="asset-empty">異なる記録日の保存が2回以上必要です。</div>;
  const values = points.map((point) => point.value); const min = Math.max(0, Math.min(...values) - Math.max((Math.max(...values) - Math.min(...values)) * .12, 1)); const max = Math.max(...values) + Math.max((Math.max(...values) - Math.min(...values)) * .12, 1); const span = Math.max(max - min, 1);
  const x = (index: number) => 60 + index * 620 / (points.length - 1); const y = (value: number) => 228 - (value - min) / span * 184; const path = points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.value)}`).join(" ");
  return <div className="asset-chart"><svg viewBox="0 0 720 270" role="img" aria-label="資産推移"><path className="asset-chart-area" d={`${path} L680 228 L60 228Z`} /><path className="asset-chart-line" d={path} />{points.map((point, index) => <g key={point.date}><circle className="asset-chart-dot" cx={x(index)} cy={y(point.value)} r="5" tabIndex={0}><title>{`${point.date} / USD ${usd(point.value)}${fx ? ` / JPY ${yen(point.value * fx)}` : ""}`}</title></circle>{(index === 0 || index === points.length - 1 || index % Math.ceil(points.length / 6) === 0) && <text x={x(index)} y="252" textAnchor="middle">{point.date.slice(5)}</text>}</g>)}</svg></div>;
}

function Allocation({ holdings, total }: { holdings: Row[]; total: number }) {
  const shown = holdings.filter((row) => Number(row.value_usd) >= 1).slice(0, 5); const rest = holdings.filter((row) => !shown.includes(row)).reduce((sum, row) => sum + Number(row.value_usd ?? 0), 0); if (rest > .5) shown.push({ symbol: "その他", value_usd: rest });
  const detail = shown.reduce((sum, row) => sum + Number(row.value_usd ?? 0), 0); const gap = total - detail; const data = gap > .5 ? [...shown, { symbol: "内訳未解析", value_usd: gap }] : shown; const sum = data.reduce((value, row) => value + Number(row.value_usd), 0) || 1; let angle = -Math.PI / 2;
  return <div className="allocation"><svg viewBox="0 0 250 250" aria-label="資産配分">{data.map((row, index) => { const next = angle + Number(row.value_usd) / sum * Math.PI * 2; const a = [125 + 95 * Math.cos(angle), 125 + 95 * Math.sin(angle)]; const b = [125 + 95 * Math.cos(next), 125 + 95 * Math.sin(next)]; const large = next - angle > Math.PI ? 1 : 0; const d = `M125 125 L${a[0]} ${a[1]} A95 95 0 ${large} 1 ${b[0]} ${b[1]} Z`; angle = next; return <path key={row.symbol} d={d} fill={colors[index]} />; })}<circle cx="125" cy="125" r="54" fill="var(--surface-solid)" /><text x="125" y="121" textAnchor="middle" className="allocation-total">{usd(total)}</text><text x="125" y="141" textAnchor="middle" className="allocation-caption">合算総額</text></svg><div className="allocation-list">{data.map((row, index) => <div className="allocation-row" key={row.symbol}><i style={{ backgroundColor: colors[index] }} /><strong>{row.symbol}</strong><span>{usd(row.value_usd)} · {(Number(row.value_usd) / Math.max(total, 1) * 100).toFixed(1)}%</span></div>)}</div></div>;
}

function Holdings({ rows, total }: { rows: Row[]; total: number }) { return <div className="table-scroll"><table className="asset-table"><thead><tr><th>資産</th><th>合計数量</th><th>単価</th><th>評価額</th><th>比率</th><th>主な保管場所</th></tr></thead><tbody>{rows.filter((row) => Number(row.value_usd) >= 1).map((row) => <tr key={row.symbol}><td><strong>{row.symbol}</strong></td><td>{Number(row.quantity ?? 0).toLocaleString("en-US", { maximumFractionDigits: row.symbol === "stETH" ? 4 : 8 })}</td><td>{row.unit_price_usd ? usd(row.unit_price_usd) : "—"}</td><td>{usd(row.value_usd)}</td><td>{(Number(row.value_usd) / Math.max(total, 1) * 100).toFixed(1)}%</td><td>{(row.locations ?? []).slice(0, 3).map((location: Row | string, index: number) => <span className="tag" key={index}>{typeof location === "string" ? location : location.display_name ?? location.provider}</span>)}</td></tr>)}</tbody></table></div>; }

function Locations({ state }: { state: State | null }) { return <section className="asset-panel asset-table-panel"><div className="panel-heading"><div><h2>保管場所</h2><span>ウォレット、DeFi、取引所の最新取得結果です。</span></div></div><div className="table-scroll"><table className="asset-table"><thead><tr><th>保管場所</th><th>種別</th><th>評価額</th><th>最終取得</th><th>状態</th></tr></thead><tbody>{state?.snapshots.map((row) => <tr key={row.id}><td><strong>{row.display_name ?? row.source_id}</strong></td><td>{row.provider}</td><td>{usd(row.total_usd)}</td><td>{date(row.captured_at)}</td><td><span className="status-good">最新</span></td></tr>)}</tbody></table></div></section>; }

function Currencies({ state, history }: { state: State | null; history: Historical | null }) {
  const symbols = useMemo(() => [...new Set([...(history?.symbols ?? []), ...(state?.holdings ?? []).map((row) => String(row.symbol))])].sort((a, b) => a.localeCompare(b)), [history, state]);
  const [symbol, setSymbol] = useState("stETH"); const [view, setView] = useState("balance"); const [period, setPeriod] = useState("30");
  useEffect(() => { if (!symbols.includes(symbol) && symbols.length) setSymbol(symbols.includes("stETH") ? "stETH" : symbols[0]); }, [symbols, symbol]);
  const rows = periodRows(history?.currencies?.[symbol] ?? [], period); const latest = rows.at(-1); const reward = rows.reduce((sum, row) => sum + Number(row.change ?? row.delta ?? 0), 0); const values = rows.map((row) => view === "balance" ? Number(row.balanceUsd ?? row.valueUsd ?? row.balance ?? 0) : Number(row.usd ?? row.change ?? row.delta ?? 0));
  return <><section className="asset-panel currency-controls"><label>通貨<select value={symbol} onChange={(event) => setSymbol(event.target.value)}>{symbols.map((item) => <option key={item}>{item}</option>)}</select></label><label>表示<select value={view} onChange={(event) => setView(event.target.value)}><option value="balance">資産推移</option><option value="change">日次増加量</option></select></label><div><span>期間</span><PeriodControl value={period} onChange={setPeriod} /></div></section><section className="asset-dashboard-grid"><section className="asset-panel"><div className="panel-heading"><div><h2>{symbol} {view === "balance" ? "資産推移" : "日次増加量"}</h2><span>{rows.length} records</span></div></div><CurrencyChart values={values} rows={rows} type={view} symbol={symbol} /></section><section className="asset-panel currency-summary"><span>現在残高</span><strong>{symbol === "stETH" ? `${Number(latest?.balance ?? 0).toFixed(4)} stETH` : usd(latest?.balanceUsd ?? latest?.valueUsd ?? 0)}</strong><span>{symbol === "stETH" ? "期間報酬" : "期間増加分"}</span><strong>{symbol === "stETH" ? `${reward.toFixed(5)} stETH` : usd(values.reduce((sum, value) => sum + value, 0))}</strong></section></section><section className="asset-panel asset-table-panel"><div className="panel-heading"><div><h2>{symbol} の履歴</h2><span>{symbol === "stETH" ? "Lido Rewardと残高スナップショットを接続しています。" : "前回保存値との差分です。"}</span></div></div><div className="table-scroll"><table className="asset-table"><thead><tr><th>Date</th><th>数量</th><th>USD/JPY</th><th>APR</th><th>増加量</th><th>評価額</th></tr></thead><tbody>{rows.slice().reverse().map((row) => <tr key={`${row.date}-${row.source ?? ""}`}><td>{row.date}</td><td>{Number(row.balance ?? row.quantity ?? 0).toLocaleString("en-US", { maximumFractionDigits: symbol === "stETH" ? 5 : 8 })}</td><td>{row.fx ? Number(row.fx).toFixed(2) : "—"}</td><td>{row.apr == null ? "—" : `${Number(row.apr).toFixed(2)}%`}</td><td>{row.change == null && row.delta == null ? "—" : Number(row.change ?? row.delta).toLocaleString("en-US", { maximumFractionDigits: 6 })}</td><td>{usd(row.balanceUsd ?? row.valueUsd ?? 0)}</td></tr>)}</tbody></table></div></section></>;
}

function CurrencyChart({ values, rows, type, symbol }: { values: number[]; rows: Row[]; type: string; symbol: string }) { if (rows.length < 2) return <div className="asset-empty">表示できる履歴がありません。</div>; const max = Math.max(...values.map(Math.abs), 1); const base = type === "change" ? 135 : 232; return <div className="asset-chart"><svg viewBox="0 0 720 270" role="img" aria-label={`${symbol}の${type === "change" ? "日次増加量" : "資産推移"}`}>{type === "change" && <line className="asset-axis" x1="50" x2="690" y1={base} y2={base} />}{type === "balance" ? <><path className="asset-chart-line" d={values.map((value, index) => `${index ? "L" : "M"}${50 + index * 640 / (values.length - 1)},${232 - value / max * 180}`).join("")} /></> : values.map((value, index) => { const y = base - value / max * 100; return <rect key={rows[index].date} className={value >= 0 ? "asset-bar positive" : "asset-bar negative"} x={45 + index * 640 / values.length} y={Math.min(base, y)} width={Math.max(4, 600 / values.length)} height={Math.abs(base - y)}><title>{`${rows[index].date} / ${value.toLocaleString("en-US")}`}</title></rect>; })}{rows.map((row, index) => (index === 0 || index === rows.length - 1 || index % Math.ceil(rows.length / 6) === 0) && <text key={row.date} x={50 + index * 640 / (rows.length - 1)} y="255" textAnchor="middle">{row.date.slice(5)}</text>)}</svg></div>; }

function Sync({ state, reload }: { state: State | null; reload: () => void }) { return <section className="asset-panel sync-panel"><div className="panel-heading"><div><h2>データ更新</h2><span>外部APIの取得はMacだけで行い、結果だけを同期します。</span></div></div><p className="muted-copy">APIキー、シークレット、秘密鍵はmacOS Keychainにのみ保管されます。</p><button className="secondary-button" onClick={reload}>保存済みデータを再読み込み</button><p className="muted-copy">{state?.runs[0] ? `最終同期: ${date(state.runs[0].received_at)}` : "まだ同期履歴がありません。"}</p></section>; }

function Settings({ state }: { state: State | null }) { return <section className="asset-panel asset-table-panel"><div className="panel-heading"><div><h2>設定</h2><span>接続先と同期状態を確認します。</span></div></div><div className="table-scroll"><table className="asset-table"><thead><tr><th>表示名</th><th>接続先</th><th>認証情報</th><th>状態</th></tr></thead><tbody>{state?.sources.map((source) => <tr key={source.id}><td><strong>{source.display_name}</strong></td><td>{source.provider}</td><td>Mac Keychain</td><td><span className="status-good">{source.last_success_at ? "接続済み" : "未同期"}</span></td></tr>)}</tbody></table></div></section>; }
