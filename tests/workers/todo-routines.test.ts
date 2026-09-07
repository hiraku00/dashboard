import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { BOARD_ID, materializeRoutines, now, todoDate } from "@/app/api/todos/_lib";
import { GET as boardGet } from "@/app/api/todos/board/route";
import { POST as routinesPost } from "@/app/api/todos/routines/route";
import { PATCH as routinesPatch } from "@/app/api/todos/routines/[id]/route";
import { POST as tasksPost } from "@/app/api/todos/tasks/route";

// Replaces tests/rendered-html.test.mjs's "ships the To Do board,
// recurring-task API, and portal navigation" (Issue #94, part of Issue #80's
// original Stage 4 scope). That test only grepped source files for
// `materializeRoutines`, `schedule_type`, and the UNIQUE(routine_id,
// occurrence_date) constraint in migrations/0003_todo.sql -- it never
// actually created a routine or confirmed one materializes into a task.
//
// Rewritten for Issue #71: materializeRoutines() used to run inside GET
// /api/todos/board (a read), so viewing or prefetching the board could write
// to D1 an unbounded number of times. It now runs only from (a) the daily
// cron (worker/index.ts's `scheduled`, exercised here by calling
// materializeRoutines() directly the same way that handler does -- not
// through a simulated cron trigger, which @cloudflare/vitest-pool-workers
// does not expose) and (b) self-healing insurance in the write endpoints
// that can newly qualify a routine for today (see app/api/todos/routines*
// and app/api/todos/tasks*'s own comments).

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

async function insertRoutineDirectly(overrides: Partial<{ active: number; scheduleType: string; weekdays: string }> = {}) {
  const id = crypto.randomUUID();
  const timestamp = now();
  await env.DB.prepare(
    "INSERT INTO todo_routines (id,board_id,title,description,priority,schedule_type,weekdays,default_column_id,default_due_time,active,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)",
  ).bind(
    id,
    BOARD_ID,
    "db-direct-routine-test",
    "",
    null,
    overrides.scheduleType ?? "daily",
    overrides.weekdays ?? "",
    "todo-today",
    null,
    overrides.active ?? 1,
    timestamp,
    timestamp,
  ).run();
  return id;
}

test("GET /api/todos/board does not itself materialize a routine that already exists in D1", async () => {
  // Inserted directly, bypassing POST /api/todos/routines, so none of that
  // endpoint's own materialize-on-create insurance runs -- this simulates
  // "a routine already existed before today's cron next fires".
  const id = await insertRoutineDirectly();
  const board = await boardGet(new Request("http://x/api/todos/board"));
  const { tasks } = (await board.json()) as { tasks: Array<{ routineId: string | null }> };
  expect(tasks.some((task) => task.routineId === id)).toBe(false);
});

test("the daily cron's materialization (materializeRoutines) picks up a routine GET alone never would", async () => {
  const id = await insertRoutineDirectly();
  await materializeRoutines(todoDate());
  const board = await boardGet(new Request("http://x/api/todos/board"));
  const { tasks } = (await board.json()) as { tasks: Array<{ routineId: string | null; columnId: string }> };
  const materialized = tasks.filter((task) => task.routineId === id);
  expect(materialized).toHaveLength(1);
  expect(materialized[0].columnId).toBe("todo-today");
});

test("creating a daily routine self-heals today's board immediately, without waiting for cron", async () => {
  const created = await routinesPost(
    new Request("http://x/api/todos/routines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "routine-create-insurance-test", scheduleType: "daily", defaultColumnId: "todo-today" }),
    }),
  );
  expect(created.status).toBe(201);
  const { routine } = (await created.json()) as { routine: { id: string } };

  const board = await boardGet(new Request("http://x/api/todos/board"));
  const { tasks } = (await board.json()) as { tasks: Array<{ routineId: string | null; title: string }> };
  const materialized = tasks.filter((task) => task.routineId === routine.id);
  expect(materialized).toHaveLength(1);
  expect(materialized[0].title).toBe("routine-create-insurance-test");
});

test("creating a routine twice via materialize insurance never duplicates the day's task (UNIQUE(routine_id, occurrence_date))", async () => {
  const created = await routinesPost(
    new Request("http://x/api/todos/routines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "double-insurance-test", scheduleType: "daily", defaultColumnId: "todo-today" }),
    }),
  );
  const { routine } = (await created.json()) as { routine: { id: string } };

  // An unrelated task write also runs the same insurance (see
  // app/api/todos/tasks/route.ts's POST) -- this should be a no-op for the
  // routine created above, not a second materialized task for today.
  const taskCreated = await tasksPost(
    new Request("http://x/api/todos/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "unrelated-task", columnId: "todo-inbox" }),
    }),
  );
  expect(taskCreated.status).toBe(201);

  const board = await boardGet(new Request("http://x/api/todos/board"));
  const { tasks } = (await board.json()) as { tasks: Array<{ routineId: string | null }> };
  expect(tasks.filter((task) => task.routineId === routine.id)).toHaveLength(1);
});

test("reactivating a paused routine self-heals today's board immediately", async () => {
  // Inserted as already-paused, bypassing POST's insurance entirely, so the
  // only insurance that can produce today's task is the PATCH active=true
  // branch under test here.
  const id = await insertRoutineDirectly({ active: 0 });
  const routine = await env.DB.prepare("SELECT * FROM todo_routines WHERE id=?").bind(id).first<{ version: number }>();

  const patched = await routinesPatch(
    new Request(`http://x/api/todos/routines/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: true, version: routine!.version }),
    }),
    { params: Promise.resolve({ id }) },
  );
  expect(patched.status).toBe(200);

  const board = await boardGet(new Request("http://x/api/todos/board"));
  const { tasks } = (await board.json()) as { tasks: Array<{ routineId: string | null }> };
  expect(tasks.some((task) => task.routineId === id)).toBe(true);
});

test("a weekdays-only routine does not materialize on a day it is not scheduled for, even via insurance", async () => {
  // Every weekday except today (0=Sunday..6=Saturday), so this routine
  // should never show up on today's board regardless of when the suite
  // runs -- a genuine regression here would be routines materializing on
  // days they were not scheduled for.
  const today = new Date().getUTCDay();
  const otherWeekdays = [0, 1, 2, 3, 4, 5, 6].filter((day) => day !== today);

  const created = await routinesPost(
    new Request("http://x/api/todos/routines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "weekdays-routine-materialize-test",
        scheduleType: "weekdays",
        weekdays: otherWeekdays,
        defaultColumnId: "todo-today",
      }),
    }),
  );
  expect(created.status).toBe(201);
  const { routine } = (await created.json()) as { routine: { id: string } };

  const board = await boardGet(new Request("http://x/api/todos/board"));
  const { tasks } = (await board.json()) as { tasks: Array<{ routineId: string | null }> };
  expect(tasks.some((task) => task.routineId === routine.id)).toBe(false);
});
