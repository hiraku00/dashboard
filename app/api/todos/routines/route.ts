import { env } from "cloudflare:workers";
import { BOARD_ID, boardColumns, clean, materializeRoutines, now, todoDate } from "../_lib";
import { listRoutines } from "@/app/lib/queries/todo";
import { routineInput } from "@/app/lib/todo-task-input";
import { route } from "@/app/lib/route";

// Re-exported for app/api/todos/routines/[id]/route.ts, which imports this
// from here rather than from app/lib/todo-task-input.ts directly -- the
// actual pure logic lives there (see that file for why).
export { routineInput };

export const GET = route(async () => Response.json({ routines: await listRoutines() }));
export const POST = route(async (request: Request) => {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null; const normalized = routineInput(body ?? {}); if (!normalized.value) return Response.json({ error: normalized.error }, { status: 400 });
  const columns = await boardColumns(); const defaultColumnId = clean(body?.defaultColumnId, 100) || "todo-today"; if (!columns.some((column) => column.id === defaultColumnId)) return Response.json({ error: "生成先のリストが不正です。" }, { status: 400 });
  const id = crypto.randomUUID(); const timestamp = now(); await env.DB.prepare("INSERT INTO todo_routines (id,board_id,title,description,priority,schedule_type,weekdays,default_column_id,default_due_time,active,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?)").bind(id, BOARD_ID, normalized.value.title, normalized.value.description, normalized.value.priority, normalized.value.scheduleType, normalized.value.weekdays, defaultColumnId, normalized.value.dueTime, timestamp, timestamp).run();
  // Self-healing insurance (Issue #71): a newly created routine can already
  // qualify for today, and the daily cron that would otherwise pick it up
  // has usually already run for today by the time a user creates it. Without
  // this, a routine created today would silently wait until tomorrow's cron
  // to show its first card.
  await materializeRoutines(todoDate());
  return Response.json({ routine: await env.DB.prepare("SELECT * FROM todo_routines WHERE id=?").bind(id).first() }, { status: 201 });
});
