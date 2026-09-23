"use client";
import { useEffect, useRef } from "react";

/** Schedules a client list reload after `query` changes -- debounced while
 *  the user is typing, immediate when it's cleared -- while skipping exactly
 *  the very first run when the screen was already rendered server-side with
 *  the matching default view, so the client doesn't immediately re-fetch
 *  what the server just sent.
 *
 *  Watch List, TextTube and the TextTube Studio list had each grown their
 *  own copy of this shape (the first two identical; Studio's own copy was
 *  missing the debounce, so it re-fetched on every keystroke) with comments
 *  pointing at each other rather than sharing code. This is that one copy.
 *
 *  `reload` should already be stable across renders that don't need a new
 *  fetch (e.g. wrapped in useCallback) -- see the call sites. */
export function useSearchReload(
  reload: () => void,
  query: string,
  hasInitialData: boolean,
  debounceMs = 180,
) {
  const skippedInitialLoad = useRef(false);
  useEffect(() => {
    if (hasInitialData && !skippedInitialLoad.current) {
      skippedInitialLoad.current = true;
      return;
    }
    const timer = setTimeout(reload, query ? debounceMs : 0);
    return () => clearTimeout(timer);
    // `hasInitialData` intentionally omitted: it is derived from a prop that
    // does not change across the caller's lifetime, so it would never
    // itself need to re-trigger this effect -- only the ref (read, not
    // depended on) actually gates the skip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, query]);
}
