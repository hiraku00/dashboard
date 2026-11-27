"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { PortalHeader } from "./portal-nav";
import type { MorningDay, MorningPageModel, TrendPoint } from "./lib/morning-page-model";
import { PLACE_GROUPS, classifyPlace, placeGroupLabel, type PlaceGroup } from "./lib/morning-page-places";
import { outfitParts } from "./lib/outfit";

/** /morning-page のワークスペース(docs/morning-page-design.md)。日報の画面と同じく、ヘッダーの下の機能内タブで切り口を替え、
 *  全タブを描いて `hidden` で隠す(切り替えは即時、URLは tab だけ書き換える)。月と気がかりの年はリンクで替え、サーバーが読み直す。
 *  推移: 全期間の月ごとのグラフ(年で絞る) / 月: 1か月の日ごとの棒と、押した日の中身 / 気がかり: 年ごとの一覧と、全期間の検索 */

export type MorningTab = "trend" | "month" | "notes";
const TABS: [MorningTab, string][] = [["trend", "推移"], ["month", "月"], ["notes", "気がかり"]];

const KIND_LABEL = { yesterday: "昨日のこと", plan: "今日の予定", notes: "気がかり" } as const;

const href = (params: { month?: string | null; year?: string | null; tab: MorningTab }) => {
  const query = new URLSearchParams();
  if (params.month) query.set("month", params.month);
  if (params.year) query.set("year", params.year);
  query.set("tab", params.tab);
  return `/morning-page?${query.toString()}`;
};
const minutesText = (minutes: number | null) => (minutes === null ? "—" : minutes < 60 ? `${minutes}分` : `${Math.floor(minutes / 60)}時間${String(minutes % 60).padStart(2, "0")}分`);
/** 縦軸用: 1時間ちょうどは「1時間」、それ以外は「1時間30分」 */
const axisMinutes = (minutes: number) => (minutes === 0 ? "0" : minutes % 60 === 0 && minutes >= 60 ? `${minutes / 60}時間` : minutesText(minutes));
const shortDate = (date: string, weekday?: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}${weekday ? `(${weekday})` : ""}`;
const groupClass = (group: PlaceGroup | null) => (group ? ` is-${group}` : "");

function Panel({ title, sub, actions, children }: { title: string; sub?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="asset-panel dr-panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {sub ? <span>{sub}</span> : null}
        </div>
        {actions}
      </div>
      <div className="dr-panel-body">{children}</div>
    </section>
  );
}

/** 年などを1つ選ぶ、丸いボタンの列 */
function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return (
    <div className="mp-chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className={option.value === value ? "is-current" : undefined} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

export function MorningPageApp({ model, initialTab }: { model: MorningPageModel; initialTab: MorningTab }) {
  const [tab, setTab] = useState<MorningTab>(initialTab);

  const selectTab = (next: MorningTab) => {
    setTab(next);
    try {
      window.history.replaceState(null, "", href({ month: model.month, year: model.notesYear, tab: next }));
    } catch {
      // history が使えない環境でも、タブの切り替え自体は動く
    }
  };

  return (
    <main className="portal-shell asset-workspace daily-report-workspace">
      <PortalHeader title="モーニングページ" active="/morning-page">
        <nav className="asset-tabs" aria-label="モーニングページ メニュー">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => selectTab(id)}>
              {label}
            </button>
          ))}
        </nav>
      </PortalHeader>

      {model.empty ? (
        <section className="asset-panel dr-panel"><p className="dr-empty">モーニングページはまだありません。auto-daily-report の morning_pages.py で送ると表示されます。</p></section>
      ) : (
        <>
          <div hidden={tab !== "trend"}><TrendTab model={model} /></div>
          <div hidden={tab !== "month"}><MonthTab model={model} /></div>
          <div hidden={tab !== "notes"}><NotesTab model={model} /></div>
        </>
      )}
    </main>
  );
}

function Figure({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="dr-rf-figure">
      <p>{label}</p>
      <strong>{value}</strong>
      {sub ? <span>{sub}</span> : null}
    </div>
  );
}

function PlaceLegend({ groups }: { groups: PlaceGroup[] }) {
  if (!groups.length) return null;
  return (
    <ul className="mp-legend" aria-label="場所の色">
      {groups.map((group) => <li key={group}><i className={`mp-swatch${groupClass(group)}`} />{placeGroupLabel(group)}</li>)}
    </ul>
  );
}

/* ───────── 推移 ───────── */

type Metric = "minutes" | "chars";

/** 推移: 全期間(または選んだ年)の月ごとのグラフ。書いた日数を場所で積み上げ、所要時間・文字数は切り替えて出す */
function TrendTab({ model }: { model: MorningPageModel }) {
  const years = model.years.map((group) => group.year);
  const [year, setYear] = useState<string>("all");
  const [metric, setMetric] = useState<Metric>("minutes");
  const points = year === "all" ? model.trend : model.trend.filter((point) => point.month.startsWith(year));

  const pages = points.reduce((sum, point) => sum + point.pages, 0);
  const days = points.reduce((sum, point) => sum + point.daysInMonth, 0);
  // 月の平均を、その月のページ数で重み付けして全体の平均にする(所要時間・文字数の無いページも1ページとして数える近似)
  const weighted = (pick: (point: TrendPoint) => number | null) => {
    const known = points.filter((point) => pick(point) !== null);
    const weight = known.reduce((sum, point) => sum + point.pages, 0);
    return weight ? Math.round(known.reduce((sum, point) => sum + (pick(point) ?? 0) * point.pages, 0) / weight) : null;
  };
  const avgMinutes = weighted((point) => point.avgMinutes);
  const avgChars = weighted((point) => point.avgChars);
  const usedGroups = PLACE_GROUPS.map((entry) => entry.group).filter((group) => points.some((point) => point.places[group] > 0));
  const scope = year === "all" ? `${points[0]?.label ?? ""}〜${points.at(-1)?.label ?? ""}` : `${year}年`;

  return (
    <div className="dr-stack">
      <section className="asset-panel dr-panel">
        <div className="mp-filter">
          <Chips label="年で絞る" value={year} onChange={setYear} options={[{ value: "all", label: "全期間" }, ...years.map((value) => ({ value, label: `${value}年` }))]} />
        </div>
        <div className="dr-rf-figures mp-figures">
          <Figure label="書いた日" value={<>{pages.toLocaleString("ja-JP")}<small>/{days.toLocaleString("ja-JP")}日</small></>} sub={days ? `${Math.round((pages / days) * 100)}%（${scope}）` : undefined} />
          <Figure label="平均の所要時間" value={minutesText(avgMinutes)} />
          <Figure label="平均の文字数" value={avgChars === null ? "—" : <>{avgChars.toLocaleString("ja-JP")}<small>字</small></>} />
        </div>
      </section>

      <Panel title="書いた日数と場所" sub="月ごと。色は書いた場所。棒を押すとその月へ">
        <ColumnChart
          points={points}
          max={31}
          ticks={[0, 10, 20, 30]}
          tickLabel={(value) => `${value}日`}
          ariaLabel={`${scope}の月ごとの書いた日数`}
          render={(point) => usedGroups.map((group) => (point.places[group] > 0 ? <i key={group} className={`mp-seg${groupClass(group)}`} style={{ height: `${(point.places[group] / 31) * 100}%` }} /> : null))}
          title={(point) => [`${point.label} ${point.pages}/${point.daysInMonth}日`, ...usedGroups.filter((group) => point.places[group] > 0).map((group) => `${placeGroupLabel(group)} ${point.places[group]}日`)].join("\n")}
        />
        <PlaceLegend groups={usedGroups} />
      </Panel>

      <Panel
        title={metric === "minutes" ? "平均の所要時間" : "平均の文字数"}
        sub="月ごと。書いた日だけの平均"
        actions={<Chips label="出す数字" value={metric} onChange={setMetric} options={[{ value: "minutes", label: "所要時間" }, { value: "chars", label: "文字数" }]} />}
      >
        <MetricChart points={points} metric={metric} scope={scope} />
      </Panel>
    </div>
  );
}

function MetricChart({ points, metric, scope }: { points: TrendPoint[]; metric: Metric; scope: string }) {
  const value = (point: TrendPoint) => (metric === "minutes" ? point.avgMinutes : point.avgChars);
  const step = metric === "minutes" ? 15 : 1000;
  const max = Math.max(step, Math.ceil(Math.max(0, ...points.map((point) => value(point) ?? 0)) / step) * step);
  const tickStep = max / step > 6 ? step * Math.ceil(max / step / 4) : step;
  const ticks = Array.from({ length: Math.floor(max / tickStep) + 1 }, (_, index) => index * tickStep);
  const label = (amount: number) => (metric === "minutes" ? (amount ? minutesText(amount) : "0") : amount ? `${(amount / 1000).toLocaleString("ja-JP")}千字` : "0");
  return (
    <ColumnChart
      points={points}
      max={max}
      ticks={ticks}
      tickLabel={label}
      ariaLabel={`${scope}の月ごとの${metric === "minutes" ? "平均の所要時間" : "平均の文字数"}`}
      render={(point) => (value(point) === null ? null : <i className="mp-seg is-metric" style={{ height: `${((value(point) ?? 0) / max) * 100}%` }} />)}
      title={(point) => `${point.label} ${metric === "minutes" ? minutesText(point.avgMinutes) : point.avgChars === null ? "—" : `${point.avgChars.toLocaleString("ja-JP")}字`}`}
    />
  );
}

/** 月ごとの縦棒(CSS grid)。目盛りは左、月の数字は下(1月と先頭の月には年も)。棒はその月へのリンク */
function ColumnChart({ points, max, ticks, tickLabel, ariaLabel, render, title }: {
  points: TrendPoint[];
  max: number;
  ticks: number[];
  tickLabel: (value: number) => string;
  ariaLabel: string;
  render: (point: TrendPoint) => ReactNode;
  title: (point: TrendPoint) => string;
}) {
  return (
    <div className="mp-chart" role="group" aria-label={ariaLabel}>
      <div className="mp-chart-axis" aria-hidden="true">
        {ticks.map((tick) => <span key={tick} style={{ bottom: `${(tick / max) * 100}%` }}>{tickLabel(tick)}</span>)}
      </div>
      <div className="mp-chart-scroll">
        <div className="mp-chart-plot" style={{ ["--n" as string]: points.length }}>
          {ticks.map((tick) => <i key={tick} className="mp-chart-grid" style={{ bottom: `${(tick / max) * 100}%` }} aria-hidden="true" />)}
          {points.map((point, index) => {
            const monthNumber = Number(point.month.slice(5, 7));
            const showYear = index === 0 || monthNumber === 1;
            return (
              <Link key={point.month} href={href({ month: point.month, tab: "month" })} prefetch={false} className="mp-col" title={title(point)} aria-label={title(point).replace(/\n/g, "、")}>
                <span className="mp-col-bar">{render(point)}</span>
                <span className="mp-col-label">{monthNumber}{showYear ? <b>{point.month.slice(0, 4)}</b> : null}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ───────── 月 ───────── */

/** 月の選択: 年を選び、その年の12か月から選ぶ(データのある月だけ押せる)。前後の月へも動ける */
function MonthPicker({ model }: { model: MorningPageModel }) {
  const [year, setYear] = useState(model.month?.slice(0, 4) ?? model.years.at(-1)?.year ?? "");
  const months = new Map((model.years.find((group) => group.year === year)?.months ?? []).map((item) => [item.month, item.pages]));
  return (
    <section className="asset-panel dr-panel mp-picker">
      <div className="mp-picker-head">
        {model.prev ? <Link className="mp-step" href={href({ month: model.prev, tab: "month" })} prefetch={false} aria-label="前の月">‹</Link> : <span className="mp-step is-off" aria-hidden="true">‹</span>}
        <strong>{model.monthLabel}</strong>
        {model.next ? <Link className="mp-step" href={href({ month: model.next, tab: "month" })} prefetch={false} aria-label="次の月">›</Link> : <span className="mp-step is-off" aria-hidden="true">›</span>}
      </div>
      <div className="mp-picker-body">
        <Chips label="年" value={year} onChange={setYear} options={model.years.map((group) => ({ value: group.year, label: `${group.year}年` }))} />
        <div className="mp-months">
          {Array.from({ length: 12 }, (_, index) => {
            const month = `${year}-${String(index + 1).padStart(2, "0")}`;
            const pages = months.get(month);
            return pages === undefined ? (
              <span key={month} className="is-empty">{index + 1}月</span>
            ) : (
              <Link key={month} href={href({ month, tab: "month" })} prefetch={false} className={month === model.month ? "is-current" : undefined} aria-current={month === model.month ? "date" : undefined} title={`${pages}日分`}>{index + 1}月</Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Items({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="mp-items">
      <h3>{title}</h3>
      <ul>{items.map((text, index) => <li key={index}>{text}</li>)}</ul>
    </div>
  );
}

/** 押した日の中身(昨日のこと・今日の予定・気がかり) */
function DayDetail({ day }: { day: MorningDay }) {
  const hasText = day.yesterday.length + day.plan.length + day.notes.length > 0;
  return (
    <div className="mp-day">
      <div className="mp-day-head">
        <b>{shortDate(day.date, day.weekday)}</b>
        <span>{day.startedAt ? `${day.startedAt}〜${day.endedAt ?? ""}` : "時刻なし"}</span>
        <span>{minutesText(day.minutes)}</span>
        {day.chars !== null ? <span>{day.chars.toLocaleString("ja-JP")}字</span> : null}
        <em><i className={`mp-swatch${groupClass(classifyPlace(day.place))}`} />{day.place || "場所なし"}</em>
      </div>
      {day.outfit ? (
        <p className="mp-day-outfit">
          <span>服装</span>
          {outfitParts(day.outfit).map((part) => <span key={part.label}><b>{part.label}</b>{part.value}</span>)}
        </p>
      ) : null}
      <div className="mp-day-body">
        <Items title={day.source === "report" ? "昨日のこと（PCの外の活動）" : "昨日のこと"} items={day.yesterday} />
        <Items title="今日の予定" items={day.plan} />
        <Items title="気がかり" items={day.notes} />
        {!hasText ? <p className="dr-empty">{day.source === "header" ? "この日は、書いた時間と場所だけです。" : "この日のページには、取り出せる内容がありませんでした。"}</p> : null}
        {day.source === "report" ? <p className="mp-source">日報の「予定と振り返り」から補っています（予定はこの日の日報、昨日のこと・気がかりは前日の日報）。</p> : null}
        {day.reportLink ? <p className="mp-link"><Link className="text-link" href={day.reportLink} prefetch={false}>この日の予定と実績を、日報の振り返りで見る →</Link></p> : null}
      </div>
    </div>
  );
}

/** 月: 月の数字、日ごとの所要時間の棒(色は場所。押すとその日の中身)、場所の内訳 */
function MonthTab({ model }: { model: MorningPageModel }) {
  const { stats } = model;
  const byDate = useMemo(() => new Map(model.days.map((day) => [day.date, day])), [model.days]);
  const [selected, setSelected] = useState<string | null>(model.days.at(-1)?.date ?? null);
  const day = selected ? byDate.get(selected) ?? null : null;
  const usedGroups = PLACE_GROUPS.map((entry) => entry.group).filter((group) => model.dayBars.some((bar) => bar.group === group));
  // 縦軸: 15分刻み(長い日があれば30分刻み)で、いちばん長い日が収まる高さまで
  const axisStep = model.maxMinutes > 60 ? 30 : 15;
  const axisMax = Math.max(axisStep, Math.ceil(model.maxMinutes / axisStep) * axisStep);
  const axisTicks = Array.from({ length: axisMax / axisStep + 1 }, (_, index) => index * axisStep);

  return (
    <div className="dr-stack">
      <MonthPicker model={model} />
      <section className="asset-panel dr-panel">
        <div className="dr-rf-figures mp-figures">
          <Figure label="書いた日" value={<>{stats.pages}<small>/{stats.daysInMonth}日</small></>} sub={stats.pages ? `${Math.round((stats.pages / stats.daysInMonth) * 100)}%` : "この月のページはありません"} />
          <Figure label="平均の所要時間" value={minutesText(stats.avgMinutes)} sub={stats.longest ? `最長 ${minutesText(stats.longest.minutes)}（${shortDate(stats.longest.date)}）` : undefined} />
          <Figure label="平均の文字数" value={stats.avgChars === null ? "—" : <>{stats.avgChars.toLocaleString("ja-JP")}<small>字</small></>} />
        </div>
      </section>

      <Panel title="日ごとの所要時間" sub="縦軸は書いていた時間。色は書いた場所。棒を押すと、その日の中身が下に出ます。書かなかった日は点、時間が分からない日は薄い棒">
        <div className="mp-daychart">
          <div className="mp-daychart-axis" aria-hidden="true">
            {axisTicks.map((tick) => <span key={tick} style={{ bottom: `${(tick / axisMax) * 100}%` }}>{axisMinutes(tick)}</span>)}
          </div>
          <div className="mp-daychart-plot">
            {axisTicks.map((tick) => <i key={tick} className="mp-daychart-grid" style={{ bottom: `calc(var(--mp-label) + ${tick / axisMax} * var(--mp-plot))` }} aria-hidden="true" />)}
            <div className="mp-daybars" style={{ ["--days" as string]: model.dayBars.length }} role="group" aria-label={`${model.monthLabel}の日ごとの所要時間`}>
              {model.dayBars.map((bar) => {
                const label = bar.written ? `${shortDate(bar.date, bar.weekday)} ${minutesText(bar.minutes)}${bar.chars !== null ? `・${bar.chars.toLocaleString("ja-JP")}字` : ""}${bar.place ? `・${bar.place}` : ""}` : `${shortDate(bar.date, bar.weekday)} 書かなかった日`;
                const tick = <span>{bar.day % 5 === 0 || bar.day === 1 ? bar.day : ""}</span>;
                return bar.written ? (
                  <button key={bar.date} type="button" className={`mp-daybar${groupClass(bar.group)}${bar.date === selected ? " is-selected" : ""}${bar.minutes === null ? " is-unknown" : ""}`} title={label} aria-label={label} aria-pressed={bar.date === selected} onClick={() => setSelected(bar.date)}>
                    <b><i style={{ height: `${Math.max(2, ((bar.minutes ?? 0) / axisMax) * 100)}%` }} /></b>{tick}
                  </button>
                ) : (
                  <div key={bar.date} className="mp-daybar is-off" title={label}><b><i /></b>{tick}</div>
                );
              })}
            </div>
          </div>
        </div>
        <PlaceLegend groups={usedGroups} />
        {day ? <DayDetail day={day} /> : <p className="dr-empty">この月のページはありません。</p>}
      </Panel>

      <Panel title="場所" sub="この月のページ数。書いた場所を、自宅・共用スペースなどにまとめています">
        {model.places.length ? (
          <ul className="mp-places">
            {model.places.map((item) => (
              <li key={item.group}>
                <div className="mp-place-row">
                  <span><i className={`mp-swatch${groupClass(item.group)}`} />{item.label}</span>
                  <div className="mp-place-track"><i className={`mp-seg${groupClass(item.group)}`} style={{ width: `${(item.count / Math.max(1, stats.pages)) * 100}%` }} /></div>
                  <b>{item.count}日</b>
                </div>
                <small>{item.raw.map((raw) => `${raw.place} ${raw.count}`).join("・")}</small>
              </li>
            ))}
          </ul>
        ) : <p className="dr-empty">この月のページはありません。</p>}
      </Panel>
    </div>
  );
}

/* ───────── 気がかり ───────── */

/** 気がかり: 年ごとの一覧(月で絞れる)。検索語があれば、全期間の昨日のこと・予定・気がかりの検索結果 */
function NotesTab({ model }: { model: MorningPageModel }) {
  const { search, concerns } = model;
  const [month, setMonth] = useState("all");
  const counts = new Map<string, number>();
  for (const item of concerns) counts.set(item.date.slice(0, 7), (counts.get(item.date.slice(0, 7)) ?? 0) + 1);
  const shown = month === "all" ? concerns : concerns.filter((item) => item.date.startsWith(month));

  return (
    <div className="dr-stack">
      <section className="asset-panel dr-panel">
        <form className="mp-search" action="/morning-page" method="get">
          <input type="hidden" name="tab" value="notes" />
          <label className="dr-search">
            <span className="sr-only">全期間から検索</span>
            <input type="search" name="q" defaultValue={search?.q ?? ""} placeholder="全期間の昨日のこと・予定・気がかりから検索" maxLength={100} />
          </label>
          <button type="submit" className="secondary-button">検索</button>
          {search ? <Link className="text-link" href={href({ month: model.month, year: model.notesYear, tab: "notes" })} prefetch={false}>検索をやめる</Link> : null}
        </form>
      </section>
      {search ? (
        <Panel title={`「${search.q}」の検索結果`} sub={search.hits.length ? `${search.hits.length}件（新しい日から）` : undefined}>
          {search.hits.length ? (
            <div className="dr-table-scroll">
              <table className="asset-table dr-notes-table">
                <thead><tr><th scope="col">日付</th><th scope="col">種類</th><th scope="col">内容</th></tr></thead>
                <tbody>
                  {search.hits.map((hit, index) => {
                    const firstOfDay = index === 0 || search.hits[index - 1].date !== hit.date;
                    return (
                      <tr key={`${hit.date}-${index}`} className={firstOfDay && index > 0 ? "is-new-day" : undefined}>
                        <th scope="row">{firstOfDay ? <Link href={href({ month: hit.date.slice(0, 7), tab: "month" })} prefetch={false}>{hit.date}</Link> : null}</th>
                        <td><span className={`mp-kind is-${hit.kind}`}>{KIND_LABEL[hit.kind]}</span></td>
                        <td className="dr-note-text">{hit.text}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="dr-empty">見つかりませんでした。</p>}
        </Panel>
      ) : (
        <Panel title={`${model.notesYear}年の気がかり`} sub={`${concerns.length}件。新しい日から。2025年12月23日以降は、日報の「予定と振り返り」から`}>
          <div className="mp-filter is-notes">
            <div className="mp-chips" role="group" aria-label="気がかりの年">
              {model.years.map((group) => (
                <Link key={group.year} href={href({ month: model.month, year: group.year, tab: "notes" })} prefetch={false} className={group.year === model.notesYear ? "is-current" : undefined} aria-current={group.year === model.notesYear ? "page" : undefined}>{group.year}年</Link>
              ))}
            </div>
            {counts.size ? (
              <Chips label="月で絞る" value={month} onChange={setMonth} options={[{ value: "all", label: "すべて" }, ...[...counts.keys()].sort().map((value) => ({ value, label: `${Number(value.slice(5, 7))}月 ${counts.get(value)}` }))]} />
            ) : null}
          </div>
          {shown.length ? (
            <div className="dr-table-scroll">
              <table className="asset-table dr-notes-table">
                <thead><tr><th scope="col">日付</th><th scope="col">内容</th></tr></thead>
                <tbody>
                  {shown.map((note, index) => {
                    const firstOfDay = index === 0 || shown[index - 1].date !== note.date;
                    return (
                      <tr key={`${note.date}-${index}`} className={firstOfDay && index > 0 ? "is-new-day" : undefined}>
                        <th scope="row">{firstOfDay ? <Link href={href({ month: note.date.slice(0, 7), tab: "month" })} prefetch={false}>{note.date}</Link> : null}</th>
                        <td className="dr-note-text">{note.text}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="dr-empty">この年の気がかりはありません。</p>}
        </Panel>
      )}
    </div>
  );
}
