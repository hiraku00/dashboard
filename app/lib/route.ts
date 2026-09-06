/** Wraps an app/api/**\/route.ts handler so an unhandled exception inside it
 *  always produces a well-formed `{ error }` JSON response, instead of the
 *  framework's own empty-body 500 -- the root cause behind the class of bug
 *  PR #70 and PR #73 each fixed a batch of client-side symptoms of (see
 *  Issue #77). Client code that forgets to guard against an empty error
 *  body (as several call sites did) still gets a parseable body from a
 *  wrapped route, so this is defense in depth on top of, not a replacement
 *  for, fixing those call sites.
 *
 *  Every exported handler in an app/api/**\/route.ts file should be wrapped
 *  with this: `export const GET = route(async (request) => { ... });`
 *  rather than `export async function GET(request) { ... }`. */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      console.error(error);
      return Response.json({ error: "サーバー側で問題が発生しました。" }, { status: 500 });
    }
  };
}
