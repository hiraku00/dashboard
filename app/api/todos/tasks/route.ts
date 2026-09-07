import { env } from "cloudflare:workers";
import { BOARD_ID, boardColumns, clean, materializeRoutines, normalizeTask, now, todoDate } from "../_lib";
import { route } from "@/app/lib/route";

// Wrapped with route() (Issue #77) as the first, feasibility-proving case:
// an exported `const POST = route(...)` (a function expression) rather
// than `export async function POST(...)` (a function declaration) needs to
// still be recognized as this route's POST handler by vinext's build --
// see tests/ssr-parity.test.mjs / manual verification in the PR that
// introduced this file for how that was confirmed before rolling the
// pattern out further.
export const POST = route(async (request: Request) => {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const normalized = normalizeTask(body ?? {});
  if (!normalized.value) return Response.json({ error: normalized.error }, { status: 400 });
  const columns = await boardColumns();
  // Self-healing insurance (Issue #71): if the daily cron ever misses a day,
  // any board write -- not just this one -- catches today's board back up.
  // See the matching comment in app/api/todos/routines/route.ts's POST.
  await materializeRoutines(todoDate());
  const desired = clean(body?.columnId, 100);
  const defaultColumn = columns.find((column) => column.id === (desired || (normalized.value?.occurrenceDate ? "todo-today" : "todo-inbox")));
  if (!defaultColumn) return Response.json({ error: "移動先のリストが見つかりません。" }, { status: 400 });
  const id = crypto.randomUUID(); const createdAt = now();
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM todo_tasks WHERE column_id=? AND occurrence_date IS ? AND deleted_at IS NULL").bind(defaultColumn.id, normalized.value.occurrenceDate).first<{ count: number }>();
  await env.DB.prepare("INSERT INTO todo_tasks (id,board_id,column_id,occurrence_date,title,description,priority,due_time,position,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)").bind(id, BOARD_ID, defaultColumn.id, normalized.value.occurrenceDate, normalized.value.title, normalized.value.description, normalized.value.priority, normalized.value.dueTime, Number(count?.count ?? 0) + 1, createdAt, createdAt).run();
  const task = await env.DB.prepare("SELECT * FROM todo_tasks WHERE id=?").bind(id).first();
  return Response.json({ task }, { status: 201 });
});
