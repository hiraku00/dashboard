/** Turns the UTC date the D1 usage panel reports as "today" into the wall-clock
 *  window it actually covers, in the timezones this dashboard is read from.
 *
 *  D1's free-tier daily counters reset at UTC 00:00, so the panel's "today" is
 *  a UTC day. Read from Bangkok that day starts at 07:00 and from Japan at
 *  09:00, which makes the figure confusing on its own: checking just after the
 *  local morning it looks like nothing has been used, and the collector's
 *  overnight sync appears to have consumed nothing at all -- because it ran
 *  before the boundary and was counted against the previous UTC day. */

export type UsageWindow = { label: string; start: string; end: string; offsetLabel: string };

const ZONES: Array<{ label: string; timeZone: string; offsetLabel: string }> = [
  { label: "日本", timeZone: "Asia/Tokyo", offsetLabel: "UTC+9" },
  { label: "バンコク", timeZone: "Asia/Bangkok", offsetLabel: "UTC+7" },
];

function format(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("month")}/${value("day")} ${value("hour")}:${value("minute")}`;
}

/** `utcDate` is a YYYY-MM-DD string (the UTC day the counters cover). */
export function dailyResetWindows(utcDate: string): UsageWindow[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) return [];
  const start = new Date(`${utcDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return [];
  const end = new Date(start.getTime() + 86_400_000);
  return ZONES.map((zone) => ({
    label: zone.label,
    offsetLabel: zone.offsetLabel,
    start: format(start, zone.timeZone),
    end: format(end, zone.timeZone),
  }));
}
