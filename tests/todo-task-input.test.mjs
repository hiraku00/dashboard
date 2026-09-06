import { expect, test } from "vitest";

import { normalizeTask, routineInput, validTime } from "../app/lib/todo-task-input.ts";

// normalizeTask() and routineInput() are the pure validation/normalization
// steps app/api/todos/tasks/*, .../tasks/[id]/*, and .../routines/* all go
// through before writing to D1.

test("validTime accepts empty and HH:MM within range, rejects the rest", () => {
  expect(validTime("")).toBe(true);
  expect(validTime("00:00")).toBe(true);
  expect(validTime("23:59")).toBe(true);
  expect(validTime("24:00")).toBe(false);
  expect(validTime("9:00")).toBe(false);
  expect(validTime("12:60")).toBe(false);
});

test("normalizeTask requires a non-empty title", () => {
  expect(normalizeTask({}).error).toBe("タスク名を入力してください。");
  expect(normalizeTask({ title: "  " }).error).toBe("タスク名を入力してください。");
});

test("normalizeTask rejects a malformed occurrenceDate", () => {
  const result = normalizeTask({ title: "t", occurrenceDate: "2026/01/01" });
  expect(result.error).toBe("実施日は YYYY-MM-DD 形式で指定してください。");
});

test("normalizeTask rejects a malformed dueTime", () => {
  const result = normalizeTask({ title: "t", dueTime: "25:00" });
  expect(result.error).toBe("時刻は HH:MM 形式で指定してください。");
});

test("normalizeTask rejects a priority outside 1-5", () => {
  expect(normalizeTask({ title: "t", priority: 0 }).error).toBe("優先度は1〜5で指定してください。");
  expect(normalizeTask({ title: "t", priority: 6 }).error).toBe("優先度は1〜5で指定してください。");
});

test("normalizeTask normalizes blank occurrenceDate/dueTime to null", () => {
  const result = normalizeTask({ title: "t" });
  expect(result.value).toEqual({ title: "t", description: "", occurrenceDate: null, dueTime: null, priority: null });
});

test("routineInput requires a non-empty title", () => {
  expect(routineInput({}).error).toBe("繰り返しタスク名を入力してください。");
});

test("routineInput rejects an unrecognized scheduleType", () => {
  const result = routineInput({ title: "t", scheduleType: "monthly" });
  expect(result.error).toBe("繰り返し設定が不正です。");
});

test("routineInput requires at least one weekday when scheduleType is weekdays", () => {
  const result = routineInput({ title: "t", scheduleType: "weekdays", weekdays: [] });
  expect(result.error).toBe("曜日を1つ以上選択してください。");
});

test("routineInput sorts and dedupes weekdays into a comma-joined string, dropping out-of-range values", () => {
  const result = routineInput({ title: "t", scheduleType: "weekdays", weekdays: [5, 1, 3, 9, -1] });
  expect(result.value?.weekdays).toBe("1,3,5");
});

test("routineInput does not require weekdays when scheduleType is daily", () => {
  const result = routineInput({ title: "t", scheduleType: "daily" });
  expect(result.value?.weekdays).toBe("");
});

test("routineInput rejects a priority outside 1-5", () => {
  expect(routineInput({ title: "t", scheduleType: "daily", priority: 0 }).error).toBe("優先度は1〜5で指定してください。");
});

test("routineInput rejects a malformed dueTime", () => {
  const result = routineInput({ title: "t", scheduleType: "daily", dueTime: "not-a-time" });
  expect(result.error).toBe("時刻は HH:MM 形式で指定してください。");
});
