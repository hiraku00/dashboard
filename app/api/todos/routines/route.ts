import { env } from "cloudflare:workers";
import { BOARD_ID, boardColumns, clean, now, validTime } from "../_lib";

export function routineInput(body: Record<string, unknown>) {
  const title = clean(body.title, 240); const description = clean(body.description, 6000); const scheduleType = clean(body.scheduleType, 20); const dueTime = clean(body.dueTime, 5);
  const weekdays = Array.isArray(body.weekdays) ? body.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort().join(",") : "";
  const priority = body.priority === "" || body.priority === null || body.priority === undefined ? null : Number(body.priority);
  if (!title) return { error: "繰り返しタスク名を入力してください。" }; if (scheduleType !== "daily" && scheduleType !== "weekdays") return { error: "繰り返し設定が不正です。" };
  if (scheduleType === "weekdays" && !weekdays) return { error: "曜日を1つ以上選択してください。" }; if (priority !== null && (!Number.isInteger(priority) || priority < 1 || priority > 5)) return { error: "優先度は1〜5で指定してください。" };
  if (!validTime(dueTime)) return { error: "時刻は HH:MM 形式で指定してください。" };
  return { value: { title, description, scheduleType, weekdays, priority, dueTime: dueTime || null } };
}

export async function GET() { await boardColumns(); const routines = (await env.DB.prepare("SELECT * FROM todo_routines WHERE board_id=? AND deleted_at IS NULL ORDER BY active DESC,created_at DESC").bind(BOARD_ID).all()).results ?? []; return Response.json({ routines }); }
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null; const normalized = routineInput(body ?? {}); if (!normalized.value) return Response.json({ error: normalized.error }, { status: 400 });
  const columns = await boardColumns(); const defaultColumnId = clean(body?.defaultColumnId, 100) || "todo-today"; if (!columns.some((column) => column.id === defaultColumnId)) return Response.json({ error: "生成先のリストが不正です。" }, { status: 400 });
  const id = crypto.randomUUID(); const timestamp = now(); await env.DB.prepare("INSERT INTO todo_routines (id,board_id,title,description,priority,schedule_type,weekdays,default_column_id,default_due_time,active,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?)").bind(id, BOARD_ID, normalized.value.title, normalized.value.description, normalized.value.priority, normalized.value.scheduleType, normalized.value.weekdays, defaultColumnId, normalized.value.dueTime, timestamp, timestamp).run();
  return Response.json({ routine: await env.DB.prepare("SELECT * FROM todo_routines WHERE id=?").bind(id).first() }, { status: 201 });
}
