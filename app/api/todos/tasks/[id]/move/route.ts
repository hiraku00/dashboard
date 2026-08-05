import { env } from "cloudflare:workers";
import { BOARD_ID, boardColumns, clean, now, taskShape } from "../../../_lib";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const columnId = clean(body?.columnId, 100); const beforeId = clean(body?.beforeId, 100) || null;
  const current = await env.DB.prepare("SELECT * FROM todo_tasks WHERE id=? AND board_id=? AND deleted_at IS NULL").bind(id, BOARD_ID).first<Record<string, unknown>>();
  if (!current) return Response.json({ error: "タスクが見つかりません。" }, { status: 404 });
  if (Number(body?.version) !== Number(current.version)) return Response.json({ error: "ほかの画面で更新されています。再読み込みしてください。" }, { status: 409 });
  const columns = await boardColumns(); const column = columns.find((item) => item.id === columnId);
  if (!column) return Response.json({ error: "移動先のリストが不正です。" }, { status: 400 });
  const date = current.occurrence_date;
  const peers = (await env.DB.prepare("SELECT id FROM todo_tasks WHERE board_id=? AND column_id=? AND occurrence_date IS ? AND deleted_at IS NULL AND id<>? ORDER BY position,created_at").bind(BOARD_ID, columnId, date, id).all<{ id: string }>()).results ?? [];
  const target = beforeId ? peers.findIndex((peer) => peer.id === beforeId) : -1;
  if (beforeId && target < 0) return Response.json({ error: "挿入位置が見つかりません。" }, { status: 400 });
  const ordered = [...peers.map((peer) => peer.id)]; ordered.splice(target < 0 ? ordered.length : target, 0, id);
  const timestamp = now();
  const completedAt = column.kind === "done" ? (current.completed_at || timestamp) : null;
  await env.DB.batch([
    env.DB.prepare("UPDATE todo_tasks SET column_id=?,position=?,completed_at=?,version=version+1,updated_at=? WHERE id=?").bind(columnId, ordered.indexOf(id) + 1, completedAt, timestamp, id),
    ...ordered.filter((taskId) => taskId !== id).map((taskId) => env.DB.prepare("UPDATE todo_tasks SET position=?,updated_at=? WHERE id=?").bind(ordered.indexOf(taskId) + 1, timestamp, taskId)),
    env.DB.prepare("INSERT INTO todo_task_events (id,task_id,event_type,from_column_id,to_column_id,occurred_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), id, "moved", current.column_id, columnId, timestamp),
  ]);
  const task = await env.DB.prepare("SELECT * FROM todo_tasks WHERE id=?").bind(id).first<Record<string, unknown>>(); return Response.json({ task: task && taskShape(task) });
}
