/** `Response.json()` is typed `unknown`, so every caller has to say what it
 *  expects. Naming the shape here keeps that in one place instead of spreading
 *  `as any` casts (and the runtime surprises they hide) through the UI. */
export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Every API route in this app reports failures as `{ error: string }`. */
export type ApiError = { error?: string };

/** Reads a non-2xx response's error message defensively, for callers that
 *  cannot just call readJson() after checking `.ok` -- an unhandled
 *  exception on the API side comes back with an empty body, and
 *  `response.json()` on that throws "Unexpected end of JSON input" instead
 *  of a usable message. `.catch(() => null)` absorbs that so the caller's
 *  own fallback message stays in charge instead of the raw parser error
 *  leaking to the user. See PR #70 for the original incident this guards
 *  against, and app/todo-app.tsx for a case where it was missed. */
export async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as ApiError | null;
  return body?.error || fallback;
}
