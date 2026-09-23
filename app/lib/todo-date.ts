/** Pure Asia/Bangkok date math for the To Do board -- no D1, no
 *  "cloudflare:workers" import, so unlike app/lib/todo-lib.ts (which reaches
 *  for `env` at call time) this can also be imported from a client
 *  component. app/todo-app.tsx previously kept its own copy of this under
 *  the name isoDate(), identical except for the name; this is the one copy
 *  both the client and the server share. */
export const TODO_TIMEZONE = "Asia/Bangkok";

export function todoDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: TODO_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
