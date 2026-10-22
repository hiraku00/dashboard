import { describe, expect, test } from "vitest";
import { appKey, parseDailyReport, parseDuration, parseUsageCount } from "../app/lib/daily-report-parse.ts";

// 実際の日報は個人的な内容を含むので、書式だけを写した架空の日報で確かめる。
const STANDARD = `# 作業日報 26-10-21
記録期間: 08:06~22:34(約14時間28分)
キャプチャ回数: 546回

## 1. 本日のメイン作業

### 1.英語学習
- Gemini・Ankiで英単語を学習（8時台〜10時台）
- **シャドーイング**を記録

### 2.ダッシュボードの改善
- 一覧の表示順序を修正

## 2. アプリ使用状況

| アプリ/ツール | 使用回数 | 主な用途 |
|---|---|---|
| Brave | 340+ | Gemini、YouTube |
| Claude Code／dashboard | 120+ | ダッシュボード改善 |
| Ghostty | 546（記録上のアプリ名） | ターミナル常時起動 |

## 3. 作業詳細

| 時間帯 | 作業内容 | 所要時間 |
|---|---|---|
| 08:06～09:00 | ブラウザ履歴、Gmail確認 | 54分 |
| 09:00～10:30 | Gemini・Ankiで英語学習 | 1時間30分 |
| 10:30～13:00 | （ログなし：記録欠落） | 2時間30分 |
| 23:30～00:20 | 動画視聴 | |

## 4. 得られた知見･メモ

- 電力は P＝V×I
- ログ欠落は1回

## 5. 作業中だったファイル

- dashboard
`;

describe("parseDailyReport", () => {
  test("reads the header, every section and the gap total of a standard report", () => {
    const r = parseDailyReport(STANDARD, "2026-10-21");
    expect(r.status).toBe("ok");
    expect(r.warnings).toEqual([]);
    expect(r.header).toEqual({ titleDate: "2026-10-21", recordStart: "08:06", recordEnd: "22:34", recordedMinutes: 868, captureCount: 546, captureCountIsMin: false });
    expect(r.workItems).toEqual([
      { position: 0, categoryPosition: 0, category: "英語学習", itemPosition: 0, text: "Gemini・Ankiで英単語を学習（8時台〜10時台）" },
      { position: 1, categoryPosition: 0, category: "英語学習", itemPosition: 1, text: "シャドーイングを記録" },
      { position: 2, categoryPosition: 1, category: "ダッシュボードの改善", itemPosition: 0, text: "一覧の表示順序を修正" },
    ]);
    expect(r.appUsage.map((a) => [a.appName, a.appKey, a.usageCount, a.usageIsMin, a.usageCountRaw])).toEqual([
      ["Brave", "brave", 340, true, "340+"],
      ["Claude Code／dashboard", "claude-code", 120, true, "120+"],
      ["Ghostty", "ghostty", 546, false, "546（記録上のアプリ名）"],
    ]);
    expect(r.timeBlocks.map((b) => [b.startMinute, b.endMinute, b.durationMinutes, b.isGap])).toEqual([
      [486, 540, 54, false],
      [540, 630, 90, false],
      [630, 780, 150, true],
      // 日付をまたぐ時間帯。所要時間が空なら時刻の差から求める
      [1410, 1460, 50, false],
    ]);
    expect(r.gapMinutes).toBe(150);
    expect(r.notes).toEqual(["電力は P＝V×I", "ログ欠落は1回"]);
  });

  test("finds sections by keyword, not by number, and skips chatter before the title", () => {
    const md = `作業日報を作成します。データを整理して作成します。

作業日報 25-12-25
記録期間: 05:09~23:59(約 19 時間)
キャプチャ回数: 156 回

## 1. 本日のメイン作業
### 1. 暗号資産の管理
- ポジション確認

## 2. アプリ使用状況(アプリ、使用回数、主な用途)
| アプリ/ブラウザ | 使用回数 | 主な用途 |
| --- | --- | --- |
| Chrome | 58 回 | 情報検索 |

## 3. 得られた知見・メモ
- 監視体制が継続中

## 4. 作業中だったファイル
- なし

## 5. 作業詳細
| 時間帯 | 作業内容 | 所要時間 |
|---|---|---|
| 05:09～06:00 | 起床・確認 | 約 0.85 時間 |
`;
    const r = parseDailyReport(md, "2025-12-25");
    expect(r.status).toBe("ok");
    expect(r.header).toMatchObject({ titleDate: "2025-12-25", recordedMinutes: 1140, captureCount: 156 });
    expect(r.workItems.map((w) => w.category)).toEqual(["暗号資産の管理"]);
    expect(r.appUsage[0]).toMatchObject({ appKey: "chrome", usageCount: 58, usageIsMin: false });
    expect(r.notes).toEqual(["監視体制が継続中"]);
    expect(r.timeBlocks[0]).toMatchObject({ startMinute: 309, endMinute: 360, durationMinutes: 51 });
  });

  test("accepts the header variants found in real reports", () => {
    const header = (lines) => parseDailyReport(`# 作業日報 2026-01-13\n${lines}\n## 1. 本日のメイン作業\n`, "2026-01-13").header;
    expect(header("記録期間: 08:00～10:30（約2時間30分）\nキャプチャ回数: 500+回")).toMatchObject({ recordStart: "08:00", recordEnd: "10:30", recordedMinutes: 150, captureCount: 500, captureCountIsMin: true });
    expect(header("記録期間: 9:05:12~10:00:00(約55分)\nキャプチャ回数: 150回以上")).toMatchObject({ recordStart: "09:05", recordEnd: "10:00", recordedMinutes: 55, captureCount: 150, captureCountIsMin: true });
    expect(header("記録期間: 22:00~01:00\nキャプチャ回数:123回[1]")).toMatchObject({ recordedMinutes: 180, captureCount: 123, captureCountIsMin: false });
    expect(header("").titleDate).toBe("2026-01-13");
  });

  test("finds table columns by their names, not their order", () => {
    const md = `# 作業日報 26-01-01
記録期間: 08:00~09:00(約1時間)
キャプチャ回数: 10回
## 2. アプリ使用状況
| 主な用途 | アプリ | 使用回数 |
|---|---|---|
| 英語学習 | Gemini／Anki | 30+ |
## 3. 作業詳細
| 所要時間 | 作業内容 | 時間帯 |
|---|---|---|
| 1時間 | 英語学習 | 08:00～09:00 |
`;
    const r = parseDailyReport(md, "2026-01-01");
    expect(r.appUsage[0]).toMatchObject({ appName: "Gemini／Anki", appKey: "gemini", usageCount: 30, purpose: "英語学習" });
    expect(r.timeBlocks[0]).toMatchObject({ startMinute: 480, endMinute: 540, activity: "英語学習", durationMinutes: 60 });
  });

  test("keeps going with warnings when parts are missing, and fails only when nothing is readable", () => {
    const partial = parseDailyReport("# 作業日報 26-01-02\n記録期間: 08:00~09:00(約1時間)\nキャプチャ回数: 10回\n## 1. 本日のメイン作業\n- 何か\n", "2026-01-03");
    expect(partial.status).toBe("partial");
    expect(partial.warnings).toEqual(expect.arrayContaining([
      "本文の日付(2026-01-02)がファイルの日付(2026-01-03)と違います",
      "「アプリ使用状況」の節がありません",
      "「作業詳細」の節がありません",
    ]));
    expect(partial.workItems).toEqual([{ position: 0, categoryPosition: 0, category: "", itemPosition: 0, text: "何か" }]);

    const failed = parseDailyReport("ただの文章です。", "2026-01-04");
    expect(failed.status).toBe("failed");
    expect(failed.workItems).toEqual([]);
  });

  test("treats only explicit no-log rows as gaps", () => {
    const md = `## 3. 作業詳細
| 時間帯 | 作業内容 | 所要時間 |
|---|---|---|
| 10:00～11:00 | **ギャップ（データ欠落）** | 1時間 |
| 11:00～12:00 | ログ確認、Gmail | 1時間 |
| 12:00～13:00 | 中断（記録なし） | 1時間 |
`;
    const r = parseDailyReport(md, "2026-01-05");
    expect(r.timeBlocks.map((b) => [b.activity, b.isGap])).toEqual([["ギャップ（データ欠落）", true], ["ログ確認、Gmail", false], ["中断（記録なし）", true]]);
    expect(r.gapMinutes).toBe(120);
  });
});

describe("parseUsageCount", () => {
  test("reads counts and lower bounds", () => {
    expect(parseUsageCount("300+")).toEqual({ count: 300, isMin: true });
    expect(parseUsageCount("602（記録上のアプリ名）")).toEqual({ count: 602, isMin: false });
    expect(parseUsageCount("約20回")).toEqual({ count: 20, isMin: false });
    expect(parseUsageCount("150回以上")).toEqual({ count: 150, isMin: true });
    expect(parseUsageCount("1,200 回")).toEqual({ count: 1200, isMin: false });
    expect(parseUsageCount("非常に多い（100回以上）")).toEqual({ count: 100, isMin: true });
  });
  test("returns null for durations, dates and words", () => {
    for (const raw of ["約2時間", "約30分", "約4-5時間", "2025年12月～2026年1月の予定管理", "多い", "-", ""]) expect(parseUsageCount(raw)).toEqual({ count: null, isMin: false });
  });
});

describe("parseDuration", () => {
  test("reads hours and minutes in the written forms", () => {
    expect(parseDuration("1時間30分")).toBe(90);
    expect(parseDuration("45分")).toBe(45);
    expect(parseDuration("約2時間")).toBe(120);
    expect(parseDuration("約 1.5 時間")).toBe(90);
    expect(parseDuration("30分[2]")).toBe(30);
    expect(parseDuration("-")).toBeNull();
    expect(parseDuration("数分")).toBeNull();
  });
});

describe("appKey", () => {
  test("takes the first app, drops notes in parentheses, and applies aliases", () => {
    expect(appKey("Gemini／Anki")).toBe("gemini");
    expect(appKey("Claude Code／ros2_ws")).toBe("claude-code");
    expect(appKey("claude.ai")).toBe("claude");
    expect(appKey("Ghostty＋エディタ")).toBe("ghostty");
    expect(appKey("Brave（YouTube）")).toBe("brave");
    expect(appKey("Google カレンダー")).toBe("google-calendar");
    expect(appKey("ダッシュボード")).toBe("dashboard");
  });
});
