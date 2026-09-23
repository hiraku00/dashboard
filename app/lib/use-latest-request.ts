"use client";
import { useCallback, useRef } from "react";

/** Tracks which of several overlapping async requests is the most recent, so
 *  a slow response for an older one (e.g. typing "a" pauses just long enough
 *  for its own debounced fetch to start, then "aaaaaaaa" is typed and its
 *  fetch resolves first) cannot overwrite a newer result with a stale one.
 *
 *  Call begin() right before starting a request and keep the id it returns;
 *  before applying that request's result (or clearing a loading flag on its
 *  behalf), check isCurrent(id) -- false means a newer request has since
 *  started and this one's result should be discarded.
 *
 *  Shared by Watch List's and TextTube's list reloads, which each carried
 *  their own copy of this same counter. */
export function useLatestRequest() {
  const latestRequest = useRef(0);
  const begin = useCallback(() => ++latestRequest.current, []);
  const isCurrent = useCallback(
    (requestId: number) => requestId === latestRequest.current,
    [],
  );
  return { begin, isCurrent };
}
