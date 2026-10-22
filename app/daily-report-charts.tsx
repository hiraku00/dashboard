"use client";

import { useRouter } from "next/navigation";
import { Fragment, useRef, useState } from "react";
import { ChartTooltip, axisLayout, useChartHoverTooltip, useSvgFontScale, type ChartHoverPoint } from "./manage-asset-chart-tooltip";
import { categoryColor, reportHref, type ReportTab } from "./daily-report-ui";
import { CATEGORY_LABELS, formatMinutes, signedMinutes, type AllocationRow, type Range } from "./lib/daily-report-summary";
import type { ActivityBar } from "./lib/daily-report-model";

/** 概要タブの2つの図(docs/daily-report-view-design.md §4.1・§4.2)。 */

/** 活動時間の図: 1色の縦棒に縦軸と目盛り線。見出しの切り替えで「日ごと」⇔「最近12週(12か月)」。
 *  Manage Asset の資産推移と同じ部品(period-control・ChartTooltip・axisLayout)を使う。 */
export function ActivityChart({ days, periods, periodsLabel, tab }: { days: ActivityBar[]; periods: ActivityBar[]; periodsLabel: string; tab: ReportTab }) {
  const [mode, setMode] = useState<"days" | "periods">("days");
  const bars = mode === "days" ? days : periods;
  return (
    <section className="asset-panel dr-panel">
      <div className="panel-heading">
        <div>
          <h2>活動時間</h2>
          <span>{mode === "days" ? "1日ごと・押すとその日へ" : "期間ごとの1日平均・押すとその期間へ"}</span>
        </div>
        <div className="period-control" role="group" aria-label="活動時間の単位">
          <button type="button" className={mode === "days" ? "active" : ""} aria-pressed={mode === "days"} onClick={() => setMode("days")}>日ごと</button>
          <button type="button" className={mode === "periods" ? "active" : ""} aria-pressed={mode === "periods"} onClick={() => setMode("periods")}>{periodsLabel}</button>
        </div>
      </div>
      <BarChart key={mode} bars={bars} tab={tab} emptyLabel={mode === "periods"} />
    </section>
  );
}

function BarChart({ bars, tab, emptyLabel }: { bars: ActivityBar[]; tab: ReportTab; emptyLabel: boolean }) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const width = 640, baseHeight = 220, baseLeft = 40, right = 8, baseTop = 14, baseBottom = 28;
  const scale = useSvgFontScale(containerRef, width, bars.length);
  // 軸の文字は14px(DADS の最小。設計書 §11)
  const fontSize = 14 / scale;
  const max = Math.max(240, ...bars.map((bar) => bar.value ?? 0));
  const top4h = Math.ceil(max / 240) * 240;
  const ticks = Array.from({ length: top4h / 240 + 1 }, (_, index) => index * 240);
  const { left, gap, vk } = axisLayout(baseLeft, 6, scale, ticks.map((tick) => ({ text: tick ? `${tick / 60}h` : "0", fontSize })));
  const height = baseHeight * vk, chartTop = baseTop * vk, bottom = baseBottom * vk;
  const plot = width - left - right;
  const slot = plot / Math.max(1, bars.length);
  const barWidth = Math.min(slot * 0.6, 28);
  const y = (minutes: number) => height - bottom - (minutes / top4h) * (height - chartTop - bottom);
  const center = (index: number) => left + slot * index + slot / 2;

  const hoverPoints: ChartHoverPoint[] = bars.flatMap((bar, index) => bar.future ? [] : [{
    x: center(index),
    y: y(bar.value ?? 0),
    lines: [
      bar.title,
      bar.value === null ? "日報なし" : formatMinutes(bar.value),
      // カテゴリごとに1行(1行にまとめるとパネルの端で切れる)
      ...bar.breakdown.map((part) => `${CATEGORY_LABELS[part.category]} ${formatMinutes(part.minutes)}`),
    ],
  }]);
  const { tooltip, handlePointerMove, handlePointerLeave } = useChartHoverTooltip(hoverPoints, containerRef);
  const go = (bar: ActivityBar) => { if (bar.target) router.push(reportHref(bar.target.range as Range, bar.target.date, tab)); };

  return (
    <div className="asset-chart-wrap dr-bars" ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`活動時間: ${bars.filter((bar) => !bar.future).map((bar) => `${bar.title} ${bar.value === null ? "日報なし" : formatMinutes(bar.value)}`).join("、")}`}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? "dr-bars-base" : "dr-bars-grid"} />
            <text x={left - gap} y={y(tick) + fontSize * 0.35} textAnchor="end" style={{ fontSize }}>{tick ? `${tick / 60}h` : "0"}</text>
          </g>
        ))}
        {bars.map((bar, index) => {
          const x = center(index) - barWidth / 2;
          const labelY = height - bottom + fontSize * 1.6;
          return (
            <g key={bar.key} className={bar.target ? "is-link" : undefined} onClick={() => go(bar)}>
              {/* 押しやすいよう、棒の列全体を当たり判定にする */}
              <rect x={left + slot * index} y={chartTop} width={slot} height={height - chartTop - bottom} fill="transparent" />
              {bar.value !== null && bar.value > 0 && (() => {
                // カテゴリの積み上げ(下から学習・開発・生活・視聴・未分類)。区間の間に白い隙間、角丸は一番上の区間だけ
                const gapPx = 1.5 / scale;
                const parts = bar.breakdown.length ? bar.breakdown : [{ category: "other" as const, minutes: bar.value }];
                let base = height - bottom;
                return parts.map((part, partIndex) => {
                  const segmentHeight = (part.minutes / top4h) * (height - chartTop - bottom);
                  const top = base - segmentHeight;
                  const last = partIndex === parts.length - 1;
                  const drawnTop = top + (last ? 0 : gapPx / 2);
                  const drawnBottom = base - (partIndex === 0 ? 0 : gapPx / 2);
                  base = top;
                  if (drawnBottom - drawnTop <= 0) return null;
                  const radius = last ? Math.min(4, barWidth / 2, drawnBottom - drawnTop) : 0;
                  return (
                    <path
                      key={part.category}
                      className="dr-bar"
                      style={{ fill: categoryColor(part.category) }}
                      d={`M${x},${drawnBottom} V${drawnTop + radius} a${radius},${radius} 0 0 1 ${radius},${-radius} h${barWidth - radius * 2} a${radius},${radius} 0 0 1 ${radius},${radius} V${drawnBottom}Z`}
                    />
                  );
                });
              })()}
              {bar.value === null && !bar.future && (
                <>
                  <line className="dr-bar-missing" x1={center(index) - barWidth * 0.3} x2={center(index) + barWidth * 0.3} y1={height - bottom - 1.5} y2={height - bottom - 1.5} />
                  {emptyLabel && <text x={center(index)} y={height - bottom - 8 / scale} textAnchor="middle" className="dr-bar-missing-text" style={{ fontSize }}>なし</text>}
                </>
              )}
              {bar.label && <text x={center(index)} y={labelY} textAnchor="middle" style={{ fontSize }}>{bar.label}</text>}
            </g>
          );
        })}
      </svg>
      <ChartTooltip tooltip={tooltip} />
      {/* 1列のときは隣の配分の表が見えないので、図の下に凡例(2列では CSS で隠す) */}
      <ul className="dr-legend dr-bars-legend" aria-label="凡例">
        {(["study", "dev", "life", "media"] as const).map((category) => (
          <li key={category}><i aria-hidden="true" style={{ background: categoryColor(category) }} />{CATEGORY_LABELS[category]}</li>
        ))}
      </ul>
    </div>
  );
}

/** 配分の表: カテゴリ×(割合・合計・1日平均・比べる相手の1日平均)。行を押すとタグ別の内訳が開く。
 *  日次は合計と1日平均が同じなので「時間」の1列にする。 */
export function AllocationTable({ rows, range, reportDays, baseline }: { rows: AllocationRow[]; range: Range; reportDays: number; baseline: { days: number; label: string; shortLabel: string } }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const daily = range === "day";
  const toggle = (category: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    return next;
  });
  const diff = (average: number, base: number | null) => (base === null || baseline.days === 0 ? null : signedMinutes(average - base));
  const baseCell = (base: number | null) => (base === null || baseline.days === 0 ? "—" : formatMinutes(base));
  const maxPercent = Math.max(1, ...rows.map((row) => row.percent));

  return (
    <section className="asset-panel dr-panel">
      <div className="panel-heading">
        <div>
          <h2>配分</h2>
          <span>{daily ? `比べる相手は${baseline.label}` : `1日平均は日報のある${reportDays}日で割る`}</span>
        </div>
      </div>
      <div className="dr-table-scroll">
        <table className="asset-table dr-alloc">
          <thead>
            <tr>
              <th scope="col">カテゴリ</th>
              {!daily && <th scope="col">合計</th>}
              <th scope="col">{daily ? "時間" : "1日平均"}</th>
              <th scope="col">{baseline.shortLabel}{baseline.days > 0 && baseline.days < 3 ? "(参考)" : ""}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const expanded = open.has(row.category);
              const change = diff(row.average, row.baselineAverage);
              return (
                <Fragment key={row.category}>
                  <tr className="dr-alloc-row">
                    <th scope="row">
                      <button type="button" aria-expanded={expanded} onClick={() => toggle(row.category)}>
                        <svg className="dr-alloc-caret" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        <i aria-hidden="true" style={{ background: categoryColor(row.category) }} />
                        <span className="dr-alloc-name">{row.label}</span>
                        <span className="dr-alloc-pct">{row.percent > 0 && row.percent < 1 ? "<1" : Math.round(row.percent)}%</span>
                      </button>
                      <span className="dr-alloc-bar" aria-hidden="true"><span style={{ width: `${(row.percent / maxPercent) * 100}%`, background: categoryColor(row.category) }} /></span>
                    </th>
                    {!daily && <td>{formatMinutes(row.total)}</td>}
                    <td>{formatMinutes(row.average)}{change ? <small>{change}{daily ? "" : "/日"}</small> : null}</td>
                    <td className="dr-alloc-base">{baseCell(row.baselineAverage)}</td>
                  </tr>
                  {expanded && row.tags.map((tag) => (
                    <tr key={tag.tag} className="dr-alloc-tag">
                      <th scope="row">{tag.label}</th>
                      {!daily && <td>{formatMinutes(tag.total)}</td>}
                      <td>{formatMinutes(tag.average)}</td>
                      <td className="dr-alloc-base">{baseCell(tag.baselineAverage)}</td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="dr-note dr-alloc-note">行を押すとタグ別の内訳を開きます。{baseline.days > 0 ? `${baseline.shortLabel}は${baseline.days}日分の1日平均。` : `${baseline.shortLabel}の日報が無いため比較なし。`}</p>
    </section>
  );
}
