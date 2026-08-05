import { env } from "cloudflare:workers";
import { BOARD_ID, boardColumns, normalizeTask, now, taskShape } from "../../_lib";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; const row = await env.DB.prepare("SELECT * FROM todo_tasks WHERE id=? AND board_id=? AND deleted_at IS NULL").bind(id, BOARD_ID).first<Record<string, unknown>>(); return row ? Response.json({ task: taskShape(row) }) : Response.json({ error: "タスクが見つかりません。" }, { status: 404 }); }

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const body = await request.json().catch(() => null) as Record<string, unknown> | null; const normalized = normalizeTask(body ?? {});
  if (!normalized.value) return Response.json({ error: normalized.error }, { status: 400 });
  const current = await env.DB.prepare("SELECT * FROM todo_tasks WHERE id=? AND board_id=? AND deleted_at IS NULL").bind(id, BOARD_ID).first<Record<string, unknown>>();
  if (!current) return Response.json({ error: "タスクが見つかりません。" }, { status: 404 });
  if (Number(body?.version) !== Number(current.version)) return Response.json({ error: "ほかの画面で更新されています。再読み込みしてください。" }, { status: 409 });
  const columns = await boardColumns(); const columnId = typeof body?.columnId === "string" ? body.columnId : String(current.column_id);
  if (!columns.some((column) => column.id === columnId)) return Response.json({ error: "移動先のリストが不正です。" }, { status: 400 });
  const completedAt = columns.find((column) => column.id === columnId)?.kind === "done" ? (current.completed_at || now()) : null;
  await env.DB.prepare("UPDATE todo_tasks SET column_id=?,occurrence_date=?,title=?,description=?,priority=?,due_time=?,completed_at=?,version=version+1,updated_at=? WHERE id=?").bind(columnId, normalized.value.occurrenceDate, normalized.value.title, normalized.value.description, normalized.value.priority, normalized.value.dueTime, completedAt, now(), id).run();
  const task = await env.DB.prepare("SELECT * FROM todo_tasks WHERE id=?").bind(id).first<Record<string, unknown>>(); return Response.json({ task: task && taskShape(task) });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; const result = await env.DB.prepare("UPDATE todo_tasks SET deleted_at=?,updated_at=? WHERE id=? AND board_id=? AND deleted_at IS NULL").bind(now(), now(), id, BOARD_ID).run(); return result.meta.changes ? Response.json({ ok: true }) : Response.json({ error: "タスクが見つかりません。" }, { status: 404 }); }
