"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** SVG のユーザー座標系上の点。x はグラフの横位置（データ点の並び順）。 */
export type ChartHoverPoint = { x: number; y: number; lines: string[] };

type TooltipState = { left: number; top: number; lines: string[] };

/** app-ui.js の attachChartTooltip 相当。pointermove で最も近いデータ点（x 距離）を
 *  探し、その画面座標にツールチップを浮かせる。SVG は viewBox でスケールされるため、
 *  getScreenCTM() でユーザー座標⇄画面座標を変換する。 */
export function useChartHoverTooltip(points: ChartHoverPoint[]) {
  const containerRef = useRef<HTMLDivElement>(null);
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
