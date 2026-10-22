"use client";

import { useMemo, useState } from "react";
import { Chip, DayAxis, DayBand } from "./daily-report-ui";
import { axisRange, formatClock, formatMinutes, timelineSegments, type TimelineBlockInput } from "./lib/daily-report-summary";

/** 1日のタイムライン(帯)と時間帯の表。帯のホバー/タップで表の該当行を、表の行のホバーで帯を強調する。 */
export function DayTimeline({ blocks }: { blocks: TimelineBlockInput[] }) {
  const [active, setActive] = useState<number | null>(null);
  const segments = useMemo(() => timelineSegments(blocks), [blocks]);
  const axis = useMemo(() => axisRange(segments), [segments]);
  return (
    <>
      <div className="dr-timeline">
        <DayAxis axis={axis} />
        <DayBand segments={segments} axis={axis} height={36} activePosition={active} onActive={setActive} />
      </div>
      <div className="dr-table-scroll">
        <table className="asset-table dr-blocks">
          <thead>
            <tr><th scope="col">時間帯</th><th scope="col">所要</th><th scope="col">作業内容</th></tr>
          </thead>
          <tbody>
            {blocks.map((block) => (
              <tr
                key={block.position}
                className={[block.isGap ? "is-gap" : "", active === block.position ? "is-active" : ""].filter(Boolean).join(" ")}
                onMouseEnter={() => setActive(block.position)}
                onMouseLeave={() => setActive(null)}
              >
                <td>{block.startMinute !== null && block.endMinute !== null ? `${formatClock(block.startMinute)}〜${formatClock(block.endMinute)}` : "—"}</td>
                <td>{block.durationMinutes === null ? "—" : formatMinutes(block.durationMinutes)}</td>
                <td>
                  {block.activity}
                  {block.tags.length > 0 && <span className="dr-chips">{block.tags.map((tag) => <Chip key={tag} tag={tag} />)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
