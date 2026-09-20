"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** SVG のユーザー座標系上の点。x はグラフの横位置（データ点の並び順）。 */
export type ChartHoverPoint = { x: number; y: number; lines: string[] };

type TooltipState = { left: number; top: number; lines: string[] };

/** app-ui.js の attachChartTooltip 相当。pointermove で最も近いデータ点（x 距離）を
 *  探し、その画面座標にツールチップを浮かせる。SVG は viewBox でスケールされるため、
 *  getScreenCTM() でユーザー座標⇄画面座標を変換する。 */
export function useChartHoverTooltip(points: ChartHoverPoint[], externalRef?: RefObject<HTMLDivElement | null>) {
  const ownRef = useRef<HTMLDivElement>(null);
  const containerRef = externalRef ?? ownRef;
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!points.length) return;
    const svg = event.currentTarget;
    const ctm = svg.getScreenCTM();
    const container = containerRef.current;
    if (!ctm || !container) return;

    const cursor = svg.createSVGPoint();
    cursor.x = event.clientX;
    cursor.y = event.clientY;
    const cursorUser = cursor.matrixTransform(ctm.inverse());

    let nearest = points[0];
    let nearestDistance = Infinity;
    for (const point of points) {
      const distance = Math.abs(point.x - cursorUser.x);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = point;
      }
    }

    const screenPoint = svg.createSVGPoint();
    screenPoint.x = nearest.x;
    screenPoint.y = nearest.y;
    const screen = screenPoint.matrixTransform(ctm);
    const containerRect = container.getBoundingClientRect();
    setTooltip({ left: screen.x - containerRect.left, top: screen.y - containerRect.top, lines: nearest.lines });
  }

  function handlePointerLeave() {
    setTooltip(null);
  }

  return { containerRef, tooltip, handlePointerMove, handlePointerLeave };
}

/** SVG は viewBox でコンテナ幅に合わせて拡大縮小されるため、user-space で同じ
 *  font-size を指定していても、コンテナが広いページほど実際の画面上のピクセル
 *  サイズは大きくなる（資産推移はドーナツと2列、通貨推移は280px固定カードと2列
 *  ……とページごとにコンテナ幅の比率が違うため、この差が実際に出ていた）。
 *  ResizeObserver で実測した「1 user-space単位あたりの実ピクセル数」を返し、
 *  呼び出し側が toPhysicalPx(desiredPx) = desiredPx / scale を font-size に
 *  使うことで、コンテナ幅に関係なく物理サイズを一定に保つ。 */
export function useSvgFontScale(containerRef: RefObject<HTMLDivElement | null>, viewBoxWidth: number, renderKey: unknown = null) {
  const [scale, setScale] = useState(1);

  // containerRef.current swaps to a new DOM node whenever the caller's early
  // return flips between the empty-state <div> (no ref) and the chart <svg>
  // wrap (ref attached) -- e.g. switching the currency select from a
  // single-snapshot symbol to one with history. A plain useRef mutation like
  // that doesn't change identity, so an effect keyed only on
  // [containerRef, viewBoxWidth] never reruns to observe the new node and
  // `scale` stays stuck at its very first reading (1, if the chart wasn't
  // even mounted yet on that first run). renderKey lets the caller pass
  // something that changes across that transition (e.g. data.length) so the
  // observer actually gets re-attached to the node that is mounted now.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const width = el.getBoundingClientRect().width;
      if (width > 0) setScale(width / viewBoxWidth);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef, viewBoxWidth, renderKey]);

  return scale;
}

/** y 軸ラベルの左余白・ラベル〜プロット間の隙間・縦方向の倍率。ラベルは画面上で一定の
 *  物理サイズ（useSvgFontScale）なので、コンテナが狭いほど user-space 上の幅・隙間が
 *  膨らむ。固定の余白ではカード外へはみ出し、隙間も潰れる。また viewBox は縦横比固定で
 *  縮むため、縦方向（グラフ高さ・上下余白）も潰れて2段ラベルが重なる。`vk` は縦方向の
 *  user-space 寸法に掛ける倍率で、狭い画面では 1/scale（=PC と同じ画面 px の高さ）になる。
 *  PC 相当の幅（scale が十分大きい）では従来値・vk=1 を返し、描画を変えない。 */
const AXIS_WIDE_SCALE = 0.85;
const AXIS_GAP_PX = 8;
export function axisLayout(baseLeft: number, baseGap: number, scale: number, labels: { text: string; fontSize: number }[]) {
  if (scale >= AXIS_WIDE_SCALE) return { left: baseLeft, gap: baseGap, vk: 1 };
  const glyphWidth = (char: string) => (char === "," || char === "." ? 0.3 : 0.6);
  const widest = Math.max(0, ...labels.map(({ text, fontSize }) => [...text].reduce((sum, char) => sum + glyphWidth(char), 0) * fontSize));
  const gap = Math.max(baseGap, AXIS_GAP_PX / scale);
  return { left: Math.max(baseLeft, Math.ceil(widest + gap)), gap, vk: 1 / scale };
}

export function ChartTooltip({ tooltip }: { tooltip: { left: number; top: number; lines: string[] } | null }) {
  if (!tooltip) return null;
  return (
    <div className="chart-tooltip" style={{ left: tooltip.left, top: tooltip.top }} role="status">
      {tooltip.lines.map((line, index) => (
        <div key={index}>{line}</div>
      ))}
    </div>
  );
}
