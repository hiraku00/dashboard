"use client";

import { useMemo, useRef, useState } from "react";
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
import { formatDate, formatQuantity, money, shortDate, yen } from "@/app/lib/manage-asset-format";
import { periodRows, periods, samplePoints, type Period } from "@/app/lib/manage-asset-chart";
import { ChartTooltip, axisLayout, useChartHoverTooltip, useSvgFontScale, type ChartHoverPoint } from "@/app/manage-asset-chart-tooltip";

/** 通貨記号を除いた符号つきの数値文字列（例: −8,144.33）。0 は符号なし。 */
function signed(value: number, format: (value: number) => string): string {
  const body = format(Math.abs(value)).slice(1);
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${body}`;
}

function signedPercent(value: number): string {
  const text = Math.abs(value).toFixed(2);
  return `${value > 0 ? "+" : value < 0 && text !== "0.00" ? "−" : ""}${text}%`;
}

export type AssetStateData = { snapshots: AssetRow[]; exchange_snapshots: AssetRow[] };
export type AssetHistoryData = { snapshots: AssetRow[]; exchange_snapshots: AssetRow[] };

const allocationColors = ["#0A84FF", "#30D158", "#FF9F0A", "#BF5AF2", "#FF375F", "#8E8E93"];

export function AssetOverview({
  state,
  history,
  today,
  ensureHistory,
}: {
  state: AssetStateData | null;
  history: AssetHistoryData | null;
  today: string;
  ensureHistory: (period: Period) => Promise<unknown>;
}) {
  const [period, setPeriod] = useState<Period>("7");
  const [showDust, setShowDust] = useState(false);

  async function selectPeriod(next: Period) {
    setPeriod(next);
    await ensureHistory(next);
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
    const previousPoint = previousOpeningPoint(histW, histE, latestDate);
    const previous = previousPoint?.value ?? null;
    const previousFx = previousPoint?.fx ?? null;
    const delta = previous == null ? null : total - previous;
    const recon = reconciliation(wallets, exchanges);
    return { fx, total, holdings, places, freshness: times.at(-1) ?? null, stale: places.filter((place) => place.status === "古いデータ"), trend, previous, previousFx, delta, recon };
  }, [state, history, period, today]);

  const { fx, total, delta, previous, previousFx } = view;
  const rate = fx?.rate ?? null;

  // GMOコインは毎週土曜9:00〜11:00（日本時間）にシステムメンテナンスがある
  // （https://support.coin.z.com/hc/ja/articles/115007815487）。土曜に古い
  // データ扱いになっているのがこの定例メンテによるものだと分かるよう注記する。
  const isSaturday = today ? new Date(`${today}T00:00:00`).getDay() === 6 : false;
  const staleGmo = view.stale.some((place) => place.name.includes("GMO"));

  return (
    <>
      {view.stale.length ? (
        <div className="notice" role="status">
          <strong>古いデータがあります。</strong> 当日取得できていない保管場所があります（{view.stale.map((place) => place.name).join("、")}）。表示中の金額は前回成功時のスナップショットです。
          {isSaturday && staleGmo ? " GMOコインは毎週土曜9:00〜11:00（日本時間）にシステムメンテナンスがあるため、この時間帯は取得できないことがあります。" : ""}
        </div>
      ) : null}

      <section className="asset-hero">
        <div className="hero-grid">
          <div>
            <p>総資産（USD）</p>
            <strong>{money(total)}</strong>
            <p>{fx ? `円換算 ${yen(total * fx.rate)}` : "円換算 —"}</p>
          </div>
          <div className="hero-metric">
            <span>前日保存比</span>
            {delta == null ? (
              <strong>比較データがありません</strong>
            ) : (
              <strong className={`hero-delta ${delta > 0 ? "up" : delta < 0 ? "down" : ""}`}>
                <span className="hero-delta-row">
                  <span className="hero-delta-unit">$</span>
                  <span className="hero-delta-num">{signed(delta, money)}</span>
                  <span className="hero-delta-pct">{`（${signedPercent(previous ? (delta / previous) * 100 : 0)}）`}</span>
                </span>
                {rate ? (
                  <span className="hero-delta-row">
                    <span className="hero-delta-unit">¥</span>
                    <span className="hero-delta-num">{signed(delta * rate, yen)}</span>
                  </span>
                ) : null}
              </strong>
            )}
          </div>
          <div className="hero-metric">
            <span>換算レート</span>
            <strong>{fx ? `USD/JPY ${fx.rate.toFixed(2)}` : "USD/JPY 未取得"}</strong>
            <span className="hero-metric-sub">{previousFx ? `前日 ${previousFx.toFixed(2)}` : "前日 —"}</span>
          </div>
          <div className="hero-metric">
            <span>最終更新</span>
            <strong>{!today ? "—" : view.freshness ? formatDate(view.freshness) : "データ未取得"}</strong>
          </div>
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
                <button key={value} type="button" className={period === value ? "active" : ""} aria-pressed={period === value} onClick={() => selectPeriod(value)}>{label}</button>
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
  const width = 720, baseHeight = 240, baseLeft = 64, right = 6, baseTop = 22, baseBottom = 32;
  const values = points.map((point) => point.value);
  const rawMin = Math.min(...values), rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * 0.12, rawMax * 0.02, 1);
  const min = Math.max(0, rawMin - padding), max = rawMax + padding, span = Math.max(max - min, 1);
  const ticks = [max, max - span * 0.25, max - span * 0.5, max - span * 0.75, min];
  const containerRef = useRef<HTMLDivElement>(null);
  const scale = useSvgFontScale(containerRef, width + 16, points.length);
  const mainFontSize = 11 / scale, subFontSize = 10 / scale, lineGap = 13 / scale;
  const { left, gap, vk } = axisLayout(baseLeft, 5, scale, ticks.flatMap((tick) => [
    { text: money(tick), fontSize: mainFontSize },
    { text: rate ? yen(tick * rate) : "円換算 —", fontSize: subFontSize },
  ]));
  const height = baseHeight * vk, top = baseTop * vk, bottom = baseBottom * vk;
  const x = (index: number) => left + (index * (width - left - right)) / (points.length - 1);
  const y = (value: number) => height - bottom - ((value - min) / span) * (height - top - bottom);
  const line = points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.value)}`).join(" ");
  const step = Math.max(1, Math.ceil(points.length / 10));
  const hoverPoints: ChartHoverPoint[] = points.map((point, index) => ({
    x: x(index),
    y: y(point.value),
    lines: [point.date, money(point.value), rate ? yen(point.value * rate) : "円換算 —"],
  }));
  const { tooltip, handlePointerMove, handlePointerLeave } = useChartHoverTooltip(hoverPoints, containerRef);
  if (points.length < 2) return <div className="asset-chart"><p className="muted-copy">推移を表示するには、異なる記録日の保存が2回以上必要です。</p></div>;
  return (
    <div className="asset-chart-wrap" ref={containerRef}>
      <svg
        className="asset-chart"
        viewBox={`-4 0 ${width + 16} ${height}`}
        role="img"
        aria-label="資産推移（USD・JPY評価額）"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        {ticks.map((tick, index) => (
          <g key={index}>
            <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} stroke="var(--line)" />
            <text textAnchor="end" x={left - gap} y={y(tick) - 2 * vk} style={{ fontSize: mainFontSize }}>
              <tspan x={left - gap}>{money(tick)}</tspan>
              <tspan className="asset-chart-subtext" x={left - gap} dy={lineGap} style={{ fontSize: subFontSize }}>{rate ? yen(tick * rate) : "円換算 —"}</tspan>
            </text>
          </g>
        ))}
        <path className="asset-chart-area" d={`${line} L${x(points.length - 1)},${height - bottom} L${x(0)},${height - bottom}Z`} />
        <path className="asset-chart-line" d={line} />
        {points.map((point, index) => (
          <g key={point.date}>
            <circle className="asset-chart-dot" cx={x(index)} cy={y(point.value)} r={4} tabIndex={0}>
              <title>{`${point.date} ${money(point.value)}${rate ? ` (${yen(point.value * rate)})` : ""}`}</title>
            </circle>
            <text textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} x={x(index)} y={height - 8 * vk} style={{ fontSize: mainFontSize }}>
              {index % step === 0 || index === points.length - 1 ? shortDate(point.date) : ""}
            </text>
          </g>
        ))}
      </svg>
      <ChartTooltip tooltip={tooltip} />
    </div>
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
            <span className="allocation-value">
              <span>{money(item.value)}</span>
              <span className="allocation-percent">{total ? ((item.value / total) * 100).toFixed(1) : "0.0"}%</span>
            </span>
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
