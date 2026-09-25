import { describe, expect, test } from "vitest";
import {
  buildProgramsFilter, formatPostedAt, likePattern, parseKind, toProgram, MAX_PAGE, PAGE_SIZE,
} from "../app/lib/openchat-query.ts";

describe("buildProgramsFilter", () => {
  test("default view: target notes or notes with a target comment, never deleted", () => {
    const f = buildProgramsFilter({});
    expect(f.where).toContain("n.deleted_at IS NULL");
    expect(f.where).toContain("(n.author_is_target = 1 OR n.target_comment_count > 0)");
    expect(f.limit).toBe(PAGE_SIZE);
  });

  test("kind narrows the view", () => {
    expect(buildProgramsFilter({ kind: "thread" }).where).toContain("n.author_is_target = 1");
    expect(buildProgramsFilter({ kind: "thread" }).where).not.toContain("target_comment_count");
    expect(buildProgramsFilter({ kind: "comment" }).where).toContain("n.target_comment_count > 0");
    expect(parseKind("weird")).toBe("all");
  });

  test("search looks at titles, the listed note's body and the target's own comments only", () => {
    const f = buildProgramsFilter({ q: "鉄道" });
    expect(f.values.filter((v) => v === "%鉄道%")).toHaveLength(6);      // 番組名・リンク題名・本文・ちきりんのコメント・放送局・放送タイトル
    expect(f.where).toContain("c.is_target = 1");
    // 一覧に載るノート(ちきりんが関わるもの)の本文は探すが、ほかの人のコメント本文を直接探す条件は無い
    expect(f.where).toContain("n.body_text LIKE");
    expect(f.where).toContain("(n.author_is_target = 1 OR n.target_comment_count > 0)");
    expect(f.where.match(/body_text LIKE/g)).toHaveLength(2);
    expect(f.where).toContain("openchat_note_meta");                       // 編集した放送局・放送タイトルも探す
  });

  test("search terms are escaped and cut to D1's 50-byte LIKE limit", () => {
    expect(likePattern("100%_\\")).toBe("%100\\%\\_\\\\%");
    const long = likePattern("あ".repeat(40));
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(50);
  });

  test("page becomes an offset; broken or out-of-range pages fall back safely", () => {
    expect(buildProgramsFilter({}).offset).toBe(0);
    expect(buildProgramsFilter({ page: 3 }).offset).toBe(2 * PAGE_SIZE);
    expect(buildProgramsFilter({ page: "2", limit: 10 })).toMatchObject({ page: 2, offset: 10, limit: 10 });
    for (const bad of [0, -4, "abc", null, undefined, NaN]) expect(buildProgramsFilter({ page: bad }).page).toBe(1);
    expect(buildProgramsFilter({ page: 10 ** 9 }).page).toBe(MAX_PAGE);
    expect(buildProgramsFilter({ q: "鉄道", page: 2 }).where).not.toContain("OFFSET");   // OFFSET は値として渡す
  });

  test("limit is clamped", () => {
    expect(buildProgramsFilter({ limit: 999 }).limit).toBe(50);
    expect(buildProgramsFilter({ limit: -5 }).limit).toBe(PAGE_SIZE);
  });
});

describe("toProgram", () => {
  const noteRow = (over = {}) => ({ id: "n1", author_name: "参加者B", author_is_target: 0, program_title: "8/23放送 NHKスペシャル", link_title: "地球超解析", link_url: "https://www.nhk-ondemand.jp/x",
    body_text: "他の人が書いた本文", posted_at: "2026-09-21T06:47:00Z", posted_at_precision: "exact", comment_count: 8, last_checked_at: "2026-09-24T03:00:00Z", ...over });

  test("another person's note: its body is returned as the programme info, and only the target's comments", () => {
    const p = toProgram(noteRow(), [
      { id: "c1", body_text: "私もこれ観ました", posted_at: "2026-09-21T07:15:00Z", posted_at_precision: "exact", is_target: 1 },
      { id: "c2", body_text: "補足", posted_at: "2026-09-21T09:00:00Z", posted_at_precision: "approx_hour", is_target: 1 },
    ]);
    expect(p.noteByTarget).toBe(false);
    expect(p.targetBody).toBeNull();
    expect(p.noteBody).toBe("他の人が書いた本文");
    expect(p.targetComments.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(p.latestAt).toBe("2026-09-21T09:00:00Z");                    // ちきりんの最新のコメント
    expect(p.latestPrecision).toBe("approx_hour");
  });

  test("the target's own thread includes the body, and her comments on it", () => {
    const p = toProgram(noteRow({ author_is_target: 1, author_name: "ちきりん", body_text: "報道特集の本文" }), [
      { id: "c1", body_text: "自分で補足", posted_at: "2026-09-21T09:00:00Z", posted_at_precision: "exact", is_target: 1 },
    ]);
    expect(p.noteByTarget).toBe(true);
    expect(p.targetBody).toBe("報道特集の本文");
    expect(p.noteBody).toBe("報道特集の本文");
    expect(p.latestAt).toBe("2026-09-21T09:00:00Z");
    expect(p.targetComments).toHaveLength(1);
  });

  test("a non-target comment row passed in by mistake is never returned", () => {
    const p = toProgram(noteRow(), [{ id: "x", body_text: "他人", posted_at: "2026-09-21T09:00:00Z", posted_at_precision: "exact", is_target: 0 }]);
    expect(p.targetComments).toEqual([]);
  });
});

describe("formatPostedAt", () => {
  test("shows Japan time", () => {
    expect(formatPostedAt("2026-09-23T12:46:00Z", "exact")).toBe("09.23 21:46");
    expect(formatPostedAt("2026-09-23T16:00:00Z", "approx_hour")).toBe("09.24 01:00");
    expect(formatPostedAt("nope", "exact")).toBe("");
  });
});
