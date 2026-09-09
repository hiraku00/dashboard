"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  allPositions,
  historyPoints,
  holdingsFromPositions,
  latestFx,
  locations,
  previousOpeningPoint,
  reconciliation,
  total as totalOf,
  type AssetRow,
  type Holding,
} from "@/app/lib/manage-asset-core";
import { formatDate, formatQuantity, localDate, money, shortDate, yen } from "@/app/lib/manage-asset-format";

export type AssetStateData = { snapshots: AssetRow[]; exchange_snapshots: AssetRow[] };
export type AssetHistoryData = { snapshots: AssetRow[]; exchange_snapshots: AssetRow[] };

type Period = "7" | "30" | "90" | "all";
const periods: [Period, string][] = [["7", "7日"], ["30", "30日"], ["90", "90日"], ["all", "全期間"]];
const allocationColors = ["#0A84FF", "#30D158", "#FF9F0A", "#BF5AF2", "#FF375F", "#8E8E93"];
const subscribeNoop = () => () => {};
const emptyString = () => "";

/** app-ui.js の assetPeriodRows: 期間で対象日を絞る（最終日から period-1 日ぶん）。 */
function periodRows<T extends { date: string }>(rows: T[], period: Period): T[] {
  if (period === "all" || !rows.length) return rows;
  const cutoff = new Date(`${rows.at(-1)!.date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - Number(period) + 1);
  return rows.filter((row) => new Date(`${row.date}T00:00:00Z`) >= cutoff);
}

/** app-ui.js の sampledAssetTrendPoints: 15/18/24 点へ間引く（7日は間引かない）。 */
function samplePoints<T>(points: T[], period: Period): T[] {
  const limit = period === "7" ? Infinity : period === "30" ? 15 : period === "90" ? 18 : 24;
  if (points.length <= limit) return points;
  return Array.from({ length: limit }, (_, index) => points[Math.round((index * (points.length - 1)) / (limit - 1))]);
}

export function AssetOverview({ initialState, initialHistory }: { initialState: AssetStateData | null; initialHistory: AssetHistoryData | null }) {
  const [state, setState] = useState<AssetStateData | null>(initialState);
  const [history, setHistory] = useState<AssetHistoryData | null>(initialHistory);
  const [historyDays, setHistoryDays] = useState(initialHistory ? 90 : 0);
  const [period, setPeriod] = useState<Period>("7");
  const [showDust, setShowDust] = useState(false);
  // localDate() and formatDate() depend on the runtime timezone, so the server
  // (UTC) and the browser (the user's zone) would render them differently and
  // hydration would mismatch. useSyncExternalStore returns "" for the server
  // snapshot and the first client render, then the browser-local date once
  // hydrated -- the "最終更新" timestamp and the stale-data check become
  // browser-local, as they were in the pre-RSC app, with no setState-in-effect.
  const today = useSyncExternalStore(subscribeNoop, localDate, emptyString);
  const skipInitialFetch = useRef(initialState != null && initialHistory != null);

  // Mirror watch-list-app: if the server seeded us, do not re-fetch on mount;
  // otherwise fetch state + 90d history ourselves (the pre-RSC behavior).
  useEffect(() => {
    if (skipInitialFetch.current) return;
    let cancelled = false;
    (async () => {
      try {
        const [nextState, nextHistory] = await Promise.all([
          fetch("/api/manage-asset/state", { cache: "no-store" }).then((response) => response.json()),
          fetch("/api/manage-asset/history?days=90", { cache: "no-store" }).then((response) => response.json()),
        ]);
        if (cancelled) return;
        setState(nextState as AssetStateData);
        setHistory(nextHistory as AssetHistoryData);
        setHistoryDays(90);
      } catch {
        /* leave empty; the panels render their own empty states */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ?days= is only re-fetched when the chosen period needs more than is cached
  // (app-ui.js's ensureHistory). 7/30/90 are covered by the initial 90 days.
  async function ensurePeriod(next: Period) {
    setPeriod(next);
    const need = next === "all" ? Infinity : Number(next);
    if (need <= historyDays) return;
    try {
      const response = await fetch(`/api/manage-asset/history?days=${next === "all" ? "all" : need}`, { cache: "no-store" });
      if (!response.ok) return;
      setHistory(await response.json());
      setHistoryDays(need);
    } catch {
      /* keep the existing history on failure */
    }
  }

  const view = useMemo(() => {
    const wallets = state?.snapshots ?? [];
    const exchanges = state?.exchange_snapshots ?? [];
    const histW = history?.snapshots ?? [];
    const histE = history?.exchange_snapshots ?? [];
    const fx = latestFx(wallets, exchanges);
    const total = totalOf(wallets, exchanges);
    const holdings = holdingsFromPositions(allPositions(wallets, exchanges));
    const places = locations(wallets, exchanges, today);
    const times = places.map((place) => place.captured_at).filter(Boolean).map(String).sort();
    const trend = samplePoints(periodRows(historyPoints(histW, histE), period), period);
    const latestDate = [...wallets, ...exchanges].map((row) => row.as_of_date).filter(Boolean).map(String).sort().at(-1) ?? null;
    const previous = previousOpeningPoint(histW, histE, latestDate)?.value ?? null;
    const delta = previous == null ? null : total - previous;
    const recon = reconciliation(wallets, exchanges);
    return { fx, total, holdings, places, freshness: times.at(-1) ?? null, stale: places.filter((place) => place.status === "古いデータ"), trend, previous, delta, recon };
  }, [state, history, period, today]);

  const { fx, total, delta, previous } = view;
  const rate = fx?.rate ?? null;

  return (
    <>
      {view.stale.length ? (
        <div className="notice" role="status">
          <strong>古いデータがあります。</strong> 当日取得できていない保管場所があります（{view.stale.map((place) => place.name).join("、")}）。表示中の金額は前回成功時のスナップショットです。
        </div>
      ) : null}

      <section className="asset-hero">
        <div>
          <p>総資産（USD）</p>
          <strong>{money(total)}</strong>
          <p>{fx ? `円換算 ${yen(total * fx.rate)}` : "円換算 —"}</p>
        </div>
        <div className="asset-freshness">
          <span>前日保存比</span>
          <strong>
            {delta == null
              ? "比較データがありません"
              : `${delta >= 0 ? "+" : "−"}${money(Math.abs(delta))}（${previous ? Math.abs((delta / previous) * 100).toFixed(2) : "0.00"}%）${rate ? ` / ${delta >= 0 ? "+" : "−"}${yen(Math.abs(delta) * rate)}` : ""}`}
          </strong>
          <span>換算レート</span>
          <strong>{fx ? `USD/JPY ${fx.rate.toFixed(2)}` : "USD/JPY 未取得"}</strong>
          <span>最終更新</span>
          <strong>{!today ? "—" : view.freshness ? formatDate(view.freshness) : "データ未取得"}</strong>
        </div>
      </section>

      <div className="asset-dashboard-grid">
        <section className="asset-panel chart-panel">
          <div className="panel-heading">
            <div>
              <h2>資産推移</h2>
              <span>USD・JPY評価額</span>
            </div>
            <div className="period-control" role="group" aria-label="グラフ期間">
              {periods.map(([value, label]) => (
                <button key={value} type="button" className={period === value ? "active" : ""} aria-pressed={period === value} onClick={() => ensurePeriod(value)}>{label}</button>
              ))}
            </div>
          </div>
          <TrendChart points={view.trend} rate={rate} />
        </section>

        <section className="asset-panel">
          <div className="panel-heading">
            <div>
              <h2>資産配分</h2>
              <span>上位5資産 + その他</span>
            </div>
          </div>
          <Allocation holdings={view.holdings} total={total} />
          {view.recon.issues.length ? (
            <div className="notice" role="status">
              総額と明細に {money(Math.abs(view.recon.total - view.recon.detail))} の差があります（{view.recon.issues.map((issue) => issue.name).join("、")}）。
            </div>
          ) : null}
        </section>
      </div>

      <section className="asset-panel asset-table-panel">
        <div className="panel-heading">
          <div>
            <h2>保有資産</h2>
            <span>DeFi内のstETHを含む、保管場所横断の集計</span>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={showDust} onChange={(event) => setShowDust(event.target.checked)} /> 1 USD未満を表示
          </label>
        </div>
        <HoldingsTable holdings={view.holdings} total={total} rate={rate} showDust={showDust} />
      </section>
    </>
  );
}

/** 円換算のサブ行。app-ui.js の moneyPair 相当（rate 無しは「円換算 —」）。 */
function MoneyPair({ value, rate }: { value: number; rate: number | null }) {
  return (
    <>
      {money(value)}
      <small>{rate ? yen(value * rate) : "円換算 —"}</small>
    </>
  );
}

function TrendChart({ points, rate }: { points: { date: string; value: number }[]; rate: number | null }) {
  if (points.length < 2) return <div className="asset-chart"><p className="muted-copy">推移を表示するには、異なる記録日の保存が2回以上必要です。</p></div>;
  const width = 720, height = 300, left = 76, right = 6, top = 20, bottom = 40;
  const values = points.map((point) => point.value);
  const rawMin = Math.min(...values), rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * 0.12, rawMax * 0.02, 1);
  const min = Math.max(0, rawMin - padding), max = rawMax + padding, span = Math.max(max - min, 1);
  const x = (index: number) => left + (index * (width - left - right)) / (points.length - 1);
  const y = (value: number) => height - bottom - ((value - min) / span) * (height - top - bottom);
  const line = points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.value)}`).join(" ");
  const ticks = [max, max - span * 0.25, max - span * 0.5, max - span * 0.75, min];
  const step = Math.max(1, Math.ceil(points.length / 10));
  return (
    <svg className="asset-chart" viewBox={`-12 0 ${width + 24} ${height}`} role="img" aria-label="資産推移（USD・JPY評価額）">
      {ticks.map((tick, index) => (
        <g key={index}>
          <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} stroke="var(--line)" />
          <text textAnchor="end" x={left - 5} y={y(tick) - 4}>{money(tick)}{rate ? ` (${yen(tick * rate)})` : ""}</text>
        </g>
      ))}
      <path className="asset-chart-area" d={`${line} L${x(points.length - 1)},${height - bottom} L${x(0)},${height - bottom}Z`} />
      <path className="asset-chart-line" d={line} />
      {points.map((point, index) => (
        <g key={point.date}>
          <circle className="asset-chart-dot" cx={x(index)} cy={y(point.value)} r={4} tabIndex={0}>
            <title>{`${point.date} ${money(point.value)}${rate ? ` (${yen(point.value * rate)})` : ""}`}</title>
          </circle>
          <text textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} x={x(index)} y={height - 8}>
            {index % step === 0 || index === points.length - 1 ? shortDate(point.date) : ""}
          </text>
        </g>
      ))}
    </svg>
  );
}

function arc(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  const point = (radius: number, angle: number) => [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  const a = point(outer, start), b = point(outer, end), c = point(inner, end), d = point(inner, start);
  const large = end - start > Math.PI ? 1 : 0;
  return `M${a}A${outer},${outer} 0 ${large} 1 ${b}L${c}A${inner},${inner} 0 ${large} 0 ${d}Z`;
}

/** allocationChart のドーナツ弧。-90° から時計回りに各セグメントを積む。
 *  角度の累積を描画スコープの外（この純関数）で完結させる。 */
function donutSegments(shown: { symbol: string; value: number }[]): Array<{ d: string; color: string; symbol: string; value: number }> {
  const sum = shown.reduce((value, item) => value + item.value, 0) || 1;
  let angle = -Math.PI / 2;
  return shown.map((item, index) => {
    const end = angle + (item.value / sum) * 2 * Math.PI;
    const d = arc(130, 130, 102, 60, angle, end);
    angle = end;
    return { d, color: allocationColors[index], symbol: item.symbol, value: item.value };
  });
}

function Allocation({ holdings, total }: { holdings: Holding[]; total: number }) {
  const priced = holdings.filter((item) => item.valueUsd >= 1);
  const shown = priced.slice(0, 5).map((item) => ({ symbol: item.symbol, value: item.valueUsd }));
  const rest = priced.slice(5).reduce((sum, item) => sum + item.valueUsd, 0);
  if (rest) shown.push({ symbol: "その他", value: rest });
  if (!shown.length) return <div className="allocation"><p className="muted-copy">評価できる資産がありません。</p></div>;
  const segments = donutSegments(shown);
  return (
    <div className="allocation">
      <svg viewBox="0 0 260 260" role="img" aria-label="資産配分">
        {segments.map((segment) => (
          <path key={segment.symbol} d={segment.d} fill={segment.color}><title>{`${segment.symbol} ${money(segment.value)}`}</title></path>
        ))}
        <text className="allocation-total" x={130} y={125} textAnchor="middle">{money(total)}</text>
        <text className="allocation-caption" x={130} y={146} textAnchor="middle">合算総額</text>
      </svg>
      <div className="allocation-list">
        {shown.map((item, index) => (
          <div className="allocation-row" key={item.symbol}>
            <i style={{ background: allocationColors[index] }} />
            <strong>{item.symbol}</strong>
            <span>{money(item.value)} · {total ? ((item.value / total) * 100).toFixed(1) : "0.0"}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HoldingsTable({ holdings, total, rate, showDust }: { holdings: Holding[]; total: number; rate: number | null; showDust: boolean }) {
  const rows = holdings.filter((item) => showDust || item.valueUsd >= 1);
  const hidden = holdings.filter((item) => item.valueUsd < 1);
  if (!rows.length) return <div className="table-scroll"><p className="muted-copy">表示できる資産がありません。</p></div>;
  return (
    <>
      <div className="table-scroll">
        <table className="asset-table">
          <caption className="sr-only">保有資産一覧</caption>
          <thead>
            <tr>
              <th scope="col">資産</th>
              <th scope="col">合計数量</th>
              <th scope="col">単価</th>
              <th scope="col">評価額</th>
              <th scope="col">比率</th>
              <th scope="col">主な保管場所</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => {
              const shownLocations = item.locations.slice(0, 3);
              const restCount = item.locations.length - shownLocations.length;
              const ratio = total ? (item.valueUsd / total) * 100 : 0;
              return (
                <tr key={item.symbol}>
                  <td><strong>{item.symbol}</strong>{item.unpriced ? <small>一部評価なし</small> : null}</td>
                  <td>{formatQuantity(item.quantityKnown ? item.quantity : null, item.symbol)}</td>
                  <td>{item.unitPriceUsd == null ? "評価なし" : <MoneyPair value={item.unitPriceUsd} rate={rate} />}</td>
                  <td>{item.unpriced && item.valueUsd === 0 ? "評価なし" : <MoneyPair value={item.valueUsd} rate={rate} />}</td>
                  <td>
                    <span>{ratio.toFixed(1)}%</span>
                    <div className="mini-bar" role="img" aria-label={`構成比 ${ratio.toFixed(1)}%`}><i style={{ width: `${Math.max(0, Math.min(100, ratio))}%` }} /></div>
                  </td>
                  <td>
                    {shownLocations.map((name) => <span className="tag" key={name}>{name}</span>)}
                    {restCount ? <span className="tag">その他{restCount}件</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!showDust && hidden.length ? (
        <p className="muted-copy">1 USD未満の資産 {hidden.length}件（合計 {money(hidden.reduce((sum, item) => sum + item.valueUsd, 0))}）は非表示です。</p>
      ) : null}
    </>
  );
}
