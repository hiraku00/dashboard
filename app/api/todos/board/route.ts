import { todoDate, validDate } from "../_lib";
import { boardSnapshot } from "@/app/lib/queries/todo";
import { route } from "@/app/lib/route";

// materializeRoutines() no longer runs here (Issue #71): a GET used to
// write to D1 on every view, which Next.js's <Link> prefetching or a
// re-render could trigger an unbounded number of times. It now runs only
// from the daily cron (worker/index.ts's `scheduled`) and, as a
// self-healing insurance measure in case that cron ever misses a day, from
// the write endpoints that can newly qualify a routine for today's board
// (see app/api/todos/routines/route.ts, .../[id]/route.ts, and
// app/api/todos/tasks*/route.ts).
export const GET = route(async (request: Request) => {
  const requested = new URL(request.url).searchParams.get("date") ?? todoDate();
  if (!validDate(requested)) return Response.json({ error: "日付が不正です。" }, { status: 400 });
  return Response.json(await boardSnapshot(requested));
});
