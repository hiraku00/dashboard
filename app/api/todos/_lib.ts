import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { clean, validDate } from "@/app/lib/text";

export { clean, validDate };
export const BOARD_ID = "todo-default";
export const columnKinds = ["inbox", "today", "doing", "done"] as const;
export type ColumnKind = (typeof columnKinds)[number];
export type TaskInput = { title?: unknown; description?: unknown; priority?: unknown; occurrenceDate?: unknown; dueTime?: unknown; columnId?: unknown; version?: unknown };

export const validTime = (value: string) => !value || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export const now = () => new Date().toISOString();

export function todoDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export async function initTodo() {
  await ensureSchema({ seed: false });
  const existing = (await env.DB.prepare("SELECT id FROM todo_boards WHERE id=?").bind(BOARD_ID).all()).results?.[0];
  if (existing) return;
  const createdAt = now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO todo_boards (id,name,timezone,created_at) VALUES (?,?,?,?)").bind(BOARD_ID, "To Do", "Asia/Bangkok", createdAt),
    ...[["todo-inbox", "受信箱", "inbox"], ["todo-today", "今日", "today"], ["todo-doing", "進行中", "doing"], ["todo-done", "完了", "done"]].map(([id, name, kind], position) => env.DB.prepare("INSERT OR IGNORE INTO todo_columns (id,board_id,name,kind,position,created_at) VALUES (?,?,?,?,?,?)").bind(id, BOARD_ID, name, kind, position, createdAt)),
  ]);
}

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

export async function boardColumns() {
  await initTodo();
  return ((await env.DB.prepare("SELECT * FROM todo_columns WHERE board_id=? ORDER BY position").bind(BOARD_ID).all<Record<string, unknown>>()).results ?? []);
}

export async function materializeRoutines(date: string) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const routines = (await env.DB.prepare("SELECT * FROM todo_routines WHERE board_id=? AND active=1 AND deleted_at IS NULL").bind(BOARD_ID).all<Record<string, unknown>>()).results ?? [];
  const createdAt = now();
  const statements: D1PreparedStatement[] = [];
  for (const routine of routines) {
    if (date < todoDate(new Date(String(routine.created_at)))) continue;
    const matches = routine.schedule_type === "daily" || String(routine.weekdays).split(",").includes(String(weekday));
    if (!matches) continue;
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO todo_tasks (id,board_id,column_id,routine_id,occurrence_date,title,description,priority,due_time,position,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)")
      .bind(crypto.randomUUID(), BOARD_ID, routine.default_column_id, routine.id, date, routine.title, routine.description, routine.priority, routine.default_due_time ?? null, Date.now(), createdAt, createdAt));
  }
  if (statements.length) await env.DB.batch(statements);
}

export function taskShape(row: Record<string, unknown>) {
  return { id: row.id, boardId: row.board_id, columnId: row.column_id, routineId: row.routine_id, occurrenceDate: row.occurrence_date, title: row.title, description: row.description, priority: row.priority, dueTime: row.due_time, position: row.position, completedAt: row.completed_at, skippedAt: row.skipped_at, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
