import { env } from "cloudflare:workers";
import { BOARD_ID, boardColumns, materializeRoutines, taskShape, todoDate, validDate } from "../_lib";
import { route } from "@/app/lib/route";

export const GET = route(async (request: Request) => {
  const requested = new URL(request.url).searchParams.get("date") ?? todoDate();
  if (!validDate(requested)) return Response.json({ error: "日付が不正です。" }, { status: 400 });
  const columns = await boardColumns();
  await materializeRoutines(requested);
  const rows = (await env.DB.prepare("SELECT * FROM todo_tasks WHERE board_id=? AND deleted_at IS NULL AND (occurrence_date=? OR occurrence_date IS NULL) ORDER BY position,created_at").bind(BOARD_ID, requested).all<Record<string, unknown>>()).results ?? [];
  const tasks = rows.map(taskShape);
  const today = columns.find((column) => column.kind === "today")?.id;
  const done = columns.find((column) => column.kind === "done")?.id;
  return Response.json({ board: { id: BOARD_ID, name: "To Do", timezone: "Asia/Bangkok" }, date: requested, columns, tasks, summary: { total: tasks.filter((task) => task.occurrenceDate).length, completed: tasks.filter((task) => task.columnId === done && task.occurrenceDate === requested).length, today: tasks.filter((task) => task.columnId === today).length } });
});
