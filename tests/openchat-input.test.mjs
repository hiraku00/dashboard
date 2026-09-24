import { describe, expect, test } from "vitest";
import {
  MAX_COMMENTS_PER_NOTE, MAX_NOTES_PER_REQUEST, normalizeComment, normalizeComplete, normalizeNote, normalizeNotesBatch, normalizeUtc,
} from "../app/lib/openchat-input.ts";

const ID = "11111111-2222-3333-4444-555555555555";
const CID = "aaaaaaaa-2222-3333-4444-555555555555";

const note = (over = {}) => ({
  id: ID, room: "atsumare-tv", authorName: "ちきりん", authorIsTarget: true, programTitle: "9月23日の報道特集", linkTitle: "", linkUrl: "https://example.com/a",
  bodyText: "本文です。  \n\n二段落目", bodyComplete: true, postedAt: "2026-09-23T12:46:00Z", postedAtPrecision: "exact", postedAtRaw: "昨日 午後 9:46",
  commentCount: 1, needsRecheck: false, firstSeenAt: "2026-09-24T12:00:00+09:00", lastCheckedAt: "2026-09-24T12:00:00+09:00", deletedAt: null,
  comments: [{ id: CID, ordinal: 0, authorName: "ちきりん", isTarget: true, bodyText: "補足です", postedAt: "2026-09-23T14:00:00Z", postedAtPrecision: "approx_hour",
    postedAtRaw: "7時間前", ocrMinConfidence: 0.5, firstSeenAt: "2026-09-24T12:00:00+09:00", lastSeenAt: "2026-09-24T12:00:00+09:00", deletedAt: null }],
  ...over,
});

describe("normalizeUtc", () => {
  test("accepts UTC ISO with or without seconds and rejects everything else", () => {
    expect(normalizeUtc("2026-09-23T12:46:00Z")).toBe("2026-09-23T12:46:00Z");
    expect(normalizeUtc("2026-09-23T12:46Z")).toBe("2026-09-23T12:46:00Z");
    expect(normalizeUtc("2026-09-23T12:46:00+09:00")).toBeNull();   // 並べ替えを文字列で行うので、UTCのみ
    expect(normalizeUtc("2026-13-45T99:99:00Z")).toBeNull();
    expect(normalizeUtc("昨日")).toBeNull();
    expect(normalizeUtc(null)).toBeNull();
  });
});

describe("normalizeNote", () => {
  test("keeps the target note and its comments, tidies the body", () => {
    const r = normalizeNote(note());
    expect(r.error).toBeUndefined();
    expect(r.value.bodyText).toBe("本文です。\n\n二段落目");
    expect(r.value.authorIsTarget).toBe(true);
    expect(r.value.comments).toHaveLength(1);
    expect(r.value.comments[0].isTarget).toBe(true);
    expect(r.value.comments[0].postedAtPrecision).toBe("approx_hour");
    expect(r.value.firstSeenAt).toBe("2026-09-24T03:00:00.000Z");
  });

  test("a target flag must be literally true (a string 'true' is not enough)", () => {
    expect(normalizeNote(note({ authorIsTarget: "true" })).value.authorIsTarget).toBe(false);
  });

  test.each([
    ["bad id", { id: "x" }],
    ["bad postedAt", { postedAt: "yesterday" }],
    ["bad precision", { postedAtPrecision: "exactish" }],
    ["missing author", { authorName: "" }],
    ["missing room", { room: "" }],
  ])("rejects %s", (_name, over) => {
    expect(normalizeNote(note(over)).error).toBeTruthy();
  });

  test("drops non-http link urls", () => {
    expect(normalizeNote(note({ linkUrl: "javascript:alert(1)" })).value.linkUrl).toBe("");
  });

  test("rejects a note with too many comments in one request", () => {
    const many = Array.from({ length: MAX_COMMENTS_PER_NOTE + 1 }, (_, i) => ({ ...note().comments[0], id: `bbbbbbbb-${String(i).padStart(4, "0")}-0000-0000-000000000000` }));
    expect(normalizeNote(note({ comments: many })).error).toBeTruthy();
  });

  test("a comment needs a valid id, time and author", () => {
    expect(normalizeComment({ ...note().comments[0], id: "!" }, ID).error).toBeTruthy();
    expect(normalizeComment({ ...note().comments[0], postedAt: "x" }, ID).error).toBeTruthy();
    expect(normalizeComment({ ...note().comments[0], authorName: "" }, ID).error).toBeTruthy();
    expect(normalizeComment({ ...note().comments[0], ocrMinConfidence: 7 }, ID).value.ocrMinConfidence).toBe(1);
  });
});

describe("normalizeNotesBatch", () => {
  test("one broken note does not block the others", () => {
    const r = normalizeNotesBatch([note(), note({ id: "22222222-2222-3333-4444-555555555555", postedAt: "bad" })]);
    expect(r.value.notes).toHaveLength(1);
    expect(r.value.errors).toHaveLength(1);
    expect(r.value.errors[0].id).toBe("22222222-2222-3333-4444-555555555555");
  });

  test("limits the batch size", () => {
    expect(normalizeNotesBatch([]).error).toBeTruthy();
    expect(normalizeNotesBatch("x").error).toBeTruthy();
    const many = Array.from({ length: MAX_NOTES_PER_REQUEST + 1 }, () => note({ comments: [] }));
    expect(normalizeNotesBatch(many).error).toBeTruthy();
  });

  test("limits the comments in one request", () => {
    const c = (i) => ({ ...note().comments[0], id: `cccccccc-${String(i).padStart(4, "0")}-0000-0000-000000000000` });
    const a = note({ comments: Array.from({ length: 40 }, (_, i) => c(i)) });
    const b = note({ id: "22222222-2222-3333-4444-555555555555", comments: Array.from({ length: 40 }, (_, i) => c(100 + i)) });
    expect(normalizeNotesBatch([a, b]).error).toBeTruthy();
  });
});

describe("normalizeComplete", () => {
  test("accepts a known status and clamps counters", () => {
    const r = normalizeComplete({ status: "partial", stats: { notesScanned: 5, commentsNew: -3, targetCommentsNew: "x" }, warnings: ["a", "", 5] });
    expect(r.value).toMatchObject({ status: "partial", notesScanned: 5, commentsNew: 0, targetCommentsNew: 0, warnings: ["a"] });
    expect(normalizeComplete({ status: "started" }).error).toBeTruthy();
  });
});
