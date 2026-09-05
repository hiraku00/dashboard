import { WatchListApp, type Item, type Stats } from "../watch-list-app";
import { listItems, watchListStats } from "@/app/lib/queries/watch-list";

const PAGE_SIZE = 10;

// Server Component: fetches the first page of the default (unfiltered) view
// directly from D1 at render time, the same way app/page.tsx does for the
// portal summary -- see app/lib/queries/watch-list.ts for the shared query
// (app/api/items and app/api/stats call the same functions).
export default async function WatchListPage() {
  const initial = await fetchInitial();
  return <WatchListApp initialItems={initial?.items ?? null} initialStats={initial?.stats ?? null} />;
}

async function fetchInitial() {
  // Deliberately not surfaced as an error to WatchListApp on failure: it
  // renders with no initial data, which makes it fall back to fetching
  // /api/items and /api/stats itself on the client, exactly like the
  // pre-RSC page always did. See the matching comment in app/page.tsx for
  // why a transient SSR-side failure is not shown to the user as an error.
  try {
    const [items, stats] = await Promise.all([
      listItems({ limit: PAGE_SIZE, offset: 0 }),
      watchListStats(),
    ]);
    // listItems()/watchListStats() return D1 rows typed as `unknown` per
    // field (see app/lib/watch-list-query.ts) because D1 does not give back
    // typed rows. The client already trusted this same JSON blindly via
    // readJson<T>() at the API boundary (app/lib/json.ts) with no runtime
    // validation; asserting the shape here is the same level of trust, just
    // applied before the JSON round-trip instead of after it.
    return { items: items as unknown as { items: Item[]; pagination?: { total?: number } }, stats: stats as unknown as Stats };
  } catch {
    return null;
  }
}
