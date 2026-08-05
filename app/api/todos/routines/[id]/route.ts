import { env } from "cloudflare:workers";
import { BOARD_ID, now } from "../../_lib";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const body = await request.json().catch(() => null) as Record<string, unknown> | null; const active = body?.active === false ? 0 : body?.active === true ? 1 : null;
  const current = await env.DB.prepare("SELECT * FROM todo_routines WHERE id=? AND board_id=? AND deleted_at IS NULL").bind(id, BOARD_ID).first<Record<string, unknown>>(); if (!current) return Response.json({ error: "繰り返しタスクが見つかりません。" }, { status: 404 });
  if (Number(body?.version) !== Number(current.version)) return Response.json({ error: "ほかの画面で更新されています。再読み込みしてください。" }, { status: 409 });
  if (active === null) return Response.json({ error: "変更内容が不正です。" }, { status: 400 });
  await env.DB.prepare("UPDATE todo_routines SET active=?,version=version+1,updated_at=? WHERE id=?").bind(active, now(), id).run(); return Response.json({ routine: await env.DB.prepare("SELECT * FROM todo_routines WHERE id=?").bind(id).first() });
}
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; const result = await env.DB.prepare("UPDATE todo_routines SET deleted_at=?,updated_at=? WHERE id=? AND board_id=? AND deleted_at IS NULL").bind(now(), now(), id, BOARD_ID).run(); return result.meta.changes ? Response.json({ ok: true }) : Response.json({ error: "繰り返しタスクが見つかりません。" }, { status: 404 }); }
