import { beforeAll, describe, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { ingestDailyReports } from "@/app/lib/daily-report-store";
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
    expect(model.hero.value).toBe("2h30m");
    expect(model.hero.items.map((item) => item.value)).toEqual(["08:00〜11:00", "30m(記録の17%)", "200回以上", "2h30m"]);
    expect(model.baseline).toEqual({ days: 2, label: "直近28日の1日平均" });
    expect(model.nav).toMatchObject({ prev: "2026-10-15", next: "2026-10-21" });
    expect(model.nav.switchTo).toEqual({ day: "2026-10-19", week: "2026-10-19", month: "2026-10-01" });
    expect(model.day?.blocks.map((block) => [block.startMinute, block.isGap, block.tags])).toEqual([[480, false, ["english"]], [540, true, []], [570, false, ["dashboard"]]]);
    expect(model.day?.workGroups.map((group) => group.category)).toEqual(["英語学習", "ダッシュボードの改善"]);
    expect(model.day?.apps[0]).toMatchObject({ appName: "Gemini／Anki", usageCount: 30, usageIsMin: true });
    expect(model.notes).toEqual([{ reportDate: "2026-10-19", text: "復習は朝が良い" }]);
    expect(model.original?.markdown).toContain("# 作業日報 26-10-19");
    expect(model.legend.map((share) => [share.category, Math.round(share.percent)])).toEqual([["study", 40], ["dev", 60]]);
    expect(model.columns).toEqual([]);
  });

  test("week: per-day averages against the week before, 7 columns and 7 band rows", async () => {
    await seed(DATES);
    const period = periodRange("week", "2026-10-21", TODAY);
    const model = buildModel(await periodView(period), period, TODAY);

    expect(model.reportCount).toBe(2);
    expect(model.hero.label).toBe("1日平均の活動時間");
    expect(model.hero.value).toBe("2h30m");
    expect(model.hero.items[0]).toEqual({ label: "合計", value: "5h00m" });
    expect(model.hero.items[2]).toEqual({ label: "日報", value: "2/7日", sub: "4日目まで" });
    expect(model.baseline.days).toBe(2);
    expect(model.shareRows.map((row) => row.label)).toEqual(["今週", "前週"]);
    expect(model.columns.map((column) => column.hasReport)).toEqual([true, false, true, false, false, false, false]);
    expect(model.weekRows).toHaveLength(7);
    expect(model.weekRows[3]).toMatchObject({ date: "2026-10-22", hasReport: false, future: false });
    expect(model.weekRows[4]).toMatchObject({ date: "2026-10-23", future: true });
    expect(model.trend).toHaveLength(12);
    expect(model.headings.map((entry) => [entry.heading, entry.dates])).toEqual([
      ["英語学習", ["2026-10-19", "2026-10-21"]],
      ["ダッシュボードの改善", ["2026-10-19", "2026-10-21"]],
    ]);
    expect(model.appRanking[0]).toMatchObject({ name: "Gemini", dates: ["2026-10-19", "2026-10-21"] });
    expect(model.reportList.map((row) => row.date)).toEqual(["2026-10-21", "2026-10-19"]);
    expect(model.original).toBeNull();
    expect(model.nav.next).toBeNull();
    expect(model.nav.prev).toBe("2026-10-12");
  });

  test("month: hour profile and weekday averages; an empty week has no reports", async () => {
    await seed(DATES);
    const month = periodRange("month", "2026-10-01", TODAY);
    const model = buildModel(await periodView(month), month, TODAY);
    expect(model.reportCount).toBe(4);
    expect(model.columns).toHaveLength(31);
    expect(model.profile.find((slot) => slot.hour === 8)?.minutes).toEqual({ study: 60 });
    // 10月の日報は 13日(火)・15日(木)・19日(月)・21日(水)
    expect(model.weekdays.find((entry) => entry.weekday === "月")).toEqual({ weekday: "月", minutes: 150, days: 1 });
    expect(model.weekdays.find((entry) => entry.weekday === "金")).toEqual({ weekday: "金", minutes: null, days: 0 });

    const empty = periodRange("week", "2026-10-05", TODAY);
    const emptyModel = buildModel(await periodView(empty), empty, TODAY);
    expect(emptyModel.reportCount).toBe(0);
    expect(emptyModel.hero.value).toBe("—");
  });
});
