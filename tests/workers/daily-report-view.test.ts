import { beforeAll, describe, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { ingestDailyReports } from "@/app/lib/daily-report-store";
import { ingestDailyReportSummaries } from "@/app/lib/daily-report-summary-store";
import { listReportDates, periodView } from "@/app/lib/queries/daily-report";
import { portalSummary } from "@/app/lib/queries/portal";
import { buildModel } from "@/app/lib/daily-report-model";
import { periodRange } from "@/app/lib/daily-report-summary";

// /daily-report の読み取り: 取り込んだ日報から、日次・週次・月次の画面の形を、実際の(ephemeralな)D1から作れることを確かめる。
// 実際の日報は個人的な内容を含むので、書式だけを写した架空の日報を使う。

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

const TODAY = "2026-10-22";

const report = (date: string, activity: string) => `# 作業日報 ${date.slice(2)}
記録期間: 08:00~11:00(約3時間)
キャプチャ回数: 200回以上

## 1. 本日のメイン作業
### 1.英語学習
- Ankiで英単語を復習
### 2.ダッシュボードの改善
- dashboardの画面を直す

## 2. アプリ使用状況
| アプリ/ツール | 使用回数 | 主な用途 |
|---|---|---|
| Gemini／Anki | 30+ | 英語学習 |

## 3. 作業詳細
| 時間帯 | 作業内容 | 所要時間 |
|---|---|---|
| 08:00～09:00 | Ankiで英語学習 | 1時間 |
| 09:00～09:30 | （ログなし：記録欠落） | 30分 |
| 09:30～11:00 | ${activity} | 1時間30分 |

## 4. 得られた知見・メモ
- 復習は朝が良い
`;

async function seed(dates: string[]) {
  const results = await ingestDailyReports(dates.map((date) => ({ date, markdown: report(date, "dashboardの改善") })));
  expect(results.map((result) => result.status)).not.toContain("error");
}

const DATES = ["2026-09-01", "2026-10-13", "2026-10-15", "2026-10-19", "2026-10-21"];

describe("listReportDates / portal summary", () => {
  test("lists report dates in order, and the portal card shows the newest", async () => {
    await seed(DATES);
    const dates = await listReportDates();
    expect(dates.filter((date) => DATES.includes(date))).toEqual(DATES);
    const summary = await portalSummary();
    expect(summary.dailyReport.latestDate).toBe(dates.at(-1));
  });
});

describe("periodView + buildModel", () => {
  test("day: the day's timeline, work, original and the 28-day baseline", async () => {
    await seed(DATES);
    const period = periodRange("day", "2026-10-19", TODAY);
    const model = buildModel(await periodView(period), period, TODAY);

    expect(model.reportCount).toBe(1);
    expect(model.hero.figures).toEqual([{ label: "活動時間", value: "2h30m" }]);
    expect(model.hero.caption).toBe("記録 08:00〜11:00(3h00m)");
    expect(model.hero.items).toEqual([
      { label: "直近28日の1日平均", value: "2h30m", sub: "±0m(参考)" },
      { label: "ログなし", value: "30m", sub: "記録の17%" },
      { label: "キャプチャ", value: "200回以上" },
    ]);
    expect(model.baseline).toEqual({ days: 2, label: "直近28日の1日平均", shortLabel: "直近28日" });
    expect(model.allocation.map((row) => [row.category, row.total, Math.round(row.percent), row.baselineAverage])).toEqual([["study", 60, 40, 60], ["dev", 90, 60, 90]]);
    expect(model.nav).toMatchObject({ prev: "2026-10-15", next: "2026-10-21" });
    expect(model.nav.switchTo).toEqual({ day: "2026-10-19", week: "2026-10-19", month: "2026-10-01" });
    expect(model.day?.blocks.map((block) => [block.startMinute, block.isGap, block.tags])).toEqual([[480, false, ["english"]], [540, true, []], [570, false, ["dashboard"]]]);
    // 作業内容はタグ単位(見出しの言い方に左右されない)。時間はタグ×日の分数
    expect(model.work.map((row) => [row.category, row.tags.map((tag) => [tag.tag, tag.minutes, tag.items.map((entry) => entry.text)])])).toEqual([
      ["study", [["english", 60, ["Ankiで英単語を復習"]]]],
      ["dev", [["dashboard", 90, ["dashboardの画面を直す"]]]],
    ]);
    // 「復習は朝が良い」はタグ辞書のどの語にも当たらないので未分類
    expect(model.notes).toEqual([{ reportDate: "2026-10-19", text: "復習は朝が良い", category: "other" }]);
    expect(model.original?.markdown).toContain("# 作業日報 26-10-19");
    expect(model.legend.map((share) => [share.category, Math.round(share.percent)])).toEqual([["study", 40], ["dev", 60]]);
    expect(model.activity.days).toEqual([]);
  });

  test("week: total and per-day average against the week before, 7 day bars, 12 week bars and 7 band rows", async () => {
    await seed(DATES);
    const period = periodRange("week", "2026-10-21", TODAY);
    const model = buildModel(await periodView(period), period, TODAY);

    expect(model.reportCount).toBe(2);
    expect(model.hero.figures).toEqual([{ label: "合計", value: "5h00m" }, { label: "1日平均", value: "2h30m" }]);
    // 前週(10/12〜18)の日報は2日なので参考扱い
    expect(model.hero.items[0]).toEqual({ label: "前週の1日平均", value: "2h30m", sub: "±0m/日(参考)" });
    expect(model.hero.items[2]).toEqual({ label: "日報", value: "2/7日", sub: "金〜日はまだ" });
    expect(model.baseline.days).toBe(2);
    expect(model.allocation.map((row) => [row.category, row.total, row.average])).toEqual([["study", 120, 60], ["dev", 180, 90]]);
    expect(model.activity.days.map((bar) => [bar.label, bar.value, bar.future])).toEqual([
      ["月", 150, false], ["火", null, false], ["水", 150, false], ["木", null, false], ["金", null, true], ["土", null, true], ["日", null, true],
    ]);
    expect(model.activity.days[0]).toMatchObject({ title: "10/19(月)", target: { range: "day", date: "2026-10-19" }, breakdown: [{ category: "study", minutes: 60 }, { category: "dev", minutes: 90 }] });
    expect(model.activity.periods).toHaveLength(12);
    expect(model.activity.periods.at(-1)).toMatchObject({ key: "2026-10-19", label: "10/19", value: 150, target: { range: "week", date: "2026-10-19" } });
    expect(model.activity.periods.at(-2)).toMatchObject({ key: "2026-10-12", label: "", value: 150 });
    expect(model.activity.periods[0]).toMatchObject({ value: null, target: null });
    expect(model.weekRows).toHaveLength(7);
    expect(model.weekRows[3]).toMatchObject({ date: "2026-10-22", hasReport: false, future: false });
    expect(model.weekRows[4]).toMatchObject({ date: "2026-10-23", future: true });
    expect(model.work.map((row) => [row.category, row.minutes, row.tags.map((tag) => [tag.tag, tag.days, tag.items.length])])).toEqual([
      ["study", 120, [["english", 2, 2]]],
      ["dev", 180, [["dashboard", 2, 2]]],
    ]);
    expect(model.work[0].tags[0].items[0].reportDate).toBe("2026-10-21");
    expect(model.reportList).toEqual([
      { date: "2026-10-21", active: 150, recordStart: "08:00", recordEnd: "11:00", gapMinutes: 30, parseStatus: "ok" },
      { date: "2026-10-19", active: 150, recordStart: "08:00", recordEnd: "11:00", gapMinutes: 30, parseStatus: "ok" },
    ]);
    expect(model.original).toBeNull();
    expect(model.nav.next).toBeNull();
    expect(model.nav.prev).toBe("2026-10-12");
  });

  test("month: hour profile and weekday averages; an empty week has no reports", async () => {
    await seed(DATES);
    const month = periodRange("month", "2026-10-01", TODAY);
    const model = buildModel(await periodView(month), month, TODAY);
    expect(model.reportCount).toBe(4);
    expect(model.activity.days).toHaveLength(31);
    expect(model.activity.days.filter((bar) => bar.label).map((bar) => bar.label)).toEqual(["1", "10", "20", "30"]);
    expect(model.activity.periodsLabel).toBe("最近12か月");
    expect(model.activity.periods.at(-1)).toMatchObject({ label: "10月", value: 150 });
    expect(model.profile.find((slot) => slot.hour === 8)?.minutes).toEqual({ study: 60 });
    // 10月の日報は 13日(火)・15日(木)・19日(月)・21日(水)
    expect(model.weekdays.find((entry) => entry.weekday === "月")).toEqual({ weekday: "月", minutes: 150, days: 1 });
    expect(model.weekdays.find((entry) => entry.weekday === "金")).toEqual({ weekday: "金", minutes: null, days: 0 });

    const empty = periodRange("week", "2026-10-05", TODAY);
    const emptyModel = buildModel(await periodView(empty), empty, TODAY);
    expect(emptyModel.reportCount).toBe(0);
    expect(emptyModel.hero.figures.map((figure) => figure.value)).toEqual(["—", "—"]);
  });

  test("week/month: the original tab carries that period's summary alongside the report list", async () => {
    await seed(DATES);
    const results = await ingestDailyReportSummaries([
      { kind: "week", periodStart: "2026-10-12", periodEnd: "2026-10-18", markdown: "# 週次サマリ 10/12〜10/18\n\n## 1. 概要\n- 架空の週" },
    ]);
    expect(results.map((result) => result.status)).not.toContain("error");

    const week = periodRange("week", "2026-10-15", TODAY);
    const model = buildModel(await periodView(week), week, TODAY);
    expect(model.summary?.markdown).toContain("# 週次サマリ 10/12〜10/18");
    expect(model.reportList.map((row) => row.date)).toEqual(["2026-10-15", "2026-10-13"]);

    // 同じ日付から始まる月のサマリは無いので、月次には出さない
    const month = periodRange("month", "2026-10-01", TODAY);
    expect(buildModel(await periodView(month), month, TODAY).summary).toBeNull();
    const day = periodRange("day", "2026-10-13", TODAY);
    expect(buildModel(await periodView(day), day, TODAY).summary).toBeNull();
  });
});
