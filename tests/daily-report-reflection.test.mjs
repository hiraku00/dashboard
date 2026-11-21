import { describe, expect, test } from "vitest";
import { parseReflection, planRate, summarizeReflections } from "../app/lib/daily-report-reflection.ts";

// 実際の6節目は個人的な内容を含むので、auto-daily-report のテンプレートの形だけを写した架空の内容で確かめる。
const TABLES = `> モーニングページ: 当日朝（3/10）の予定・翌朝（3/11）の振り返り

### 予定と実績

| 予定 | 結果 | 状態 |
|---|---|---|
| 図書館で本を返す | 午前に行った | 済 |
| **ブログ**を書く | 下書きまで | 一部 |
| 電子工作の学習 | 手を付けていない | 未 |
| 牛乳を買う | どちらの記録にも出てこない | 記録なし |
| （予定になし）ルーターの設定 | 15:30頃から | 予定外 |

### PCの外の活動

| 時刻 | 活動 | 種類 |
|---|---|---|
| 18:00頃 | 筋トレ | 運動 |
| 12:30頃 | 昼食（外食） | 食事 |
| — | スーパーに寄る | 外出・買い物 |
| 23:00頃 | 就寝 | 睡眠 |

### 気になったこと・持ち越し

- [持ち越し] ブログの続きを書く
- [気がかり] 自転車のタイヤの空気が少ない
- 印の無い行は読まない
`;

describe("parseReflection", () => {
  test("reads the source line, the two tables and the marked bullets", () => {
    const r = parseReflection(TABLES);
    expect(r.structured).toBe(true);
    expect(r.source).toBe("当日朝（3/10）の予定・翌朝（3/11）の振り返り");
    expect(r.plans.map((p) => [p.plan, p.status])).toEqual([
      ["図書館で本を返す", "done"],
      ["ブログを書く", "partial"],
      ["電子工作の学習", "todo"],
      ["牛乳を買う", "unknown"],
      ["ルーターの設定", "extra"],
    ]);
    expect(r.activities.map((a) => [a.time, a.minute, a.kind])).toEqual([
      ["18:00頃", 1080, "exercise"],
      ["12:30頃", 750, "meal"],
      [null, null, "outing"],
      ["23:00頃", 1380, "sleep"],
    ]);
    expect(r.notes).toEqual([
      { kind: "carryover", text: "ブログの続きを書く" },
      { kind: "concern", text: "自転車のタイヤの空気が少ない" },
    ]);
  });

  test("finds columns by name, not order", () => {
    const r = parseReflection("### 予定と実績\n| 状態 | 予定 | 結果 |\n|---|---|---|\n| 済 | 散歩 | 行った |\n");
    expect(r.plans).toEqual([{ plan: "散歩", result: "行った", status: "done" }]);
  });

  test("a 6th section written before the table format is not structured", () => {
    const r = parseReflection("> モーニングページ: 11/20の予定・11/21の振り返り\n\n### 予定と実績\n\n- 散歩 → 行った\n\n### PCの外の活動\n\n- 昼食（12時半頃）\n");
    expect(r.structured).toBe(false);
    expect(r.plans).toEqual([]);
  });
});

describe("planRate / summarizeReflections", () => {
  test("the rate counts only planned items (not unplanned ones) and is null without plans", () => {
    expect(planRate({ done: 1, partial: 1, todo: 1, unknown: 1, extra: 3 })).toEqual({ planned: 4, rate: 25 });
    expect(planRate({ done: 0, partial: 0, todo: 0, unknown: 0, extra: 2 })).toEqual({ planned: 0, rate: null });
  });

  test("sums a period, lists notes newest first and counts unstructured days apart", () => {
    const { days, summary } = summarizeReflections([
      { reportDate: "2026-03-11", markdown: "### 予定と実績\n\n- 古い書き方\n" },
      { reportDate: "2026-03-10", markdown: TABLES },
      { reportDate: "2026-03-12", markdown: TABLES.replace("ブログの続きを書く", "洗濯") },
    ]);
    expect(days.map((d) => d.reportDate)).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
    expect(summary.totals).toEqual({ done: 2, partial: 2, todo: 2, unknown: 2, extra: 2 });
    expect(summary.rate).toBe(25);
    expect(summary.activityCount).toBe(8);
    expect(summary.activityKinds).toEqual([
      { kind: "meal", count: 2 },
      { kind: "outing", count: 2 },
      { kind: "exercise", count: 2 },
      { kind: "sleep", count: 2 },
    ]);
    expect(summary.notes.map((n) => [n.reportDate, n.text])[0]).toEqual(["2026-03-12", "洗濯"]);
    expect(summary.unstructuredDays).toBe(1);
  });
});
