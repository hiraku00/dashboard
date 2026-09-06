import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { clean, validDate } from "@/app/lib/text";
import { normalizeTask, validTime, type TaskInput } from "@/app/lib/todo-task-input";

export { clean, validDate, normalizeTask, validTime };
export type { TaskInput };
export const BOARD_ID = "todo-default";
export const columnKinds = ["inbox", "today", "doing", "done"] as const;
export type ColumnKind = (typeof columnKinds)[number];

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

export async function boardColumns() {
  await initTodo();
  return ((await env.DB.prepare("SELECT * FROM todo_columns WHERE board_id=? ORDER BY position").bind(BOARD_ID).all<Record<string, unknown>>()).results ?? []);
}

export async function materializeRoutines(date: string) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const routines = (await env.DB.prepare("SELECT * FROM todo_routines WHERE board_id=? AND active=1 AND deleted_at IS NULL").bind(BOARD_ID).all<Record<string, unknown>>()).results ?? [];
  const matching = routines.filter((routine) => {
    if (date < todoDate(new Date(String(routine.created_at)))) return false;
    return routine.schedule_type === "daily" || String(routine.weekdays).split(",").includes(String(weekday));
  });
  if (!matching.length) return;
  // position is a per-(column, date) sequence -- the same rule
  // app/api/todos/tasks/route.ts's POST and .../move/route.ts use -- not a
  // timestamp. This used to bind Date.now() here, so a materialized
  // routine task's position (a 13-digit millisecond epoch) always sorted
  // after every manually created task's (a small integer), no matter when
  // either was actually added. Reading each column's current row count for
  // this date once, then incrementing locally as routines below are
  // assigned to their columns, keeps multiple routines landing in the same
  // column on the same date sequenced correctly relative to each other and
  // to whatever is already there.
  const createdAt = now();
  const existing = (await env.DB.prepare("SELECT column_id, COUNT(*) AS count FROM todo_tasks WHERE board_id=? AND occurrence_date=? AND deleted_at IS NULL GROUP BY column_id").bind(BOARD_ID, date).all<{ column_id: string; count: number }>()).results ?? [];
  const nextPosition = new Map(existing.map((row) => [row.column_id, Number(row.count)]));
  const statements: D1PreparedStatement[] = [];
  for (const routine of matching) {
    const columnId = String(routine.default_column_id);
    const position = (nextPosition.get(columnId) ?? 0) + 1;
    nextPosition.set(columnId, position);
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO todo_tasks (id,board_id,column_id,routine_id,occurrence_date,title,description,priority,due_time,position,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)")
      .bind(crypto.randomUUID(), BOARD_ID, columnId, routine.id, date, routine.title, routine.description, routine.priority, routine.default_due_time ?? null, position, createdAt, createdAt));
  }
  await env.DB.batch(statements);
}

export function taskShape(row: Record<string, unknown>) {
  return { id: row.id, boardId: row.board_id, columnId: row.column_id, routineId: row.routine_id, occurrenceDate: row.occurrence_date, title: row.title, description: row.description, priority: row.priority, dueTime: row.due_time, position: row.position, completedAt: row.completed_at, skippedAt: row.skipped_at, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
