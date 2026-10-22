import { describe, expect, test } from "vitest";
import { DAILY_REPORT_TAGS, OTHER_TAG, tagDailyReport, tagsForText } from "../app/lib/daily-report-tags.ts";

const block = (position, activity, durationMinutes, isGap = false) => ({ position, startMinute: null, endMinute: null, activity, durationMinutes, isGap });
const item = (position, category, text) => ({ position, categoryPosition: 0, category, itemPosition: position, text });

describe("DAILY_REPORT_TAGS", () => {
  test("keys are unique and none is the reserved other key", () => {
    const keys = DAILY_REPORT_TAGS.map((tag) => tag.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(OTHER_TAG);
  });
});

describe("tagsForText", () => {
  test("can give one text several tags, in dictionary order", () => {
    expect(tagsForText("Gemini・Ankiで英語学習")).toEqual(["english"]);
    expect(tagsForText("ros2_wsとTinkercadで回路の学習、YouTube視聴")).toEqual(["robotics", "electronics", "media"]);
    expect(tagsForText("scrape-tv-programのoutput確認、hiraku-watch-listの更新")).toEqual(["dashboard", "scraping"]);
  });

  test("uses a generic tag only when no specific tag matches", () => {
    expect(tagsForText("README.mdの編集と実装計画の確認")).toEqual(["dev"]);
    expect(tagsForText("TextTubeの機能開発")).toEqual(["texttube"]);
  });

  test("does not mistake look-alike words", () => {
    expect(tagsForText("ranking page")).toEqual([]);                 // Anki は大文字小文字を区別する
    expect(tagsForText("Claude Codeでリファクタ")).toEqual(["dev"]);   // Claude Code は AI ではなく開発
    expect(tagsForText("claude.aiで相談")).toEqual(["ai"]);
    expect(tagsForText("AirAsiaで航空券を比較")).toEqual(["travel"]); // Air の AI に当てない
    expect(tagsForText("Xデータ抽出スクリプトの実行")).toEqual(["scraping"]);
    expect(tagsForText("Xの確認、Gmail")).toEqual(["communication"]);
  });
});

describe("tagDailyReport", () => {
  test("splits a block's minutes evenly across its tags, putting the remainder on the first", () => {
    const { tagDays } = tagDailyReport({ workItems: [], timeBlocks: [block(0, "英語学習とYouTube視聴とGmail", 61)] });
    expect(tagDays).toEqual([
      { tag: "english", minutes: 21, workItemCount: 0 },
      { tag: "communication", minutes: 20, workItemCount: 0 },
      { tag: "media", minutes: 20, workItemCount: 0 },
    ]);
  });

  test("skips gaps, counts untagged time as other, and keeps the day total equal to the logged time", () => {
    const { itemTags, tagDays } = tagDailyReport({
      workItems: [],
      timeBlocks: [block(0, "（ログなし：記録欠落）", 120, true), block(1, "ぼんやり", 30), block(2, "NHK視聴", 45), block(3, "空欄", null)],
    });
    expect(tagDays).toEqual([{ tag: OTHER_TAG, minutes: 30, workItemCount: 0 }, { tag: "media", minutes: 45, workItemCount: 0 }]);
    expect(itemTags).toEqual([{ source: "time", position: 2, tag: "media" }]);
  });

  test("tags a work item by its own text, falling back to its category heading", () => {
    const { itemTags, tagDays } = tagDailyReport({
      workItems: [item(0, "英語学習", "Ankiで復習"), item(1, "英語学習", "例文を10個作った"), item(2, "動画視聴・買い物", "IKEAの新作を視聴"), item(3, "その他", "片付け")],
      timeBlocks: [],
    });
    expect(itemTags).toEqual([
      { source: "work", position: 0, tag: "english" },
      { source: "work", position: 1, tag: "english" },
      // 自分の文に当たったタグだけを付け、見出しの「買い物」は付けない
      { source: "work", position: 2, tag: "shopping" },
      { source: "work", position: 2, tag: "media" },
    ]);
    expect(tagDays.find((d) => d.tag === "english")).toEqual({ tag: "english", minutes: 0, workItemCount: 2 });
    expect(tagDays.find((d) => d.tag === OTHER_TAG)).toEqual({ tag: OTHER_TAG, minutes: 0, workItemCount: 1 });
  });
});
