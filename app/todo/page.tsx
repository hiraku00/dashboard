import { TodoApp, type Column, type Routine, type Task } from "../todo-app";
import { boardSnapshot, listRoutines } from "@/app/lib/queries/todo";
import { todoDate } from "@/app/api/todos/_lib";

// Server Component: fetches today's board directly from D1 at render time,
// the same way app/watch-list/page.tsx does (see app/lib/queries/todo.ts
// for the shared query). Issue #71 -- this could not be done safely before
// GET /api/todos/board stopped writing to D1 on every read (see that
// route's own comment): Next.js's <Link> prefetching or a re-render could
// otherwise have triggered materializeRoutines() an unbounded number of
// times just from rendering this page.
export default async function TodoPage() {
  const date = todoDate();
  const initial = await fetchInitial(date);
  return (
    <TodoApp
      initialDate={date}
      initialColumns={initial?.columns ?? null}
      initialTasks={initial?.tasks ?? null}
      initialRoutines={initial?.routines ?? null}
    />
  );
}

async function fetchInitial(date: string) {
  // Deliberately not surfaced as an error to TodoApp on failure: it renders
  // with no initial data, which makes it fall back to fetching
  // /api/todos/board and /api/todos/routines itself on the client, exactly
  // like the pre-RSC page always did. See the matching comment in
  // app/watch-list/page.tsx for why a transient SSR-side failure is not
  // shown to the user as an error.
  try {
    const [board, routines] = await Promise.all([boardSnapshot(date), listRoutines()]);
    // board.columns/board.tasks/routines are D1 rows typed as `unknown` per
    // field (see app/lib/queries/todo.ts) because D1 does not give back
    // typed rows. The client already trusted this same JSON blindly via
    // readJson<T>() at the API boundary (app/lib/json.ts) with no runtime
    // validation; asserting the shape here is the same level of trust, just
    // applied before the JSON round-trip instead of after it.
    return {
      columns: board.columns as unknown as Column[],
      tasks: board.tasks as unknown as Task[],
      routines: routines as unknown as Routine[],
    };
  } catch {
    return null;
  }
}
