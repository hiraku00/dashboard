import { beforeAll, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { GET as boardGet } from "@/app/api/todos/board/route";
import { POST as routinesPost } from "@/app/api/todos/routines/route";

// Replaces tests/rendered-html.test.mjs's "ships the To Do board,
// recurring-task API, and portal navigation" (Issue #94, part of Issue #80's
// original Stage 4 scope). That test only grepped source files for
// `materializeRoutines`, `schedule_type`, and the UNIQUE(routine_id,
// occurrence_date) constraint in migrations/0003_todo.sql -- it never
// actually created a routine or confirmed one materializes into a task.
// This does, against a real D1, the same way tests/workers/items-route.test.ts
// covers Issues #75/#76.

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

test("a daily routine materializes into today's board exactly once, even if the board is fetched twice", async () => {
  const created = await routinesPost(
    new Request("http://x/api/todos/routines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "daily-routine-materialize-test", scheduleType: "daily", defaultColumnId: "todo-today" }),
    }),
  );
  expect(created.status).toBe(201);
  const { routine } = (await created.json()) as { routine: { id: string } };

  // GET /api/todos/board is what calls materializeRoutines() for the
  // requested date (see app/api/todos/board/route.ts) -- fetched twice to
  // also confirm the UNIQUE(routine_id, occurrence_date) constraint
  // (migrations/0003_todo.sql) means a second materialization is a no-op,
  // not a duplicate task.
  const first = await boardGet(new Request("http://x/api/todos/board"));
  const second = await boardGet(new Request("http://x/api/todos/board"));
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);

  const { tasks } = (await second.json()) as { tasks: Array<{ routineId: string | null; title: string; columnId: string }> };
  const materialized = tasks.filter((task) => task.routineId === routine.id);
  expect(materialized).toHaveLength(1);
  expect(materialized[0].title).toBe("daily-routine-materialize-test");
  expect(materialized[0].columnId).toBe("todo-today");
});

test("a weekdays-only routine does not materialize on a day it is not scheduled for", async () => {
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
