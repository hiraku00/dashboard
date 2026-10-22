"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { DayAxis, DayBand, categoryColor, reportHref, shortDate, type ReportTab } from "./daily-report-ui";
import {
  CATEGORY_LABELS,
  formatMinutes,
  weekdayLabel,
  type Category,
  type CategoryShare,
  type Range,
  type TimeAxis,
  type TimelineSegment,
  type WorkCategoryRow,
} from "./lib/daily-report-summary";

/** 時間の使い方・作業内容・知見・メモの各タブ(docs/daily-report-view-design.md §4.3〜§4.5)。 */

type Highlight = Category | "all";
const FILTER_CATEGORIES: Category[] = ["study", "dev", "life", "media"];

/** カテゴリの切り替え。期間の割合を添えて凡例を兼ねる(Manage Asset の period-control と同じ見た目)。 */
function CategoryFilter({ value, onChange, shares, withOther = false }: { value: Highlight; onChange: (value: Highlight) => void; shares: CategoryShare[]; withOther?: boolean }) {
  const percent = new Map(shares.map((share) => [share.category, share.percent]));
  const options: Highlight[] = ["all", ...FILTER_CATEGORIES, ...(withOther ? (["other"] as Category[]) : [])];
  return (
    <div className="period-control dr-filter" role="group" aria-label="カテゴリで絞り込む">
      {options.map((option) => (
        <button key={option} type="button" className={value === option ? "active" : ""} aria-pressed={value === option} onClick={() => onChange(option)}>
          {option === "all" ? "すべて" : (
            <>
              <i aria-hidden="true" style={{ background: categoryColor(option) }} />
              {CATEGORY_LABELS[option]}
              {percent.has(option) ? <span className="dr-filter-pct">{Math.round(percent.get(option) ?? 0)}%</span> : null}
            </>
          )}
        </button>
      ))}
    </div>
  );
}

/** その日の、選んだカテゴリ(すべてなら活動全体)の分数。帯の右の数字に使う。 */
function minutesFor(segments: TimelineSegment[], highlight: Highlight) {
  let total = 0;
  for (const segment of segments) {
    if (segment.isGap) continue;
    const duration = segment.endMinute - segment.startMinute;
    for (const part of segment.parts) if (highlight === "all" || part.category === highlight) total += duration * part.fraction;
  }
  return total;
}

type ProfileSlot = { hour: number; minutes: Partial<Record<Category, number>>; daysWithRecord: number };

/** 時刻別の平均: 選んだカテゴリ(すべてなら活動全体)の1時間あたりの平均分数を1色の棒で。縦軸は0・30・60分。
 *  帯と同じ横軸・同じ列幅(左のラベル列・右の数字列)で、帯の真下に揃える。 */
function Profile({ slots, axis, highlight }: { slots: ProfileSlot[]; axis: TimeAxis; highlight: Highlight }) {
  const span = axis.endHour - axis.startHour;
  const color = highlight === "all" ? "var(--c-all)" : categoryColor(highlight);
  return (
    <div className="dr-profile-block">
      <p className="dr-profile-title">時刻別の平均(1時間あたりの分)</p>
      <div className="dr-weekgrid dr-profile-row">
        <div className="dr-profile-yaxis" aria-hidden="true"><span>60</span><span>30</span><span>0</span></div>
        <div className="dr-profile-plot">
          <i className="dr-profile-line is-60" aria-hidden="true" />
          <i className="dr-profile-line is-30" aria-hidden="true" />
          {slots.map((slot) => {
            const minutes = highlight === "all" ? Object.values(slot.minutes).reduce((sum, value) => sum + (value ?? 0), 0) : slot.minutes[highlight] ?? 0;
            return (
              <span
                key={slot.hour}
                className="dr-profile-bar"
                style={{ left: `calc(${((slot.hour - axis.startHour) / span) * 100}% + 2px)`, width: `calc(${100 / span}% - 4px)`, height: `${Math.min(60, minutes) / 60 * 100}%`, background: color }}
                title={`${slot.hour}時台 平均${Math.round(minutes)}分(記録のあった日 ${slot.daysWithRecord}日)`}
              />
            );
          })}
        </div>
        <span />
      </div>
      <div className="dr-weekgrid"><span /><DayAxis axis={axis} /><span /></div>
    </div>
  );
}

/** 時間の使い方(週次・月次): カテゴリの切り替え＋週の帯(週次だけ)＋時刻別の平均を1枚のパネルに。 */
export function TimePanel({
  range,
  shares,
  weekRows,
  axis,
  profile,
  reportCount,
}: {
  range: Range;
  shares: CategoryShare[];
  weekRows: { date: string; hasReport: boolean; future: boolean; segments: TimelineSegment[] }[];
  axis: TimeAxis;
  profile: ProfileSlot[];
  reportCount: number;
}) {
  const [highlight, setHighlight] = useState<Highlight>("all");
  return (
    <section className="asset-panel dr-panel">
      <div className="panel-heading">
        <div>
          <h2>時間帯</h2>
          <span>{range === "week" ? "曜日を押すとその日へ" : `日報のある${reportCount}日の平均`}</span>
        </div>
        <CategoryFilter value={highlight} onChange={setHighlight} shares={shares} />
      </div>
      <div className="dr-panel-body">
        {range === "week" && (
          <div className="dr-week">
            <div className="dr-weekgrid"><span /><DayAxis axis={axis} /><span /></div>
            {weekRows.map((row) => (
              <div key={row.date} className={`dr-weekgrid dr-weekrow${row.future ? " is-future" : ""}`}>
                {row.hasReport ? (
                  <Link href={reportHref("day", row.date, "time")} prefetch={false}>{weekdayLabel(row.date)}<small>{Number(row.date.slice(8, 10))}</small></Link>
                ) : (
                  <span>{weekdayLabel(row.date)}<small>{Number(row.date.slice(8, 10))}</small></span>
                )}
                {row.hasReport ? <DayBand segments={row.segments} axis={axis} height={20} highlight={highlight} /> : <div className="dr-band is-missing" style={{ height: 20 }}>{row.future ? "" : "日報なし"}</div>}
                <em>{row.hasReport ? formatMinutes(minutesFor(row.segments, highlight)) : ""}</em>
              </div>
            ))}
          </div>
        )}
        <Profile slots={profile} axis={axis} highlight={highlight} />
        <ul className="dr-legend dr-time-legend">
          <li><i aria-hidden="true" style={{ background: highlight === "all" ? "var(--c-all)" : categoryColor(highlight) }} />{highlight === "all" ? "活動" : CATEGORY_LABELS[highlight]}</li>
          {highlight !== "all" && <li><i aria-hidden="true" style={{ background: "var(--c-dim)" }} />ほかの活動</li>}
          <li><i aria-hidden="true" className="dr-hatch" />ログなし</li>
          {range === "week" && <li><i aria-hidden="true" className="dr-dash" />日報なし</li>}
        </ul>
      </div>
    </section>
  );
}

/** 作業内容: タグ単位の表。カテゴリの小計の行の下にタグを並べ、行を押すとそのタグの作業項目を日付順に出す(§4.4)。 */
export function WorkTable({ rows, showDays, tab }: { rows: WorkCategoryRow[]; showDays: boolean; tab: ReportTab }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (tag: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    return next;
  });
  const columns = showDays ? 4 : 3;
  return (
    <section className="asset-panel dr-panel">
      <div className="panel-heading">
        <div>
          <h2>作業内容</h2>
          <span>タグごと・行を押すと日付順の作業を開きます</span>
        </div>
      </div>
      <div className="dr-table-scroll">
        <table className="asset-table dr-work-table">
          <thead>
            <tr>
              <th scope="col">タグ</th>
              <th scope="col" className="is-num">時間</th>
              {showDays && <th scope="col" className="is-num">日数</th>}
              <th scope="col">最新の内容</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.category}>
                <tr className="dr-work-category">
                  <th scope="rowgroup"><i aria-hidden="true" style={{ background: categoryColor(row.category) }} />{row.label}</th>
                  <td className="is-num">{row.minutes ? formatMinutes(row.minutes) : "—"}</td>
                  {showDays && <td />}
                  <td />
                </tr>
                {row.tags.map((tag) => {
                  const expanded = open.has(tag.tag);
                  const latest = tag.items[0];
                  return (
                    <Fragment key={tag.tag}>
                      <tr className="dr-work-tag">
                        <th scope="row">
                          <button type="button" aria-expanded={expanded} onClick={() => toggle(tag.tag)} disabled={!tag.items.length}>
                            <svg className="dr-alloc-caret" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                            {tag.label}
                          </button>
                        </th>
                        <td className="is-num">{tag.minutes === null ? "—" : formatMinutes(tag.minutes)}</td>
                        {showDays && <td className="is-num">{tag.days}日</td>}
                        <td className="dr-work-latest">{latest ? <span>{showDays ? <time>{shortDate(latest.reportDate)}</time> : null}{latest.text}</span> : <span className="is-muted">作業項目なし</span>}</td>
                      </tr>
                      {expanded && (
                        <tr className="dr-work-items">
                          <td colSpan={columns}>
                            <table>
                              <tbody>
                                {tag.items.map((item, index) => (
                                  <tr key={index}>
                                    {showDays && <th scope="row"><Link href={reportHref("day", item.reportDate, tab)} prefetch={false}>{shortDate(item.reportDate)}</Link></th>}
                                    <td>{item.text}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 知見・メモ: 表＋検索欄＋カテゴリの切り替え(§4.5)。同じ日の2件目以降は日付を空にする。 */
export function NotesTable({ notes, showDate, tab }: { notes: { reportDate: string; text: string; category: Category }[]; showDate: boolean; tab: ReportTab }) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<Highlight>("all");
  const shares = useMemo(() => {
    const counts = new Map<Category, number>();
    for (const note of notes) counts.set(note.category, (counts.get(note.category) ?? 0) + 1);
    return [...counts.entries()].map(([category, count]) => ({ category, label: CATEGORY_LABELS[category], minutes: count, percent: (count / Math.max(1, notes.length)) * 100 }));
  }, [notes]);
  const needle = query.trim().toLowerCase();
  const visible = notes.filter((note) => (highlight === "all" || note.category === highlight) && (!needle || note.text.toLowerCase().includes(needle)));
  return (
    <section className="asset-panel dr-panel">
      <div className="panel-heading">
        <div>
          <h2>知見・メモ</h2>
          <span>{visible.length === notes.length ? `${notes.length}件` : `${notes.length}件中${visible.length}件`}</span>
        </div>
      </div>
      <div className="dr-notes-tools">
        <label className="dr-search">
          <span className="sr-only">知見を検索</span>
          <input type="search" value={query} placeholder="知見を検索" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <CategoryFilter value={highlight} onChange={setHighlight} shares={shares} withOther />
      </div>
      <div className="dr-table-scroll">
        <table className="asset-table dr-notes-table">
          <thead>
            <tr>
              {showDate && <th scope="col">日付</th>}
              <th scope="col">知見</th>
              <th scope="col">カテゴリ</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((note, index) => {
              const firstOfDay = index === 0 || visible[index - 1].reportDate !== note.reportDate;
              return (
                <tr key={`${note.reportDate}-${index}`} className={firstOfDay && index > 0 ? "is-new-day" : undefined}>
                  {showDate && <th scope="row">{firstOfDay ? <Link href={reportHref("day", note.reportDate, tab)} prefetch={false}>{shortDate(note.reportDate)}</Link> : null}</th>}
                  <td className="dr-note-text">{note.text}</td>
                  <td className="dr-note-cat"><i aria-hidden="true" style={{ background: categoryColor(note.category) }} />{CATEGORY_LABELS[note.category]}</td>
                </tr>
              );
            })}
            {!visible.length && <tr><td colSpan={showDate ? 3 : 2} className="is-muted">当てはまる知見はありません。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
