import { describe, expect, test } from "vitest";
import {
  buildProgramsFilter, decodeCursor, encodeCursor, formatPostedAt, likePattern, parseKind, toProgram, PAGE_SIZE,
} from "../app/lib/openchat-query.ts";

describe("cursor", () => {
  test("round-trips and rejects anything malformed", () => {
    const c = { postedAt: "2026-09-23T12:46:00.000Z", id: "11111111-2222-3333-4444-555555555555" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("!!!")).toBeNull();
    expect(decodeCursor(encodeCursor({ postedAt: "'; DROP TABLE x;--", id: "11111111" }))).toBeNull();
    expect(decodeCursor(encodeCursor({ postedAt: "2026-09-23T12:46:00Z", id: "bad id" }))).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });
});

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

  test("search only looks at titles, the target's own note body and the target's own comments", () => {
    const f = buildProgramsFilter({ q: "鉄道" });
    expect(f.values.filter((v) => v === "%鉄道%")).toHaveLength(4);
    expect(f.where).toContain("c.is_target = 1");
    expect(f.where).toContain("n.author_is_target = 1 AND n.body_text LIKE");
    // ほかの人のノート本文・コメント本文を直接探す条件は無い
    expect(f.where.match(/body_text LIKE/g)).toHaveLength(2);
  });

  test("search terms are escaped and cut to D1's 50-byte LIKE limit", () => {
    expect(likePattern("100%_\\")).toBe("%100\\%\\_\\\\%");
    const long = likePattern("あ".repeat(40));
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(50);
  });

  test("cursor adds a keyset condition; a broken cursor is ignored", () => {
    const c = encodeCursor({ postedAt: "2026-09-23T12:46:00.000Z", id: "11111111-2222-3333-4444-555555555555" });
    const f = buildProgramsFilter({ cursor: c });
    expect(f.where).toContain("n.posted_at < ?");
    expect(f.values.slice(-3)).toEqual(["2026-09-23T12:46:00.000Z", "2026-09-23T12:46:00.000Z", "11111111-2222-3333-4444-555555555555"]);
    expect(buildProgramsFilter({ cursor: "garbage" }).where).not.toContain("posted_at <");
  });

  test("limit is clamped", () => {
    expect(buildProgramsFilter({ limit: 999 }).limit).toBe(50);
    expect(buildProgramsFilter({ limit: -5 }).limit).toBe(PAGE_SIZE);
  });
});

describe("toProgram", () => {
  const noteRow = (over = {}) => ({ id: "n1", author_name: "参加者B", author_is_target: 0, program_title: "8/23放送 NHKスペシャル", link_title: "地球超解析", link_url: "https://www.nhk-ondemand.jp/x",
    body_text: "他の人が書いた本文", posted_at: "2026-09-21T06:47:00Z", posted_at_precision: "exact", comment_count: 8, last_checked_at: "2026-09-24T03:00:00Z", ...over });

  test("another person's note: no body is returned, only the target's comments (oldest first as given)", () => {
    const p = toProgram(noteRow(), [
      { id: "c1", body_text: "私もこれ観ました", posted_at: "2026-09-21T07:15:00Z", posted_at_precision: "exact", is_target: 1 },
      { id: "c2", body_text: "補足", posted_at: "2026-09-21T09:00:00Z", posted_at_precision: "approx_hour", is_target: 1 },
    ]);
    expect(p.noteByTarget).toBe(false);
    expect(p.targetBody).toBeNull();
    expect(p.targetComments.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(JSON.stringify(p)).not.toContain("他の人が書いた本文");
  });

  test("the target's own thread includes the body, and her comments on it", () => {
    const p = toProgram(noteRow({ author_is_target: 1, author_name: "ちきりん", body_text: "報道特集の本文" }), [
      { id: "c1", body_text: "自分で補足", posted_at: "2026-09-21T09:00:00Z", posted_at_precision: "exact", is_target: 1 },
    ]);
    expect(p.noteByTarget).toBe(true);
    expect(p.targetBody).toBe("報道特集の本文");
    expect(p.targetComments).toHaveLength(1);
  });

  test("a non-target comment row passed in by mistake is never returned", () => {
    const p = toProgram(noteRow(), [{ id: "x", body_text: "他人", posted_at: "2026-09-21T09:00:00Z", posted_at_precision: "exact", is_target: 0 }]);
    expect(p.targetComments).toEqual([]);
  });
});

describe("formatPostedAt", () => {
  test("shows Japan time and marks approximate times", () => {
    expect(formatPostedAt("2026-09-23T12:46:00Z", "exact")).toBe("2026.09.23 21:46");
    expect(formatPostedAt("2026-09-23T16:00:00Z", "approx_hour")).toBe("約 2026.09.24 01:00");
    expect(formatPostedAt("nope", "exact")).toBe("");
  });
});
