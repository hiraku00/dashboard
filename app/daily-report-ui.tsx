import type { CSSProperties } from "react";
import {
  axisTicks,
  formatClock,
  formatMinutes,
  tagLabel,
  groupOfTag,
  type BreakdownGroup,
  type DisplayGroup,
  type TimeAxis,
  type TimelineSegment,
} from "./lib/daily-report-summary";

/** 作業日報の共通部品(docs/daily-report-view-design.md §3・§4)。色・模様・時間の表記は全画面でここに揃える
 *  (反復)。サーバー/クライアントのどちらからも使えるよう、状態は持たず、操作はコールバックで受ける。 */

const groupColor = (group: DisplayGroup) => `var(--g-${group})`;

export function Chip({ tag }: { tag: string }) {
  return (
    <span className="dr-chip">
      <i aria-hidden="true" style={{ background: groupColor(groupOfTag(tag)) }} />
      {tagLabel(tag)}
    </span>
  );
}

/** 時刻の目盛り。帯と同じ横軸(左端=axis.startHour)で、上下に並べたとき目盛りが揃う。 */
export function DayAxis({ axis }: { axis: TimeAxis }) {
  const span = axis.endHour - axis.startHour;
  return (
    <div className="dr-axis" aria-hidden="true">
      {axisTicks(axis).map((hour) => (
        <span key={hour} style={{ left: `${((hour - axis.startHour) / span) * 100}%` }}>{hour % 24}</span>
      ))}
    </div>
  );
}

function segmentTitle(segment: TimelineSegment) {
  const range = `${formatClock(segment.startMinute)}〜${formatClock(segment.endMinute)}`;
  const duration = segment.durationMinutes === null ? "" : ` ${formatMinutes(segment.durationMinutes)}`;
  if (segment.isGap) return `${range}${duration} ログなし`;
  const tags = segment.parts.map((part) => tagLabel(part.tag)).join("・");
  return `${range}${duration} ${segment.activity}${segment.parts.length > 1 ? `\n${tags}(複数のタグは等分)` : `\n${tags}`}`;
}

/** 1日の時間帯の帯。色=グループ、斜線=ログなし。複数のタグが付いた時間帯は等分して塗る。 */
export function DayBand({
  segments,
  axis,
  height = 28,
  activePosition = null,
  onActive,
}: {
  segments: TimelineSegment[];
  axis: TimeAxis;
  height?: number;
  activePosition?: number | null;
  onActive?: (position: number | null) => void;
}) {
  const origin = axis.startHour * 60;
  const span = (axis.endHour - axis.startHour) * 60;
  return (
    <div className="dr-band" style={{ height }} onMouseLeave={onActive ? () => onActive(null) : undefined}>
      {segments.map((segment) => {
        const left = Math.max(0, ((segment.startMinute - origin) / span) * 100);
        const width = Math.max(0, ((Math.min(segment.endMinute, origin + span) - Math.max(segment.startMinute, origin)) / span) * 100);
        const classes = ["dr-seg", segment.isGap ? "is-gap" : "", activePosition === segment.position ? "is-active" : activePosition !== null ? "is-dim" : ""].filter(Boolean).join(" ");
        return (
          <div
            key={segment.position}
            className={classes}
            style={{ left: `calc(${left}% + 1px)`, width: `calc(${width}% - 2px)` }}
            title={segmentTitle(segment)}
            onMouseEnter={onActive ? () => onActive(segment.position) : undefined}
            onClick={onActive ? () => onActive(activePosition === segment.position ? null : segment.position) : undefined}
          >
            {segment.parts.map((part) => (
              <span key={part.tag} style={{ flex: part.fraction, background: groupColor(part.group) }} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** 凡例(帯の下) */
export function BandLegend({ showMissing = false }: { showMissing?: boolean }) {
  return (
    <p className="dr-legend">
      <span><i className="dr-hatch" aria-hidden="true" />ログなし(記録の欠落)</span>
      {showMissing && <span><i className="dr-dash" aria-hidden="true" />日報なし</span>}
    </p>
  );
}

/** グループ別の割合を1本にした100%横棒。値は直接ラベルに書き、凡例を兼ねる。分母は活動時間(欠落は入れない)。 */
export function StackedBar({ shares }: { shares: { group: DisplayGroup; label: string; minutes: number; percent: number }[] }) {
  if (!shares.length) return null;
  return (
    <div className="dr-stacked">
      <div className="dr-stack-bar" role="img" aria-label={shares.map((share) => `${share.label} ${Math.round(share.percent)}%`).join("、")}>
        {shares.map((share) => (
          <span key={share.group} style={{ flex: share.minutes, background: groupColor(share.group) }}>
            {share.percent >= 12 ? `${Math.round(share.percent)}%` : ""}
          </span>
        ))}
      </div>
      <ul className="dr-stack-legend">
        {shares.map((share) => (
          <li key={share.group}>
            <i aria-hidden="true" style={{ background: groupColor(share.group) }} />
            {share.label} <b>{Math.round(share.percent)}%</b> <small>{formatMinutes(share.minutes)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** グループの見出しの下にタグを並べた横棒。縦線の目盛りが「比べる相手」(baseline)。
 *  相手の日数が3日未満なら目盛りを点線にして参考扱いにし、0日なら出さない。 */
export function BulletRows({ groups, baselineDays }: { groups: BreakdownGroup[]; baselineDays: number }) {
  const max = Math.max(1, ...groups.flatMap((entry) => [entry.minutes, entry.baselineMinutes ?? 0, ...entry.tags.flatMap((tag) => [tag.minutes, tag.baselineMinutes ?? 0])]));
  const showTick = baselineDays > 0;
  const tentative = baselineDays > 0 && baselineDays < 3;
  const row = (key: string, label: string, minutes: number, baseline: number | null, color: string, isGroup: boolean) => {
    const style: CSSProperties = { background: color };
    return (
      <div className={`dr-bullet-row${isGroup ? " is-group" : ""}`} key={key}>
        <span className="dr-bullet-label">{label}</span>
        <span className="dr-bullet-track">
          <span className="dr-bullet-bar" style={{ ...style, width: `${(minutes / max) * 100}%` }} />
          {showTick && baseline !== null && <span className={`dr-bullet-tick${tentative ? " is-tentative" : ""}`} style={{ left: `${(baseline / max) * 100}%` }} />}
        </span>
        <span className="dr-bullet-value">{formatMinutes(minutes)}</span>
      </div>
    );
  };
  return (
    <div className="dr-bullet">
      {groups.map((entry) => [
        row(`g-${entry.group}`, entry.label, entry.minutes, entry.baselineMinutes, groupColor(entry.group), true),
        ...(entry.group === "other" ? [] : entry.tags.map((tag) => row(`t-${tag.tag}`, tag.label, tag.minutes, tag.baselineMinutes, groupColor(entry.group), false))),
      ])}
      {showTick && (
        <p className="dr-legend">
          <span><i className="dr-tick" aria-hidden="true" />直近28日の1日平均({baselineDays}日分{tentative ? "・参考" : ""})</span>
        </p>
      )}
    </div>
  );
}
