import { beforeAll, describe, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { ingestDailyReports } from "@/app/lib/daily-report-store";
import { BASELINE_DAYS, dayView } from "@/app/lib/queries/daily-report";

// /daily-report/:date の読み取り: 取り込んだ日報から、当日の本文・時間帯・タグ、週の7日、前後の日報、
// 直前28日の1日平均を、実際の(ephemeralな)D1から読めることを確かめる。
// 実際の日報は個人的な内容を含むので、書式だけを写した架空の日報を使う。

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

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

describe("dayView", () => {
  test("reads the day, its week, its neighbours and the 28-day baseline", async () => {
    // 2026-10-19(月) 〜 21(水) と、基準になる直前の日、離れた前後の日
    await seed(["2026-09-01", "2026-10-15", "2026-10-19", "2026-10-20", "2026-10-21", "2026-11-02"]);
    const view = await dayView("2026-10-20");

    expect(view.report).toMatchObject({ reportDate: "2026-10-20", recordStart: "08:00", recordEnd: "11:00", gapMinutes: 30, captureCount: 200, captureCountIsMin: true, parseStatus: "ok" });
    expect(view.report?.markdown).toContain("# 作業日報 26-10-20");

    expect(view.prevDate).toBe("2026-10-19");
    expect(view.nextDate).toBe("2026-10-21");

    expect(view.week.map((day) => day.date)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(view.week.map((day) => day.hasReport)).toEqual([true, true, true, false, false, false, false]);
    const tuesday = view.week[1];
    expect(tuesday.activeMinutes).toBe(150);
    expect(tuesday.blocks.map((block) => [block.startMinute, block.endMinute, block.isGap])).toEqual([[480, 540, false], [540, 570, true], [570, 660, false]]);
    expect(tuesday.blocks[0].tags).toEqual(["english"]);
    expect(tuesday.blocks[1].tags).toEqual([]);

    expect(view.tagMinutes).toEqual({ english: 60, dashboard: 90 });
    // 基準は 2026-09-22〜10-19 の日報のある日(10-15 と 10-19)。09-01 は28日より前、10-20 以降は含めない
    expect(BASELINE_DAYS).toBe(28);
    expect(view.baseline).toEqual({ days: 2, minutes: { english: 60, dashboard: 90 } });

    expect(view.workItems.map((item) => [item.category, item.text, item.tags])).toEqual([
      ["英語学習", "Ankiで英単語を復習", ["english"]],
      ["ダッシュボードの改善", "dashboardの画面を直す", ["dashboard"]],
    ]);
    expect(view.apps[0]).toMatchObject({ appName: "Gemini／Anki", usageCount: 30, usageIsMin: true, purpose: "英語学習" });
    expect(view.notes).toEqual(["復習は朝が良い"]);
  });

  test("a date with no report still gives its week and the nearest reports", async () => {
    await seed(["2026-10-19", "2026-10-21", "2026-11-02"]);
    const view = await dayView("2026-10-22");
    expect(view.report).toBeNull();
    expect(view.prevDate).toBe("2026-10-21");
    expect(view.nextDate).toBe("2026-11-02");
    expect(view.week.find((day) => day.date === "2026-10-21")?.hasReport).toBe(true);
    expect(view.tagMinutes).toEqual({});
    expect(view.workItems).toEqual([]);
  });

  test("has no baseline when nothing precedes the date within 28 days", async () => {
    await seed(["2026-09-01"]);
    const view = await dayView("2026-09-01");
    expect(view.baseline).toBeNull();
  });
});
