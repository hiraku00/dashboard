/** Pure validation/normalization for the To Do board's write paths -- no
 *  D1, no I/O. Kept separate from app/api/todos/_lib.ts and
 *  app/api/todos/routines/route.ts (which do the actual D1 writes) for the
 *  same reason as app/lib/watch-list-item-input.ts: a module that imports
 *  "cloudflare:workers" at the top level cannot be loaded outside the
 *  Workers runtime at all, let alone unit tested under plain `node --test`.
 *
 *  Imports app/lib/text.ts by relative path with an explicit .ts extension
 *  rather than the "@/..." alias -- see the matching comment in
 *  app/lib/watch-list-item-input.ts. */
import { clean, validDate } from "./text.ts";

export type TaskInput = { title?: unknown; description?: unknown; priority?: unknown; occurrenceDate?: unknown; dueTime?: unknown; columnId?: unknown; version?: unknown };

export const validTime = (value: string) => !value || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** app/api/todos/tasks/route.ts (POST) and app/api/todos/tasks/[id]/route.ts
 *  (PATCH) both go through this via app/api/todos/_lib.ts's re-export. */
export function normalizeTask(input: TaskInput) {
  const title = clean(input.title, 240); const description = clean(input.description, 6000);
  const occurrenceDate = clean(input.occurrenceDate, 10); const dueTime = clean(input.dueTime, 5);
  const priorityRaw = input.priority === "" || input.priority === null || input.priority === undefined ? null : Number(input.priority);
  if (!title) return { error: "タスク名を入力してください。" };
  if (!validDate(occurrenceDate)) return { error: "実施日は YYYY-MM-DD 形式で指定してください。" };
  if (!validTime(dueTime)) return { error: "時刻は HH:MM 形式で指定してください。" };
  if (priorityRaw !== null && (!Number.isInteger(priorityRaw) || priorityRaw < 1 || priorityRaw > 5)) return { error: "優先度は1〜5で指定してください。" };
  return { value: { title, description, occurrenceDate: occurrenceDate || null, dueTime: dueTime || null, priority: priorityRaw } };
}

/** app/api/todos/routines/route.ts's POST and app/api/todos/routines/[id]/route.ts's
 *  PATCH both go through this via the re-export in routines/route.ts. */
export function routineInput(body: Record<string, unknown>) {
  const title = clean(body.title, 240); const description = clean(body.description, 6000); const scheduleType = clean(body.scheduleType, 20); const dueTime = clean(body.dueTime, 5);
  const weekdays = Array.isArray(body.weekdays) ? body.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort().join(",") : "";
  const priority = body.priority === "" || body.priority === null || body.priority === undefined ? null : Number(body.priority);
  if (!title) return { error: "繰り返しタスク名を入力してください。" }; if (scheduleType !== "daily" && scheduleType !== "weekdays") return { error: "繰り返し設定が不正です。" };
  if (scheduleType === "weekdays" && !weekdays) return { error: "曜日を1つ以上選択してください。" }; if (priority !== null && (!Number.isInteger(priority) || priority < 1 || priority > 5)) return { error: "優先度は1〜5で指定してください。" };
  if (!validTime(dueTime)) return { error: "時刻は HH:MM 形式で指定してください。" };
  return { value: { title, description, scheduleType, weekdays, priority, dueTime: dueTime || null } };
}
