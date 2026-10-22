"use client";

import { useMemo, useState } from "react";
import { CategoryLegend, DayAxis, DayBand, categoryColor } from "./daily-report-ui";
import { CATEGORY_LABELS, axisRange, categoryOfTag, categoryShares, formatClock, formatMinutes, timelineSegments, type TimelineBlockInput } from "./lib/daily-report-summary";

/** 1日のタイムライン(帯)と時間帯の表。帯のホバー/タップで表の該当行を、表の行のホバーで帯を強調する。
 *  表のカテゴリは1列に1つ(最初のタグのカテゴリ)。第3版のタグのチップはやめた(設計書 §4.3)。 */
export function DayTimeline({ blocks }: { blocks: TimelineBlockInput[] }) {
  const [active, setActive] = useState<number | null>(null);
  const segments = useMemo(() => timelineSegments(blocks), [blocks]);
  const axis = useMemo(() => axisRange(segments), [segments]);
  // 凡例の割合: 帯に描いた時間をカテゴリごとに足す(複数タグは等分)
  const shares = useMemo(() => {
    const minutes: Record<string, number> = {};
    for (const segment of segments) {
      if (segment.isGap) continue;
      for (const part of segment.parts) minutes[part.tag] = (minutes[part.tag] ?? 0) + (segment.endMinute - segment.startMinute) * part.fraction;
    }
    return categoryShares(minutes);
  }, [segments]);
  return (
    <>
      <div className="dr-timeline">
        <DayAxis axis={axis} />
        <DayBand segments={segments} axis={axis} height={36} activePosition={active} onActive={setActive} />
        <CategoryLegend shares={shares} />
      </div>
      <div className="dr-table-scroll">
        <table className="asset-table dr-blocks">
          <thead>
            <tr><th scope="col">時間帯</th><th scope="col" className="is-num">所要</th><th scope="col">作業内容</th><th scope="col">カテゴリ</th></tr>
          </thead>
          <tbody>
            {blocks.map((block) => {
              const category = block.isGap ? null : categoryOfTag(block.tags[0] ?? "other");
              return (
                <tr
                  key={block.position}
                  className={[block.isGap ? "is-gap" : "", active === block.position ? "is-active" : ""].filter(Boolean).join(" ")}
                  onMouseEnter={() => setActive(block.position)}
                  onMouseLeave={() => setActive(null)}
                >
                  <th scope="row">{block.startMinute !== null && block.endMinute !== null ? `${formatClock(block.startMinute)}〜${formatClock(block.endMinute)}` : "—"}</th>
                  <td className="is-num">{block.durationMinutes === null ? "—" : formatMinutes(block.durationMinutes)}</td>
                  <td>{block.activity}</td>
                  <td className="dr-note-cat">{category ? <><i aria-hidden="true" style={{ background: categoryColor(category) }} />{CATEGORY_LABELS[category]}</> : "ログなし"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
