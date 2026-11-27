"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PortalHeader } from "./portal-nav";
import { MORNING_RANGES, MORNING_TABS, type CalendarDay, type MorningDay, type MorningPageModel, type MorningRange, type MorningTab, type TrendPoint } from "./lib/morning-page-model";
import { PLACE_GROUPS, classifyPlace, placeGroupLabel, type PlaceGroup } from "./lib/morning-page-places";
import { OutfitTable } from "./outfit-table";

/** /morning-page のワークスペース(docs/morning-page-design.md)。日報の画面と同じ作法で、
 *  ヘッダーの下のタブ(概要・内容・場所)で切り口を、ツールバー(月次・年次・全期間と前後)で期間を替える。
 *  期間はURLで持ちサーバーが読み直す(リンクで移動)。タブは全タブを描いて `hidden` で隠し、URLは tab だけ書き換える。 */


type Kind = "yesterday" | "plan" | "notes";
const KIND_LABEL: Record<Kind, string> = { yesterday: "昨日のこと", plan: "今日の予定", notes: "気がかり" };
const KINDS: Kind[] = ["yesterday", "plan", "notes"];

export function morningHref(range: MorningRange, anchor: string | null, tab: MorningTab, dayId?: string) {
  const query = new URLSearchParams();
  query.set("range", range);
  if (anchor && range !== "all") query.set("date", anchor);
  if (tab !== "summary") query.set("tab", tab);
  return `/morning-page?${query.toString()}${dayId ? `#${dayId}` : ""}`;
}
const dayId = (date: string) => `d-${date}`;
const minutesText = (minutes: number | null) => (minutes === null ? "—" : minutes < 60 ? `${minutes}分` : `${Math.floor(minutes / 60)}時間${String(minutes % 60).padStart(2, "0")}分`);
const shortDate = (date: string, weekday?: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}${weekday ? `(${weekday})` : ""}`;
const groupClass = (group: PlaceGroup | null) => (group ? ` is-${group}` : "");
const PERIOD_NOUN: Record<MorningRange, string> = { month: "この月", year: "この年", all: "全期間" };

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

/** 1つを選ぶ、丸いボタンの列 */
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
  /** 概要のカレンダーで押した日(内容タブでその日へ送る) */
  const [focus, setFocus] = useState<string | null>(null);

  const selectTab = (next: MorningTab, hash?: string) => {
    setTab(next);
    try {
      window.history.replaceState(null, "", morningHref(model.range, model.anchor, next, hash));
    } catch {
      // history が使えない環境でも、タブの切り替え自体は動く
    }
  };
  const openDay = (date: string) => {
    setFocus(date);
    selectTab("content", dayId(date));
  };

  const empty = (
    <section className="asset-panel dr-panel">
      <p className="dr-empty">
        {PERIOD_NOUN[model.range]}のページはありません。
        {model.nav.latest ? <> <Link className="text-link" href={morningHref(model.range, model.nav.latest, tab)} prefetch={false}>最新の{model.range === "year" ? "年" : "月"}へ</Link></> : null}
      </p>
    </section>
  );
  const hasPages = model.figures.pages > 0;

  return (
    <main className="portal-shell asset-workspace daily-report-workspace">
      <PortalHeader title="モーニングページ" active="/morning-page">
        <nav className="asset-tabs" aria-label="モーニングページ メニュー">
          {MORNING_TABS.map(([id, label]) => (
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
          <MorningToolbar model={model} tab={tab} />
          <div hidden={tab !== "summary"}>{hasPages ? <SummaryTab model={model} onOpenDay={openDay} /> : empty}</div>
          <div hidden={tab !== "content"}><ContentTab model={model} focus={focus} active={tab === "content"} hasPages={hasPages} empty={empty} /></div>
          <div hidden={tab !== "place"}>{hasPages ? <PlaceTab model={model} /> : empty}</div>
        </>
      )}
    </main>
  );
}

/* ───────── ツールバー ───────── */

const STEP_LABEL: Record<MorningRange, string> = { month: "月", year: "年", all: "" };

/** 期間の単位(プルダウン)・前後の移動・期間(押すと月や年を選ぶ)・最新へ。日報のツールバー(app/daily-report-toolbar.tsx)と同じ形 */
function MorningToolbar({ model, tab }: { model: MorningPageModel; tab: MorningTab }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { range, anchor, nav } = model;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onClick = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const arrow = (target: string | null, direction: "prev" | "next") => {
    const label = `${direction === "prev" ? "前" : "次"}の${STEP_LABEL[range]}`;
    return target ? (
      <Link className="dr-step" href={morningHref(range, target, tab)} prefetch={false} aria-label={label} title={label}>{direction === "prev" ? "‹" : "›"}</Link>
    ) : (
      <span className="dr-step is-disabled" aria-label={`${label}はありません`}>{direction === "prev" ? "‹" : "›"}</span>
    );
  };

  return (
    <div className="page-toolbar dr-toolbar">
      <label className="dr-range">
        <span className="sr-only">期間の単位</span>
        <select value={range} onChange={(event) => { const next = event.target.value as MorningRange; router.push(morningHref(next, model.switchTo[next], tab)); }}>
          {MORNING_RANGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {range === "all" ? (
        <span className="mp-period-label">{model.label}</span>
      ) : (
        <div className="dr-datebox" ref={box}>
          {arrow(nav.prev, "prev")}
          <button type="button" className="dr-date-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            <svg className="dr-cal-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>{model.label}<span aria-hidden="true" className="dr-caret">▾</span>
          </button>
          {arrow(nav.next, "next")}
          {open ? <PeriodPicker model={model} tab={tab} onPick={() => setOpen(false)} /> : null}
        </div>
      )}
      {range !== "all" && nav.latest && nav.latest !== anchor ? (
        <Link className="text-link dr-current" href={morningHref(range, nav.latest, tab)} prefetch={false}>最新の{STEP_LABEL[range]}へ</Link>
      ) : null}
    </div>
  );
}

/** 月次は年を送って12か月から、年次は年の一覧から選ぶ(ページのある月・年だけ押せる) */
function PeriodPicker({ model, tab, onPick }: { model: MorningPageModel; tab: MorningTab; onPick: () => void }) {
  const years = model.years.map((group) => group.year);
  const [year, setYear] = useState(model.anchor?.slice(0, 4) ?? years.at(-1) ?? "");
  if (model.range === "year") {
    return (
      <div className="dr-calendar" role="dialog" aria-label="年を選ぶ">
        <div className="dr-cal-months">
          {years.map((value) => (
            <Link key={value} href={morningHref("year", value, tab)} prefetch={false} onClick={onPick} className={value === model.anchor ? "is-selected" : ""} aria-current={value === model.anchor ? "date" : undefined}>{value}年</Link>
          ))}
        </div>
      </div>
    );
  }
  const index = years.indexOf(year);
  const months = new Map((model.years.find((group) => group.year === year)?.months ?? []).map((item) => [item.month, item.pages]));
  return (
    <div className="dr-calendar" role="dialog" aria-label="月を選ぶ">
      <div className="dr-cal-head">
        <button type="button" disabled={index <= 0} onClick={() => setYear(years[index - 1])} aria-label="前の年">‹</button>
        <strong>{year}年</strong>
        <button type="button" disabled={index < 0 || index >= years.length - 1} onClick={() => setYear(years[index + 1])} aria-label="次の年">›</button>
      </div>
      <div className="dr-cal-months">
        {Array.from({ length: 12 }, (_, i) => {
          const month = `${year}-${String(i + 1).padStart(2, "0")}`;
          const pages = months.get(month);
          return pages === undefined ? (
            <span key={month} className="is-empty">{i + 1}月</span>
          ) : (
            <Link key={month} href={morningHref("month", month, tab)} prefetch={false} onClick={onPick} className={month === model.anchor ? "is-selected" : ""} aria-current={month === model.anchor ? "date" : undefined} title={`${pages}日分`}>{i + 1}月</Link>
          );
        })}
      </div>
      <p className="dr-note">ページのある月だけ選べます</p>
    </div>
  );
}

/* ───────── 共通 ───────── */

function Figure({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="dr-rf-figure">
      <p>{label}</p>
      <strong>{value}</strong>
      {sub ? <span>{sub}</span> : null}
    </div>
  );
}

function Figures({ model }: { model: MorningPageModel }) {
  const { figures } = model;
  return (
    <section className="asset-panel dr-panel">
      <div className="dr-rf-figures mp-figures">
        <Figure label="書いた日" value={<>{figures.pages.toLocaleString("ja-JP")}<small>/{figures.days.toLocaleString("ja-JP")}日</small></>} sub={figures.days ? `${Math.round((figures.pages / figures.days) * 100)}%` : undefined} />
        <Figure label="平均の所要時間" value={minutesText(figures.avgMinutes)} sub={figures.longest ? `最長 ${minutesText(figures.longest.minutes)}（${shortDate(figures.longest.date)}）` : undefined} />
        <Figure label="平均の文字数" value={figures.avgChars === null ? "—" : <>{figures.avgChars.toLocaleString("ja-JP")}<small>字</small></>} />
      </div>
    </section>
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

/** 月ごとの縦棒(CSS grid)。目盛りは左、月の数字は下(1月と先頭の月には年も)。棒はその月へのリンク */
function ColumnChart({ points, max, ticks, tickLabel, ariaLabel, render, title, tab }: {
  points: TrendPoint[];
  max: number;
  ticks: number[];
  tickLabel: (value: number) => string;
  ariaLabel: string;
  render: (point: TrendPoint) => ReactNode;
  title: (point: TrendPoint) => string;
  tab: MorningTab;
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
              <Link key={point.month} href={morningHref("month", point.month, tab)} prefetch={false} className="mp-col" title={title(point)} aria-label={title(point).replace(/\n/g, "、")}>
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

/* ───────── 概要 ───────── */

function SummaryTab({ model, onOpenDay }: { model: MorningPageModel; onOpenDay: (date: string) => void }) {
  return (
    <div className="dr-stack">
      <Figures model={model} />
      {model.range === "month" ? <MonthCalendar model={model} onOpenDay={onOpenDay} /> : <TrendCharts model={model} />}
    </div>
  );
}

/** 月次: 月曜始まりのカレンダー。色は書いた場所、数字は所要時間。押すと内容タブのその日へ */
function MonthCalendar({ model, onOpenDay }: { model: MorningPageModel; onOpenDay: (date: string) => void }) {
  const { calendar } = model;
  const usedGroups = PLACE_GROUPS.map((entry) => entry.group).filter((group) => calendar.days.some((day) => day.group === group));
  const label = (day: CalendarDay) => (day.written ? `${shortDate(day.date)} ${minutesText(day.minutes)}${day.chars !== null ? `・${day.chars.toLocaleString("ja-JP")}字` : ""}${day.place ? `・${day.place}` : ""}` : `${shortDate(day.date)} 書かなかった日`);
  return (
    <Panel title="日ごと" sub="色は書いた場所、数字は書いていた時間。日を押すと、その日の内容を開きます">
      <div className="mp-calendar">
        <div className="mp-cal-row mp-cal-weekdays" aria-hidden="true">{["月", "火", "水", "木", "金", "土", "日"].map((name) => <span key={name}>{name}</span>)}</div>
        <div className="mp-cal-grid" role="group" aria-label={`${model.label}の日ごと`}>
          {Array.from({ length: calendar.lead }, (_, index) => <span key={`lead-${index}`} className="mp-cal-day is-blank" aria-hidden="true" />)}
          {calendar.days.map((day) => (day.written ? (
            <button key={day.date} type="button" className={`mp-cal-day is-written${groupClass(day.group)}`} title={label(day)} aria-label={label(day)} onClick={() => onOpenDay(day.date)}>
              <b>{day.day}</b>
              {day.minutes === null ? <span>—</span> : <><span className="mp-cal-long">{minutesText(day.minutes)}</span><span className="mp-cal-short">{day.minutes}分</span></>}
              <i />
            </button>
          ) : (
            <span key={day.date} className={`mp-cal-day ${day.future ? "is-future" : "is-off"}`} title={day.future ? undefined : label(day)}><b>{day.day}</b></span>
          )))}
        </div>
      </div>
      <PlaceLegend groups={usedGroups} />
    </Panel>
  );
}

type Metric = "minutes" | "chars";

/** 年次・全期間: 月ごとの書いた日数と、平均の所要時間か文字数 */
function TrendCharts({ model }: { model: MorningPageModel }) {
  const [metric, setMetric] = useState<Metric>("minutes");
  const points = model.trend;
  const value = (point: TrendPoint) => (metric === "minutes" ? point.avgMinutes : point.avgChars);
  const step = metric === "minutes" ? 15 : 1000;
  const max = Math.max(step, Math.ceil(Math.max(0, ...points.map((point) => value(point) ?? 0)) / step) * step);
  const tickStep = max / step > 6 ? step * Math.ceil(max / step / 4) : step;
  const ticks = Array.from({ length: Math.floor(max / tickStep) + 1 }, (_, index) => index * tickStep);
  const metricLabel = (amount: number) => (metric === "minutes" ? (amount ? minutesText(amount) : "0") : amount ? `${(amount / 1000).toLocaleString("ja-JP")}千字` : "0");
  return (
    <>
      <Panel title="書いた日数" sub="月ごと。棒を押すとその月へ">
        <ColumnChart
          points={points}
          max={31}
          ticks={[0, 10, 20, 30]}
          tickLabel={(tick) => `${tick}日`}
          ariaLabel={`${model.label}の月ごとの書いた日数`}
          render={(point) => <i className="mp-seg is-metric" style={{ height: `${(point.pages / 31) * 100}%` }} />}
          title={(point) => `${point.label} ${point.pages}/${point.daysInMonth}日`}
          tab="summary"
        />
      </Panel>
      <Panel
        title={metric === "minutes" ? "平均の所要時間" : "平均の文字数"}
        sub="月ごと。書いた日だけの平均"
        actions={<Chips label="出す数字" value={metric} onChange={setMetric} options={[{ value: "minutes", label: "所要時間" }, { value: "chars", label: "文字数" }]} />}
      >
        <ColumnChart
          points={points}
          max={max}
          ticks={ticks}
          tickLabel={metricLabel}
          ariaLabel={`${model.label}の月ごとの${metric === "minutes" ? "平均の所要時間" : "平均の文字数"}`}
          render={(point) => (value(point) === null ? null : <i className="mp-seg is-metric" style={{ height: `${((value(point) ?? 0) / max) * 100}%` }} />)}
          title={(point) => `${point.label} ${metric === "minutes" ? minutesText(point.avgMinutes) : point.avgChars === null ? "—" : `${point.avgChars.toLocaleString("ja-JP")}字`}`}
          tab="summary"
        />
      </Panel>
    </>
  );
}

/* ───────── 内容 ───────── */

function SearchForm({ model }: { model: MorningPageModel }) {
  return (
    <section className="asset-panel dr-panel">
      <form className="mp-search" action="/morning-page" method="get">
        <input type="hidden" name="range" value={model.range} />
        {model.anchor ? <input type="hidden" name="date" value={model.anchor} /> : null}
        <input type="hidden" name="tab" value="content" />
        <label className="dr-search">
          <span className="sr-only">全期間から検索</span>
          <input type="search" name="q" defaultValue={model.search?.q ?? ""} placeholder="全期間の昨日のこと・予定・気がかりから検索" maxLength={100} />
        </label>
        <button type="submit" className="secondary-button">検索</button>
        {model.search ? <Link className="text-link" href={morningHref(model.range, model.anchor, "content")} prefetch={false}>検索をやめる</Link> : null}
      </form>
    </section>
  );
}

function ContentTab({ model, focus, active, hasPages, empty }: { model: MorningPageModel; focus: string | null; active: boolean; hasPages: boolean; empty: ReactNode }) {
  return (
    <div className="dr-stack">
      <SearchForm model={model} />
      {model.search ? <SearchResults model={model} /> : !hasPages ? empty : model.range === "month" ? <MonthDays key={focus ?? ""} model={model} focus={focus} active={active} /> : <MonthIndex model={model} />}
    </div>
  );
}

function SearchResults({ model }: { model: MorningPageModel }) {
  const search = model.search!;
  return (
    <Panel title={`「${search.q}」の検索結果`} sub={search.hits.length ? `${search.hits.length}件（全期間、新しい日から）` : undefined}>
      {search.hits.length ? (
        <div className="dr-table-scroll">
          <table className="asset-table dr-notes-table">
            <thead><tr><th scope="col">日付</th><th scope="col">種類</th><th scope="col">内容</th></tr></thead>
            <tbody>
              {search.hits.map((hit, index) => {
                const firstOfDay = index === 0 || search.hits[index - 1].date !== hit.date;
                return (
                  <tr key={`${hit.date}-${index}`} className={firstOfDay && index > 0 ? "is-new-day" : undefined}>
                    <th scope="row">{firstOfDay ? <Link href={morningHref("month", hit.date.slice(0, 7), "content", dayId(hit.date))} prefetch={false}>{hit.date}</Link> : null}</th>
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
  );
}

/** 月次: その月のページを新しい日から。種類で絞れる(カレンダーで日を押すと key が変わり、絞り込みを「すべて」に戻す) */
function MonthDays({ model, focus, active }: { model: MorningPageModel; focus: string | null; active: boolean }) {
  const [kind, setKind] = useState<Kind | "all">("all");
  const days = useMemo(() => [...model.days].reverse(), [model.days]);
  const counts = Object.fromEntries(KINDS.map((key) => [key, model.days.reduce((sum, day) => sum + day[key].length, 0)])) as Record<Kind, number>;
  const shown = kind === "all" ? days : days.filter((day) => day[kind].length > 0);

  // カレンダーで押した日・URLの #d-YYYY-MM-DD で来た日へ送る(押した日は色を付け、URLで来た日は :target で色が付く)
  useEffect(() => {
    if (!active) return;
    const target = focus ?? (window.location.hash.startsWith("#d-") ? window.location.hash.slice(3) : null);
    if (target) document.getElementById(dayId(target))?.scrollIntoView({ block: "start" });
  }, [focus, active]);

  return (
    <Panel
      title={`${model.label}の内容`}
      sub="新しい日から。2025年12月23日以降は、日報の「予定と振り返り」から補っています"
      actions={<Chips label="種類で絞る" value={kind} onChange={setKind} options={[{ value: "all", label: "すべて" }, ...KINDS.map((key) => ({ value: key, label: `${KIND_LABEL[key]} ${counts[key]}` }))]} />}
    >
      {shown.length ? (
        <div className="mp-days">
          {shown.map((day) => <DayEntry key={day.date} day={day} kind={kind} highlighted={day.date === focus} />)}
        </div>
      ) : <p className="dr-empty">この月には、{kind === "all" ? "ページ" : KIND_LABEL[kind]}がありません。</p>}
    </Panel>
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

/** 1日分: 時刻・所要時間・文字数・場所、服装、昨日のこと・今日の予定・気がかり */
function DayEntry({ day, kind, highlighted }: { day: MorningDay; kind: Kind | "all"; highlighted: boolean }) {
  const hasText = day.yesterday.length + day.plan.length + day.notes.length > 0;
  const show = (key: Kind) => kind === "all" || kind === key;
  return (
    <article id={dayId(day.date)} className={`mp-day${highlighted ? " is-highlighted" : ""}`}>
      <div className="mp-day-head">
        <b>{shortDate(day.date, day.weekday)}</b>
        <span>{day.startedAt ? `${day.startedAt}〜${day.endedAt ?? ""}` : "時刻なし"}</span>
        <span>{minutesText(day.minutes)}</span>
        {day.chars !== null ? <span>{day.chars.toLocaleString("ja-JP")}字</span> : null}
        <em><i className={`mp-swatch${groupClass(classifyPlace(day.place))}`} />{day.place || "場所なし"}</em>
      </div>
      {day.outfit && kind === "all" ? <OutfitTable outfit={day.outfit} className="mp-day-outfit" /> : null}
      <div className="mp-day-body">
        {show("yesterday") ? <Items title={day.source === "report" ? "昨日のこと（PCの外の活動）" : "昨日のこと"} items={day.yesterday} /> : null}
        {show("plan") ? <Items title="今日の予定" items={day.plan} /> : null}
        {show("notes") ? <Items title="気がかり" items={day.notes} /> : null}
        {!hasText ? <p className="mp-source">{day.source === "header" ? "この日は、書いた時間と場所だけです。" : "この日のページには、取り出せる内容がありませんでした。"}</p> : null}
        {day.reportLink && kind === "all" ? <p className="mp-link"><Link className="text-link" href={day.reportLink} prefetch={false}>この日の予定と実績を、日報の振り返りで見る →</Link></p> : null}
      </div>
    </article>
  );
}

/** 年次・全期間: 1年分を並べると長すぎるので、一覧は出さず、月を選んで月次の内容へ */
function MonthIndex({ model }: { model: MorningPageModel }) {
  const years = model.range === "year" ? model.years.filter((group) => group.year === model.anchor) : [...model.years].reverse();
  return (
    <Panel title="月を選ぶ" sub="内容は月ごとに読みます。数字はその月に書いた日数">
      <div className="mp-month-index">
        {years.map((group) => {
          const pages = new Map(group.months.map((item) => [item.month, item.pages]));
          return (
            <div key={group.year} className="mp-month-year">
              <h3>{group.year}年</h3>
              <div className="mp-months">
                {Array.from({ length: 12 }, (_, i) => {
                  const month = `${group.year}-${String(i + 1).padStart(2, "0")}`;
                  const count = pages.get(month);
                  return count === undefined ? (
                    <span key={month} className="is-empty">{i + 1}月</span>
                  ) : (
                    <Link key={month} href={morningHref("month", month, "content")} prefetch={false}>{i + 1}月<small>{count}日</small></Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/* ───────── 場所 ───────── */

function PlaceTab({ model }: { model: MorningPageModel }) {
  const points = model.trend;
  const usedGroups = PLACE_GROUPS.map((entry) => entry.group).filter((group) => points.some((point) => point.places[group] > 0));
  return (
    <div className="dr-stack">
      {model.range !== "month" ? (
        <Panel title="書いた場所" sub="月ごとの書いた日数を、場所で積み上げています。棒を押すとその月へ">
          <ColumnChart
            points={points}
            max={31}
            ticks={[0, 10, 20, 30]}
            tickLabel={(tick) => `${tick}日`}
            ariaLabel={`${model.label}の月ごとの書いた場所`}
            render={(point) => usedGroups.map((group) => (point.places[group] > 0 ? <i key={group} className={`mp-seg${groupClass(group)}`} style={{ height: `${(point.places[group] / 31) * 100}%` }} /> : null))}
            title={(point) => [`${point.label} ${point.pages}/${point.daysInMonth}日`, ...usedGroups.filter((group) => point.places[group] > 0).map((group) => `${placeGroupLabel(group)} ${point.places[group]}日`)].join("\n")}
            tab="place"
          />
          <PlaceLegend groups={usedGroups} />
        </Panel>
      ) : null}
      <Panel title="場所の内訳" sub="書いた日数。書いた場所を、自宅・共用スペースなどにまとめ、書いたままの名前を添えています">
        {model.places.length ? (
          <ul className="mp-places">
            {model.places.map((item) => (
              <li key={item.group}>
                <div className="mp-place-row">
                  <span><i className={`mp-swatch${groupClass(item.group)}`} />{item.label}</span>
                  <div className="mp-place-track"><i className={`mp-seg${groupClass(item.group)}`} style={{ width: `${(item.count / Math.max(1, model.figures.pages)) * 100}%` }} /></div>
                  <b>{item.count}日</b>
                </div>
                <small>{item.raw.map((raw) => `${raw.place} ${raw.count}`).join("・")}</small>
              </li>
            ))}
          </ul>
        ) : <p className="dr-empty">{PERIOD_NOUN[model.range]}のページはありません。</p>}
      </Panel>
    </div>
  );
}
