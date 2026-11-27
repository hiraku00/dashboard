import { describe, expect, test } from "vitest";
import { DAILY_REPORT_START, buildMorningModel, concernsFromReflection, monthLabel } from "../app/lib/morning-page-model.ts";
import { classifyPlace } from "../app/lib/morning-page-places.ts";

const row = (date, patch = {}) => ({ date, startedAt: "08:00", endedAt: "08:40", minutes: 40, place: "自宅", chars: 2000, yesterday: [], plan: [], notes: [], extracted: false, ...patch });

const stat = (month, pages, minutes, chars) => ({ month, pages, sumMinutes: minutes * pages, minutesCount: pages, sumChars: chars * pages, charsCount: pages });
const MONTHS = [
  stat("2024-03", 18, 30, 900),
  // 4月は3ページのうち所要時間が2つ、文字数が1つだけ分かる
  { month: "2024-04", pages: 3, sumMinutes: 110, minutesCount: 2, sumChars: 1000, charsCount: 1 },
  stat("2026-01", 10, 40, 2500),
];
const PLACES = [{ month: "2024-04", place: "自宅", pages: 1 }, { month: "2024-04", place: "自宅（槻木）", pages: 1 }, { month: "2024-04", place: "ホテル(Hi Hotel)", pages: 1 }, { month: "2024-03", place: "7F 中庭", pages: 18 }];
const TODAY = "2026-01-20";

const view = (patch) => ({ months: MONTHS, monthPlaces: PLACES, firstDate: "2024-03-05", lastDate: "2026-01-19", firstOutfitDate: null, outfitItems: [], outfitBrands: [], outfitDays: 0, month: null, rows: [], reflections: [], search: null, ...patch });
const month = (patch, anchor = patch.month) => buildMorningModel(view(patch), { range: "month", anchor }, TODAY);

describe("buildMorningModel (月次)", () => {
  const rows = [
    row("2024-04-02", { minutes: 20, chars: 1000, notes: ["気がかりA"], yesterday: ["昨日のこと"], extracted: true }),
    row("2024-04-15", { minutes: 90, chars: null, place: "自宅（槻木）", notes: ["気がかりB", "気がかりC"], extracted: true }),
    row("2024-04-30", { minutes: null, chars: null, place: "ホテル(Hi Hotel)" }),
  ];
  const model = month({ month: "2024-04", rows });

  test("前後の移動はページのある月だけを踏み、単位を替えると年次はその年・月次は最新の月", () => {
    expect(model.label).toBe("2024年4月");
    expect(model.nav).toEqual({ prev: "2024-03", next: "2026-01", latest: "2026-01" });
    expect(model.switchTo).toEqual({ month: "2026-01", year: "2024", all: null });
    expect(model.years.map((y) => [y.year, y.months.map((m) => m.month)])).toEqual([["2024", ["2024-03", "2024-04"]], ["2026", ["2026-01"]]]);
    expect(monthLabel("2026-01")).toBe("2026年1月");
  });

  test("数字は分かるものだけで平均し、最長の日を添える", () => {
    expect(model.figures).toEqual({ pages: 3, days: 30, avgMinutes: 55, avgChars: 1000, longest: { date: "2024-04-15", minutes: 90 } });
  });

  test("カレンダーは月曜始まりで、書かなかった日・今日より後の日も並ぶ", () => {
    // 2024-04-01 は月曜
    expect(model.calendar.lead).toBe(0);
    expect(model.calendar.days).toHaveLength(30);
    expect(model.calendar.days[1]).toMatchObject({ date: "2024-04-02", written: true, minutes: 20, group: "home" });
    expect(model.calendar.days[2]).toMatchObject({ date: "2024-04-03", written: false, future: false, group: null });
    expect(model.calendar.days[14]).toMatchObject({ group: "family" });
    const current = month({ month: "2026-01", rows: [row("2026-01-10")] });
    // 2026-01-01 は木曜。今日(1/20)までしか数えない
    expect(current.calendar.lead).toBe(3);
    expect(current.calendar.days[20]).toMatchObject({ date: "2026-01-21", future: true });
    expect(current.figures.days).toBe(20);
  });

  test("場所は意味でまとめ(日数の多い順、同数は分類の順)、書いたままの名前を内訳に残す", () => {
    expect(model.places).toEqual([
      { group: "home", label: "自宅", count: 1, raw: [{ place: "自宅", count: 1 }] },
      { group: "family", label: "実家", count: 1, raw: [{ place: "自宅（槻木）", count: 1 }] },
      { group: "stay", label: "宿泊先", count: 1, raw: [{ place: "ホテル(Hi Hotel)", count: 1 }] },
    ]);
    expect(model.trend).toEqual([]);
  });

  test("日報より前の日は、Claude で取り出した分をそのまま使う", () => {
    expect(model.days.map((d) => d.source)).toEqual(["extracted", "extracted", "header"]);
  });

  test("日報の始まり以降の日は、日報の振り返りタブへのリンクを持つ", () => {
    expect(DAILY_REPORT_START).toBe("2025-12-23");
    const late = month({ month: "2026-01", rows: [row("2026-01-10")] });
    expect(late.days[0].reportLink).toBe("/daily-report?range=day&date=2026-01-10&tab=reflection");
    expect(model.days.every((d) => d.reportLink === null)).toBe(true);
  });

  test("ページの無い月を開いても、前後はその月の前後のページのある月", () => {
    const gap = month({ month: "2025-06" });
    expect(gap.nav).toEqual({ prev: "2024-04", next: "2026-01", latest: "2026-01" });
    expect(gap.figures.pages).toBe(0);
  });

  test("データが何も無ければ空のモデル(エラーにしない)", () => {
    const empty = buildMorningModel(view({ months: [], monthPlaces: [], firstDate: null, lastDate: null }), { range: "month", anchor: null }, TODAY);
    expect(empty).toMatchObject({ empty: true, anchor: null, calendar: { lead: 0, days: [] }, trend: [], nav: { prev: null, next: null, latest: null } });
  });
});

describe("buildMorningModel (年次・全期間)", () => {
  test("年次はその年の月だけを推移に出し、平均は合計÷件数で出す", () => {
    const model = buildMorningModel(view({}), { range: "year", anchor: "2024" }, TODAY);
    expect(model.label).toBe("2024年");
    expect(model.nav).toEqual({ prev: null, next: "2026", latest: "2026" });
    expect(model.switchTo.month).toBe("2024-04");
    expect(model.trend.map((t) => [t.month, t.pages, t.avgMinutes, t.avgChars, t.places.home, t.places.shared, t.places.family, t.places.stay])).toEqual([
      ["2024-03", 18, 30, 900, 0, 18, 0, 0],
      ["2024-04", 3, 55, 1000, 1, 0, 1, 1],
    ]);
    // (540+110)/(18+2)=32.5、(16200+1000)/(18+1)=905.3
    expect(model.figures).toMatchObject({ pages: 21, avgMinutes: 33, avgChars: 905, longest: null });
    // 最初のページ(3/5)から年末まで
    expect(model.figures.days).toBe(302);
    expect(model.places.map((p) => [p.label, p.count])).toEqual([["共用スペース", 18], ["自宅", 1], ["実家", 1], ["宿泊先", 1]]);
  });

  test("服装の集計は読んだまま服装タブへ渡す", () => {
    const items = [{ layer: "top", item: "シャツ", brand: "UNIQLO", days: 2, last: "2026-01-19" }];
    const brands = [{ brand: "UNIQLO", days: 2, last: "2026-01-19" }];
    const model = buildMorningModel(view({ firstOutfitDate: "2026-01-18", outfitItems: items, outfitBrands: brands, outfitDays: 2 }), { range: "all", anchor: null }, TODAY);
    expect(model.outfit).toEqual({ firstDate: "2026-01-18", days: 2, items, brands });
  });

  test("年を指定しなければ最新の年", () => {
    expect(buildMorningModel(view({}), { range: "year", anchor: null }, TODAY).anchor).toBe("2026");
  });

  test("全期間は最初のページの日から今日まで", () => {
    const model = buildMorningModel(view({}), { range: "all", anchor: null }, TODAY);
    expect(model.label).toBe("2024年3月〜2026年1月");
    expect(model.nav).toEqual({ prev: null, next: null, latest: null });
    expect(model.trend).toHaveLength(3);
    expect(model.figures.pages).toBe(31);
    expect(model.figures.days).toBe(687);
  });
});

describe("classifyPlace", () => {
  test.each([
    ["自宅", "home"],
    ["自宅(Nue District R9)", "home"],
    ["自宅(co-working - focus5)", "shared"],
    ["自宅(7F 中庭)", "shared"],
    ["7F-中庭", "shared"],
    ["7F - 中庭", "shared"],
    ["Focus 2", "shared"],
    ["36F Sky Lounge2", "shared"],
    ["R棟33Fベランダ", "shared"],
    ["Circular Lounge", "shared"],
    ["自宅（槻木）", "family"],
    ["実家", "family"],
    ["石川家", "friends"],
    ["ホテル(Hi Hotel Bangkok)", "stay"],
    ["安心お宿 新宿", "stay"],
    ["ファーストキャビン秋葉原<br>ロビー", "stay"],
    ["Cafe Amazon(トンロー駅前店)", "cafe"],
    ["ベローチェ南新宿", "cafe"],
    ["仙台空港(出発ロビー)", "transit"],
    ["バス（仙台→東京）", "transit"],
    ["", "other"],
    ["どこか", "other"],
  ])("%s → %s", (place, group) => {
    expect(classifyPlace(place)).toBe(group);
  });
});

describe("pages in the daily report period", () => {
  const markdown = (plan, concern) => `## 6. 予定と振り返り\n\n### 予定と実績\n\n| 予定 | 結果 | 状態 |\n|---|---|---|\n| ${plan} | した | 済 |\n| （予定になし）動画 | 見た | 予定外 |\n\n### PCの外の活動\n\n| 時刻 | 活動 | 種類 |\n|---|---|---|\n| — | 散歩 | 運動 |\n\n### 気になったこと・持ち越し\n\n- [持ち越し] 続きを読む\n- [気がかり] ${concern}\n`;

  test("a report's concerns belong to the next morning's page", () => {
    expect(concernsFromReflection({ reportDate: "2026-02-28", markdown: markdown("買い物", "肌荒れ") })).toEqual([{ date: "2026-03-01", text: "肌荒れ" }]);
  });

  test("header-only pages get the plan from that day's report and the rest from the day before", () => {
    const model = month({
      month: "2026-01",
      rows: [row("2026-01-10"), row("2026-01-11"), row("2026-01-20")],
      reflections: [{ reportDate: "2026-01-10", markdown: markdown("買い物", "肌荒れ") }, { reportDate: "2026-01-11", markdown: markdown("読書", "眠い") }],
    });
    expect(model.days.map((d) => [d.date, d.plan, d.yesterday, d.notes, d.source])).toEqual([
      ["2026-01-10", ["買い物"], [], [], "report"],
      ["2026-01-11", ["読書"], ["散歩"], ["肌荒れ"], "report"],
      ["2026-01-20", [], [], [], "header"],
    ]);
  });
});
