import { expect, test } from "vitest";

import { isPublicHttpUrl, metaRefreshUrl, pageImageUrl, sameLinkSet, youTubeThumbnailFromLinks, youTubeThumbnailUrl } from "../app/lib/thumbnail.ts";
import { toItem } from "../app/lib/watch-list-query.ts";

// The pure half of the Watch List thumbnail feature. The fetching half (and
// the D1 writes) is in tests/workers/watch-list-thumbnail.test.ts.

test("a YouTube link's thumbnail is derived from the video id", () => {
  expect(youTubeThumbnailUrl("ftcDTWIT6ho")).toBe("https://i.ytimg.com/vi/ftcDTWIT6ho/mqdefault.jpg");
  expect(youTubeThumbnailFromLinks([{ url: "https://example.com/a" }, { url: "https://youtu.be/ftcDTWIT6ho" }])).toBe("https://i.ytimg.com/vi/ftcDTWIT6ho/mqdefault.jpg");
  expect(youTubeThumbnailFromLinks([{ url: "https://example.com/a" }, { url: "https://www.youtube.com/@channel" }])).toBe("");
  expect(youTubeThumbnailFromLinks([])).toBe("");
});

test("only public http(s) hosts on the default port are fetchable", () => {
  expect(isPublicHttpUrl("https://blog.example.org/post?x=1")).toBe(true);
  expect(isPublicHttpUrl("http://blog.example.org/")).toBe(true);
  for (const refused of [
    "http://localhost/", "http://localhost:8787/", "http://127.0.0.1/", "http://192.168.0.1/admin", "http://10.0.0.5/",
    "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://2130706433/", "http://0x7f.1/",
    "http://intranet/", "http://printer.local/", "http://db.internal/", "http://api.example.org:8080/",
    "https://user:pass@example.org/", "ftp://example.org/", "file:///etc/passwd", "javascript:alert(1)", "not a url", "",
  ]) expect(isPublicHttpUrl(refused), refused).toBe(false);
  expect(isPublicHttpUrl(undefined)).toBe(false);
});

test("reads the preview image, preferring og:image:secure_url, then og:image, then twitter:image", () => {
  const page = "https://blog.example.org/a/post";
  expect(pageImageUrl('<meta property="og:image" content="https://cdn.example.org/a.png">', page)).toBe("https://cdn.example.org/a.png");
  expect(pageImageUrl('<meta property="og:image" content="https://cdn.example.org/a.png"><meta property="og:image:secure_url" content="https://cdn.example.org/secure.png">', page)).toBe("https://cdn.example.org/secure.png");
  expect(pageImageUrl('<meta name="twitter:image" content="https://cdn.example.org/t.png">', page)).toBe("https://cdn.example.org/t.png");
  expect(pageImageUrl("<meta content='https://cdn.example.org/q.png' property='og:image'>", page)).toBe("https://cdn.example.org/q.png");
});

test("resolves relative and protocol-relative image URLs against the page", () => {
  const page = "https://blog.example.org/a/post";
  expect(pageImageUrl('<meta property="og:image" content="/img/cover.png">', page)).toBe("https://blog.example.org/img/cover.png");
  expect(pageImageUrl('<meta property="og:image" content="cover.png">', page)).toBe("https://blog.example.org/a/cover.png");
  expect(pageImageUrl('<meta property="og:image" content="//cdn.example.org/c.png">', page)).toBe("https://cdn.example.org/c.png");
  expect(pageImageUrl('<meta property="og:image" content="https://cdn.example.org/a.png?x=1&amp;y=2">', page)).toBe("https://cdn.example.org/a.png?x=1&y=2");
});

test("refuses an image that is not https, and returns '' when there is none", () => {
  const page = "https://blog.example.org/post";
  expect(pageImageUrl('<meta property="og:image" content="http://cdn.example.org/a.png">', page)).toBe("");
  expect(pageImageUrl('<meta property="og:image" content="data:image/png;base64,AAAA">', page)).toBe("");
  expect(pageImageUrl('<meta property="og:image" content="javascript:alert(1)">', page)).toBe("");
  expect(pageImageUrl("<html><head><title>x</title></head></html>", page)).toBe("");
  // A refused first candidate must not stop the search.
  expect(pageImageUrl('<meta property="og:image:secure_url" content="http://cdn.example.org/a.png"><meta property="og:image" content="https://cdn.example.org/ok.png">', page)).toBe("https://cdn.example.org/ok.png");
});

test("sameLinkSet compares link lists in order", () => {
  expect(sameLinkSet(["a", "b"], ["a", "b"])).toBe(true);
  expect(sameLinkSet(["a", "b"], ["b", "a"])).toBe(false);
  expect(sameLinkSet(["a"], ["a", "b"])).toBe(false);
  expect(sameLinkSet([], [])).toBe(true);
});

test("toItem exposes a YouTube link's derived thumbnail over the stored one, else the stored one", () => {
  const link = (url) => ({ id: "l", label: "", url, link_type: "reference", position: 0 });
  expect(toItem({ id: "1", thumbnail_url: "https://cdn.example.org/og.png" }, [link("https://youtu.be/ftcDTWIT6ho")]).thumbnailUrl).toBe("https://i.ytimg.com/vi/ftcDTWIT6ho/mqdefault.jpg");
  expect(toItem({ id: "2", thumbnail_url: "https://cdn.example.org/og.png" }, [link("https://blog.example.org/a")]).thumbnailUrl).toBe("https://cdn.example.org/og.png");
  expect(toItem({ id: "3" }, [link("https://blog.example.org/a")]).thumbnailUrl).toBe("");
  expect(toItem({ id: "4", thumbnail_url: null }, []).thumbnailUrl).toBe("");
});

test("reads a meta refresh target (as t.co serves it), resolving relative URLs", () => {
  const page = "https://t.co/abc";
  expect(metaRefreshUrl('<head><noscript><META http-equiv="refresh" content="0;URL=https://news.web.nhk/newsweb/na/na-k1"></noscript></head>', page)).toBe("https://news.web.nhk/newsweb/na/na-k1");
  expect(metaRefreshUrl("<meta http-equiv='Refresh' content=\"5; url='/next?a=1&amp;b=2'\">", "https://example.org/x/y")).toBe("https://example.org/next?a=1&b=2");
  expect(metaRefreshUrl('<meta http-equiv="refresh" content="0;url=other.html">', "https://example.org/dir/page")).toBe("https://example.org/dir/other.html");
});

test("ignores a meta tag that is not a refresh, or has no target", () => {
  expect(metaRefreshUrl('<meta http-equiv="content-type" content="text/html">', "https://example.org/")).toBe("");
  expect(metaRefreshUrl('<meta http-equiv="refresh" content="30">', "https://example.org/")).toBe("");
  expect(metaRefreshUrl("<html></html>", "https://example.org/")).toBe("");
});
