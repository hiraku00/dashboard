const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const youtubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

/** Extracts the 11-character video id from a YouTube URL, or "" if the value
 *  is not one. Handles watch/shorts/embed/live paths and youtu.be short links.
 *
 *  The two youtube-preview routes each had their own copy of this. They are
 *  otherwise genuinely different endpoints -- /api/watch-list scrapes the
 *  public page, /api/text-tube uses the YouTube Data API plus a transcript
 *  provider -- but the id parsing was the same job done twice, and the copies
 *  had drifted: the text-tube one skipped the protocol check (so a
 *  javascript:/file: URL could reach the fetch), missed www.youtu.be, and read
 *  youtu.be ids with pathname.slice(1), which breaks on a trailing slash.
 *  This is the stricter watch-list behaviour; nothing the looser copy accepted
 *  legitimately stops working. */
export function youTubeVideoId(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "";
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  const host = url.hostname.toLowerCase();
  let id = "";
  if (host === "youtu.be" || host === "www.youtu.be") id = url.pathname.split("/").filter(Boolean)[0] ?? "";
  if (youtubeHosts.has(host)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v") ?? "";
    else id = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/)?.[1] ?? "";
  }
  return videoIdPattern.test(id) ? id : "";
}
