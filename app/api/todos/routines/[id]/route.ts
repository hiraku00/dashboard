import { env } from "cloudflare:workers";
import { BOARD_ID, now } from "../../_lib";
import { routineInput } from "../route";
import { route } from "@/app/lib/route";

export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params; const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const current = await env.DB.prepare("SELECT * FROM todo_routines WHERE id=? AND board_id=? AND deleted_at IS NULL").bind(id, BOARD_ID).first<Record<string, unknown>>(); if (!current) return Response.json({ error: "繰り返しタスクが見つかりません。" }, { status: 404 });
  // `current` is still fetched above for the 404 check, but the version
  // match itself is decided by each UPDATE's own WHERE clause (AND
  // version=?) below, not by comparing here beforehand -- see the matching
  // comment in app/api/items/[id]/route.ts for why.
  const expectedVersion = Number(body?.version);

  if (body && "active" in body && !("title" in body)) {
    const active = body.active === false ? 0 : body.active === true ? 1 : null;
    if (active === null) return Response.json({ error: "変更内容が不正です。" }, { status: 400 });
    const result = await env.DB.prepare("UPDATE todo_routines SET active=?,version=version+1,updated_at=? WHERE id=? AND version=?").bind(active, now(), id, expectedVersion).run();
    if (!result.meta.changes) return Response.json({ error: "ほかの画面で更新されています。再読み込みしてください。" }, { status: 409 });
    return Response.json({ routine: await env.DB.prepare("SELECT * FROM todo_routines WHERE id=?").bind(id).first() });
  }

  const normalized = routineInput(body ?? {}); if (!normalized.value) return Response.json({ error: normalized.error }, { status: 400 });
  const result = await env.DB.prepare("UPDATE todo_routines SET title=?,description=?,priority=?,schedule_type=?,weekdays=?,default_due_time=?,version=version+1,updated_at=? WHERE id=? AND version=?")
    .bind(normalized.value.title, normalized.value.description, normalized.value.priority, normalized.value.scheduleType, normalized.value.weekdays, normalized.value.dueTime, now(), id, expectedVersion).run();
  if (!result.meta.changes) return Response.json({ error: "ほかの画面で更新されています。再読み込みしてください。" }, { status: 409 });
  return Response.json({ routine: await env.DB.prepare("SELECT * FROM todo_routines WHERE id=?").bind(id).first() });
});
export const DELETE = route(async (_: Request, { params }: { params: Promise<{ id: string }> }) => { const { id } = await params; const result = await env.DB.prepare("UPDATE todo_routines SET deleted_at=?,updated_at=? WHERE id=? AND board_id=? AND deleted_at IS NULL").bind(now(), now(), id, BOARD_ID).run(); return result.meta.changes ? Response.json({ ok: true }) : Response.json({ error: "繰り返しタスクが見つかりません。" }, { status: 404 }); });
