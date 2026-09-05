import { PortalHome } from "./portal-home";
import { portalSummary, type PortalSummary } from "@/app/lib/queries/portal";

// Server Component: fetches the portal summary directly from D1 at render
// time so the initial HTML already has real numbers in it, instead of
// shipping an empty shell and having the client fetch /api/portal/summary
// after hydration. See app/lib/queries/portal.ts for the shared query (the
// API route at app/api/portal/summary/route.ts calls the same function).
export default async function Home() {
  const initial = await fetchInitialSummary();
  return <PortalHome initial={initial} />;
}

async function fetchInitialSummary(): Promise<PortalSummary | null> {
  // Deliberately not surfaced as an error to PortalHome on failure: it
  // renders with no initial data, which makes it fall back to fetching
  // /api/portal/summary itself on the client, exactly like the pre-RSC page
  // always did. A transient failure during SSR (e.g. a momentary D1 hiccup)
  // may well succeed on the client's own retry a moment later, and forcing
  // the client to show a server-side failure it never itself observed would
  // be a regression from "the page just works a beat later." Kept as its own
  // function (rather than a try/catch around the JSX below) because eslint's
  // react-hooks rules flag constructing JSX inside try/catch -- React defers
  // rendering, so such a catch would not actually catch a rendering error
  // anyway; the only thing that can throw here is the D1 call itself.
  try {
    return await portalSummary();
  } catch {
    return null;
  }
}
