"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  allPositions,
  currencyHistory,
  holdingsFromPositions,
  stethRewardHistory,
  type AssetRow,
} from "@/app/lib/manage-asset-core";
import {
  currencyFiat,
  currencyQuantity,
  fiatDigits,
  fixed,
  metricDecimals,
  shortDate,
  signedCurrencyFiat,
} from "@/app/lib/manage-asset-format";
import { historyMissesCutover, periodRows, periods, samplePoints, type Period } from "@/app/lib/manage-asset-chart";
import { ChartTooltip, axisLayout, useChartHoverTooltip, useSvgFontScale, type ChartHoverPoint } from "@/app/manage-asset-chart-tooltip";
import type { AssetHistoryData, AssetStateData } from "./manage-asset-overview";

// stETH の CSV 履歴とスナップショットの移行境界日。
// public/manage-asset-original/app-ui.js の rewardHistory() と同じ値。
const STETH_CUTOVER_DATE = "2026-07-12";
const PAGE_SIZE = 10;

type CurrencyRow = {
  date: string;
  balance: number;
  change: number | null;
  usd: number | null;
  balanceUsd: number | null;
  price: number | null;
  fx: number | null;
  yen: number | null;
  apr: number | null;
  source: string;
};
type CalculatedRow = CurrencyRow & { balanceChangeUsd: number | null; balanceChangeYen: number | null };

/** app-ui.js の withBalanceChanges: 前行との balanceUsd 差分を、最新行の fx で円換算する
 *  （行ごとの fx を使うと為替変動ぶんが混ざり符号が食い違うため）。 */
function withBalanceChanges(rows: CurrencyRow[]): CalculatedRow[] {
  const fxLatest = rows.length ? rows[rows.length - 1].fx : null;
  return rows.map((row, index) => {
    const previous = index ? rows[index - 1] : null;
    const balanceChangeUsd = previous && row.balanceUsd != null && previous.balanceUsd != null ? row.balanceUsd - previous.balanceUsd : null;
    return { ...row, balanceChangeUsd, balanceChangeYen: balanceChangeUsd != null && fxLatest ? balanceChangeUsd * fxLatest : null };
  });
}

export function CurrencyView({
  state,
  history,
  historyDays,
  lidoRewards,
  usdJpyRates,
  today,
  ensureHistory,
}: {
  state: AssetStateData | null;
  history: AssetHistoryData | null;
  /** The window `history` was fetched for (Infinity = everything). */
  historyDays: number;
  lidoRewards: AssetRow[] | null;
  usdJpyRates: AssetRow[] | null;
  today: string;
  ensureHistory: (period: Period) => Promise<void>;
}) {
  const [symbolOverride, setSymbolOverride] = useState<string | null>(null);
  const [mode, setMode] = useState<"change" | "balance">("change");
  const [period, setPeriod] = useState<Period>("7");
  const [page, setPage] = useState(0);

  const symbols = useMemo(() => {
    const wallets = state?.snapshots ?? [];
    const exchanges = state?.exchange_snapshots ?? [];
    return holdingsFromPositions(allPositions(wallets, exchanges)).map((item) => item.symbol);
  }, [state]);
  const selected = symbolOverride && symbols.includes(symbolOverride) ? symbolOverride : symbols.includes("stETH") ? "stETH" : (symbols[0] ?? "");
  const isSteth = selected.toLowerCase() === "steth";

  // stETH joins the Lido CSV to the snapshots at STETH_CUTOVER_DATE, so a history
  // window that starts after it would leave a gap the chart shows as one huge
  // "reward" (see historyMissesCutover). Fetch the full history first, and show
  // nothing until it is in rather than the wrong chart. If the fetch fails
  // (ensureHistory keeps the old history and resolves), draw what we have --
  // as before -- instead of waiting forever.
  const needsFullHistory = isSteth && historyMissesCutover(history, historyDays, STETH_CUTOVER_DATE);
  const [fullHistoryTried, setFullHistoryTried] = useState(false);
  const fullHistoryRequested = useRef(false);
  useEffect(() => {
    if (!needsFullHistory || fullHistoryRequested.current) return;
    fullHistoryRequested.current = true;
    void ensureHistory("all").finally(() => setFullHistoryTried(true));
  }, [needsFullHistory, ensureHistory]);
  const loadingFullHistory = needsFullHistory && !fullHistoryTried;

  async function selectPeriod(next: Period) {
    setPeriod(next);
    setPage(0);
    await ensureHistory(next);
  }

  const view = useMemo(() => {
    if (!selected) return null;
    const wallets = history?.snapshots ?? [];
    const exchanges = history?.exchange_snapshots ?? [];
    const rates = usdJpyRates ?? [];
    let rows: CurrencyRow[] = isSteth
      ? (stethRewardHistory(lidoRewards ?? [], wallets, exchanges, rates, STETH_CUTOVER_DATE) as CurrencyRow[])
      : (currencyHistory(wallets, exchanges, selected, rates) as CurrencyRow[]);
    if (isSteth && today) {
      // 当日の正規化スナップショット（state, 二重取り込みが混ざり得る legacy history
      // ではなく）を正として、当日行だけ上書きする。
      const stateWallets = state?.snapshots ?? [];
      const stateExchanges = state?.exchange_snapshots ?? [];
      const currentToday = (currencyHistory(stateWallets, stateExchanges, "stETH", rates) as CurrencyRow[]).find((row) => row.date === today);
      if (currentToday) {
        const previous = rows.filter((row) => row.date < today).at(-1);
        const change = previous ? currentToday.balance - previous.balance : currentToday.balance;
        const usd = currentToday.price == null ? null : change * currentToday.price;
        const replacement: CurrencyRow = {
          date: today,
          change,
          usd,
          apr: previous && previous.balance ? (change / previous.balance) * 365 * 100 : 0,
          balance: currentToday.balance,
          price: currentToday.price,
          fx: currentToday.fx,
          yen: usd != null && currentToday.fx ? usd * currentToday.fx : null,
          balanceUsd: currentToday.balanceUsd,
          source: "snapshot",
        };
        rows = [...rows.filter((row) => row.date !== today), replacement].sort((a, b) => a.date.localeCompare(b.date));
      }
    }
    const calculated = withBalanceChanges(rows);
    const shown = periodRows(calculated, period);
    const last = calculated.at(-1) ?? null;
    const balanceMode = mode === "balance";
    const periodLabel = periods.find(([value]) => value === period)?.[1] ?? "";
    let delta: number | null = shown.length ? shown.reduce((sum, row) => sum + (row.change ?? 0), 0) : null;
    let deltaUsd: number | null = shown.length ? shown.reduce((sum, row) => sum + (row.usd ?? 0), 0) : null;
    let deltaYen: number | null = shown.length ? shown.reduce((sum, row) => sum + (row.yen ?? 0), 0) : null;
    if (balanceMode) {
      delta = null;
      deltaUsd = shown.length ? shown.reduce((sum, row) => sum + (row.balanceChangeUsd ?? 0), 0) : null;
      deltaYen = shown.length ? shown.reduce((sum, row) => sum + (row.balanceChangeYen ?? 0), 0) : null;
    }
    return { calculated, shown, last, balanceMode, periodLabel, delta, deltaUsd, deltaYen };
  }, [state, history, lidoRewards, usdJpyRates, selected, isSteth, today, period, mode]);

  return (
    <>
      <section className="asset-panel currency-controls">
        <label>
          表示する通貨
          <select value={selected} onChange={(event) => { setSymbolOverride(event.target.value); setPage(0); }}>
            {symbols.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
          </select>
        </label>
        <label>
          表示内容
          <select value={mode} onChange={(event) => setMode(event.target.value as "change" | "balance")}>
            <option value="change">日次増加量</option>
            <option value="balance">資産推移</option>
          </select>
        </label>
        <div>
          グラフ期間
          <select value={period} onChange={(event) => selectPeriod(event.target.value as Period)}>
            {periods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      </section>

      {loadingFullHistory ? (
        <div className="asset-panel" role="status"><p className="muted-copy">stETHの履歴を読み込み中…</p></div>
      ) : !view ? (
        <div className="asset-panel"><p className="muted-copy">表示できる通貨がありません。</p></div>
      ) : (
        <>
          <div className="currency-overview-grid">
            <div className="currency-grid">
              <div className="currency-card">
                <span>現在残高</span>
                <b>{view.last ? `${currencyQuantity(view.last.balance, selected, "balance")} ${selected}` : "—"}</b>
                <span>{currencyFiat(view.last?.balanceUsd ?? null, "USD")} / {currencyFiat(view.last?.balanceUsd != null && view.last.fx ? view.last.balanceUsd * view.last.fx : null, "JPY")}</span>
              </div>
              <div className="currency-card">
                <span>{view.balanceMode ? `USD評価額の期間増減（${view.periodLabel}）` : isSteth ? `期間報酬（${view.periodLabel}）` : `期間増加分（${view.periodLabel}）`}</span>
                <b>
                  {view.balanceMode
                    ? signedCurrencyFiat(view.deltaUsd, "USD")
                    : view.delta == null ? "—" : `${view.delta >= 0 ? "+" : "−"}${currencyQuantity(Math.abs(view.delta), selected, "change")} ${selected}`}
                </b>
                <span>{view.balanceMode ? signedCurrencyFiat(view.deltaYen, "JPY") : `${currencyFiat(view.deltaUsd, "USD")} / ${currencyFiat(view.deltaYen, "JPY")}`}</span>
              </div>
            </div>

            <section className="asset-panel chart-panel">
              <div className="panel-heading">
                <div>
                  <h2>{view.balanceMode ? `${selected}の資産推移` : `${selected}の日次増加量`}</h2>
                  <span>
                    {view.balanceMode
                      ? isSteth ? "LidoのRewardのみを合計し、入出庫を除外しています。" : "選択したグラフ期間のUSD評価額を表示します。"
                      : isSteth ? "LidoのRewardを表示します。CSV最終日より後は残高差から暫定計算します。" : "前の記録日からの残高差を表示します。入出金や報酬の内訳は区別しません。"}
                  </span>
                </div>
              </div>
              {view.balanceMode ? <CurrencyBalanceChart points={samplePoints(view.shown, period)} symbol={selected} /> : <CurrencyChangeChart points={samplePoints(view.shown, period)} symbol={selected} />}
            </section>
          </div>

          <section className="asset-panel asset-table-panel">
            <CurrencyTable rows={view.calculated} symbol={selected} balanceMode={view.balanceMode} page={page} setPage={setPage} />
          </section>
        </>
      )}
    </>
  );
}

function CurrencyChangeChart({ points, symbol }: { points: CalculatedRow[]; symbol: string }) {
  const data = points.filter((row) => row.change != null);
  const monetary = data.some((row) => row.usd != null);
  const valueOf = (row: CalculatedRow) => (monetary ? Math.abs(row.usd ?? 0) : Math.abs(row.change ?? 0));
  const peak = Math.max(...data.map(valueOf), 0.000001);
  const max = peak / 0.72;
  const referenceFx = data.at(-1)?.fx ?? null;
  const width = 720, baseHeight = 240, baseLeft = 80, right = 6, baseTop = 22, baseBottom = 32;
  const ticks = [max, max * 0.75, max * 0.5, max * 0.25, 0];
  const containerRef = useRef<HTMLDivElement>(null);
  const scale = useSvgFontScale(containerRef, width + 16, data.length);
  const mainFontSize = 11 / scale, subFontSize = 10 / scale, lineGap = 13 / scale;
  const { left, gap, vk } = axisLayout(baseLeft, 8, scale, ticks.flatMap((tick) => [
    { text: monetary ? currencyFiat(tick, "USD") : currencyQuantity(tick, symbol, "change"), fontSize: mainFontSize },
    ...(monetary && referenceFx ? [{ text: currencyFiat(tick * referenceFx, "JPY"), fontSize: subFontSize }] : []),
  ]));
  const height = baseHeight * vk, top = baseTop * vk, bottom = baseBottom * vk;
  const x = (index: number) => left + (data.length === 1 ? 0 : (index * (width - left - right)) / (data.length - 1));
  const y = (value: number) => height - bottom - (Math.max(0, value) / max) * (height - top - bottom);
  const step = Math.max(1, Math.ceil(data.length / 10));
  const line = data.map((row, index) => `${index ? "L" : "M"}${x(index)},${y(valueOf(row))}`).join(" ");
  const hoverPoints: ChartHoverPoint[] = data.map((row, index) => ({
    x: x(index),
    y: y(valueOf(row)),
    lines: monetary
      ? [row.date, `USD ${currencyFiat(row.usd, "USD")}`, row.fx ? `JPY ${currencyFiat((row.usd ?? 0) * row.fx, "JPY")}` : "JPY —"]
      : [row.date, `${symbol} ${(row.change ?? 0) >= 0 ? "+" : "−"}${currencyQuantity(Math.abs(row.change ?? 0), symbol, "change")}`],
  }));
  const { tooltip, handlePointerMove, handlePointerLeave } = useChartHoverTooltip(hoverPoints, containerRef);
  if (!data.length) return <div className="asset-chart"><p className="muted-copy">差分を表示するには、異なる記録日が2日以上必要です。</p></div>;
  return (
    <div className="asset-chart-wrap" ref={containerRef}>
      <svg
        className="asset-chart"
        viewBox={`-4 0 ${width + 16} ${height}`}
        role="img"
        aria-label={`${symbol}の日次増加量`}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        {ticks.map((tick, index) => (
          <g key={index}>
            <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} stroke="var(--line)" />
            <text textAnchor="end" x={left - gap} y={y(tick) - 2 * vk} style={{ fontSize: mainFontSize }}>
              <tspan x={left - gap}>{monetary ? currencyFiat(tick, "USD") : currencyQuantity(tick, symbol, "change")}</tspan>
              {monetary && referenceFx ? <tspan className="asset-chart-subtext" x={left - gap} dy={lineGap} style={{ fontSize: subFontSize }}>{currencyFiat(tick * referenceFx, "JPY")}</tspan> : null}
            </text>
          </g>
        ))}
        <path className="asset-chart-area" d={`${line} L${x(data.length - 1)},${y(0)} L${x(0)},${y(0)}Z`} />
        <path className="asset-chart-line" d={line} />
        {data.map((row, index) => (
          <g key={row.date}>
            <circle className="asset-chart-dot" cx={x(index)} cy={y(valueOf(row))} r={4} tabIndex={0}>
              <title>{`${row.date}${monetary ? ` / USD ${currencyFiat(row.usd, "USD")}${row.fx ? ` / JPY ${currencyFiat((row.usd ?? 0) * row.fx, "JPY")}` : ""}` : ` / ${symbol} ${(row.change ?? 0) >= 0 ? "+" : "−"}${currencyQuantity(Math.abs(row.change ?? 0), symbol, "change")}`}`}</title>
            </circle>
            <text textAnchor="middle" x={x(index)} y={height - 8 * vk} style={{ fontSize: mainFontSize }}>{index % step === 0 || index === data.length - 1 ? shortDate(row.date) : ""}</text>
          </g>
        ))}
      </svg>
      <ChartTooltip tooltip={tooltip} />
    </div>
  );
}

function CurrencyBalanceChart({ points, symbol }: { points: CalculatedRow[]; symbol: string }) {
  const data = points.filter((row) => row.balanceUsd != null);
  const referenceFx = data.at(-1)?.fx ?? null;
  const width = 720, baseHeight = 240, baseLeft = 80, right = 6, baseTop = 22, baseBottom = 32;
  const values = data.map((row) => row.balanceUsd as number);
  const rawMin = Math.min(...values), rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * 0.12, Math.abs(rawMax) * 0.02, 0.01);
  const min = Math.max(0, rawMin - padding), max = rawMax + padding, span = Math.max(max - min, 0.01);
  const ticks = [max, max - span * 0.25, max - span * 0.5, max - span * 0.75, min];
  const containerRef = useRef<HTMLDivElement>(null);
  const scale = useSvgFontScale(containerRef, width + 16, data.length);
  const mainFontSize = 11 / scale, subFontSize = 10 / scale, lineGap = 13 / scale;
  const { left, gap, vk } = axisLayout(baseLeft, 8, scale, ticks.flatMap((tick) => [
    { text: currencyFiat(tick, "USD"), fontSize: mainFontSize },
    ...(referenceFx ? [{ text: currencyFiat(tick * referenceFx, "JPY"), fontSize: subFontSize }] : []),
  ]));
  const height = baseHeight * vk, top = baseTop * vk, bottom = baseBottom * vk;
  const x = (index: number) => left + (index * (width - left - right)) / (data.length - 1);
  const y = (value: number) => height - bottom - ((value - min) / span) * (height - top - bottom);
  const step = Math.max(1, Math.ceil(data.length / 10));
  const line = data.map((row, index) => `${index ? "L" : "M"}${x(index)},${y(row.balanceUsd as number)}`).join(" ");
  const hoverPoints: ChartHoverPoint[] = data.map((row, index) => ({
    x: x(index),
    y: y(row.balanceUsd as number),
    lines: [
      row.date,
      `USD ${currencyFiat(row.balanceUsd, "USD")}`,
      row.fx ? `JPY ${currencyFiat((row.balanceUsd ?? 0) * row.fx, "JPY")}` : "JPY —",
      `${symbol} ${currencyQuantity(row.balance, symbol, "balance")}`,
    ],
  }));
  const { tooltip, handlePointerMove, handlePointerLeave } = useChartHoverTooltip(hoverPoints, containerRef);
  if (data.length < 2) return <div className="asset-chart"><p className="muted-copy">USD評価額の推移を表示するには、異なる記録日の保存が2回以上必要です。</p></div>;
  return (
    <div className="asset-chart-wrap" ref={containerRef}>
      <svg
        className="asset-chart"
        viewBox={`-4 0 ${width + 16} ${height}`}
        role="img"
        aria-label={`${symbol}の資産推移（USD・JPY評価額）`}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        {ticks.map((tick, index) => (
          <g key={index}>
            <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} stroke="var(--line)" />
            <text textAnchor="end" x={left - gap} y={y(tick) - 2 * vk} style={{ fontSize: mainFontSize }}>
              <tspan x={left - gap}>{currencyFiat(tick, "USD")}</tspan>
              {referenceFx ? <tspan className="asset-chart-subtext" x={left - gap} dy={lineGap} style={{ fontSize: subFontSize }}>{currencyFiat(tick * referenceFx, "JPY")}</tspan> : null}
            </text>
          </g>
        ))}
        <path className="asset-chart-area" d={`${line} L${x(data.length - 1)},${height - bottom} L${x(0)},${height - bottom}Z`} />
        <path className="asset-chart-line" d={line} />
        {data.map((row, index) => (
          <g key={row.date}>
            <circle className="asset-chart-dot" cx={x(index)} cy={y(row.balanceUsd as number)} r={4} tabIndex={0}>
              <title>{`${row.date} / USD ${currencyFiat(row.balanceUsd, "USD")}${row.fx ? ` / JPY ${currencyFiat((row.balanceUsd ?? 0) * row.fx, "JPY")}` : ""} / ${symbol} ${currencyQuantity(row.balance, symbol, "balance")}`}</title>
            </circle>
            <text textAnchor="middle" x={x(index)} y={height - 8 * vk} style={{ fontSize: mainFontSize }}>{index % step === 0 || index === data.length - 1 ? shortDate(row.date) : ""}</text>
          </g>
        ))}
      </svg>
      <ChartTooltip tooltip={tooltip} />
    </div>
  );
}

function CurrencyTable({ rows, symbol, balanceMode, page, setPage }: { rows: CalculatedRow[]; symbol: string; balanceMode: boolean; page: number; setPage: (page: number) => void }) {
  const descending = [...rows].reverse();
  const totalPages = Math.max(1, Math.ceil(descending.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const shown = descending.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);
  const differenceLabel = balanceMode ? "Change" : "Reward";
  const rateUsdDigits = fiatDigits("USD"), rateJpyDigits = fiatDigits("JPY");
  const fxDigits = metricDecimals.fxRate, aprDigits = metricDecimals.apr;
  const changeClass = (value: number | null) => (value == null ? "" : value > 0 ? "change-positive" : value < 0 ? "change-negative" : "change-neutral");
  const paginationPages = [...new Set([1, currentPage + 1, totalPages])].sort((a, b) => a - b);

  if (!rows.length) return <div className="table-scroll"><p className="muted-copy">表示できる履歴がありません。</p></div>;

  return (
    <>
      <div className="table-scroll">
        <table className="asset-table">
          <caption className="sr-only">{symbol}の推移履歴</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Rate<br />({symbol})</th>
              <th scope="col">Rate<br />(USD/JPY)</th>
              <th scope="col">APR</th>
              <th scope="col">{differenceLabel}<br />({symbol})</th>
              <th scope="col">{differenceLabel}<br />(USD/JPY)</th>
              <th scope="col">Balance<br />({symbol})</th>
              <th scope="col">Balance<br />(USD/JPY)</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const changeUsd = balanceMode ? row.balanceChangeUsd : row.usd;
              const changeYen = balanceMode ? row.balanceChangeYen : row.yen;
              const changeUsdText = balanceMode ? signedCurrencyFiat(changeUsd, "USD") : currencyFiat(changeUsd, "USD");
              const changeYenText = balanceMode ? signedCurrencyFiat(changeYen, "JPY") : currencyFiat(changeYen, "JPY");
              return (
                <tr key={row.date}>
                  <td>{row.date}</td>
                  <td>
                    {row.price == null ? "—" : `$${fixed(row.price, rateUsdDigits)}`}
                    <small>{row.price == null || !row.fx ? "JPY —" : `¥${fixed(row.price * row.fx, rateJpyDigits)}`}</small>
                  </td>
                  <td>{row.fx ? fixed(row.fx, fxDigits) : "—"}</td>
                  <td>{balanceMode || row.apr == null ? "—" : `${fixed(row.apr, aprDigits)}%`}</td>
                  <td>{balanceMode ? "—" : currencyQuantity(row.change, symbol, "change")}</td>
                  <td>
                    <span className={balanceMode ? changeClass(changeUsd) : ""}>{changeUsdText}</span>
                    <small className={balanceMode ? changeClass(changeYen) : ""}>{changeYen == null ? "JPY —" : changeYenText}</small>
                  </td>
                  <td>{currencyQuantity(row.balance, symbol, "balance")}</td>
                  <td>
                    {currencyFiat(row.balanceUsd, "USD")}
                    <small>{row.balanceUsd == null || !row.fx ? "JPY —" : currencyFiat(row.balanceUsd * row.fx, "JPY")}</small>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {totalPages > 1 ? (
        <nav className="pagination" aria-label="履歴ページ">
          <button type="button" aria-label="前のページ" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>‹</button>
          {paginationPages.map((value, index) => (
            <span className="page-number" key={value}>
              {index > 0 && value - paginationPages[index - 1] > 1 && <i aria-hidden="true">…</i>}
              <button type="button" className={value === currentPage + 1 ? "current-page" : ""} aria-current={value === currentPage + 1 ? "page" : undefined} onClick={() => setPage(value - 1)}>{value}</button>
            </span>
          ))}
          <button type="button" aria-label="次のページ" disabled={currentPage >= totalPages - 1} onClick={() => setPage(currentPage + 1)}>›</button>
        </nav>
      ) : null}
    </>
  );
}
