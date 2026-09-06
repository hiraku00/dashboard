import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTask, routineInput, validTime } from "../app/lib/todo-task-input.ts";

// normalizeTask() and routineInput() are the pure validation/normalization
// steps app/api/todos/tasks/*, .../tasks/[id]/*, and .../routines/* all go
// through before writing to D1.

test("validTime accepts empty and HH:MM within range, rejects the rest", () => {
  assert.equal(validTime(""), true);
  assert.equal(validTime("00:00"), true);
  assert.equal(validTime("23:59"), true);
  assert.equal(validTime("24:00"), false);
  assert.equal(validTime("9:00"), false);
  assert.equal(validTime("12:60"), false);
});

test("normalizeTask requires a non-empty title", () => {
  assert.equal(normalizeTask({}).error, "タスク名を入力してください。");
  assert.equal(normalizeTask({ title: "  " }).error, "タスク名を入力してください。");
});

test("normalizeTask rejects a malformed occurrenceDate", () => {
  const result = normalizeTask({ title: "t", occurrenceDate: "2026/01/01" });
  assert.equal(result.error, "実施日は YYYY-MM-DD 形式で指定してください。");
});

test("normalizeTask rejects a malformed dueTime", () => {
  const result = normalizeTask({ title: "t", dueTime: "25:00" });
  assert.equal(result.error, "時刻は HH:MM 形式で指定してください。");
});

test("normalizeTask rejects a priority outside 1-5", () => {
  assert.equal(normalizeTask({ title: "t", priority: 0 }).error, "優先度は1〜5で指定してください。");
  assert.equal(normalizeTask({ title: "t", priority: 6 }).error, "優先度は1〜5で指定してください。");
});

test("normalizeTask normalizes blank occurrenceDate/dueTime to null", () => {
  const result = normalizeTask({ title: "t" });
  assert.deepEqual(result.value, { title: "t", description: "", occurrenceDate: null, dueTime: null, priority: null });
});

test("routineInput requires a non-empty title", () => {
  assert.equal(routineInput({}).error, "繰り返しタスク名を入力してください。");
});

test("routineInput rejects an unrecognized scheduleType", () => {
  const result = routineInput({ title: "t", scheduleType: "monthly" });
  assert.equal(result.error, "繰り返し設定が不正です。");
});

test("routineInput requires at least one weekday when scheduleType is weekdays", () => {
  const result = routineInput({ title: "t", scheduleType: "weekdays", weekdays: [] });
  assert.equal(result.error, "曜日を1つ以上選択してください。");
});

test("routineInput sorts and dedupes weekdays into a comma-joined string, dropping out-of-range values", () => {
  const result = routineInput({ title: "t", scheduleType: "weekdays", weekdays: [5, 1, 3, 9, -1] });
  assert.equal(result.value?.weekdays, "1,3,5");
});

test("routineInput does not require weekdays when scheduleType is daily", () => {
  const result = routineInput({ title: "t", scheduleType: "daily" });
  assert.equal(result.value?.weekdays, "");
});

test("routineInput rejects a priority outside 1-5", () => {
  assert.equal(routineInput({ title: "t", scheduleType: "daily", priority: 0 }).error, "優先度は1〜5で指定してください。");
});

test("routineInput rejects a malformed dueTime", () => {
  const result = routineInput({ title: "t", scheduleType: "daily", dueTime: "not-a-time" });
  assert.equal(result.error, "時刻は HH:MM 形式で指定してください。");
});
