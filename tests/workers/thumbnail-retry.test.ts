import { describe, expect, test } from "vitest";
import { fetchPageThumbnail } from "@/app/lib/thumbnail-fetch";

// A page that refuses us "not right now" (403 from NHK's bot filtering, 429, a
// 5xx) is tried again, briefly and a bounded number of times; one that is gone
// (404) or refuses every time is not chased. The mock's flaky.example.org serves
// the page only after N refusals per URL, so the number of attempts a lookup made
// shows in what the NEXT lookup of the same URL gets (see outbound-mocks.ts).

const COVER = "https://flaky.example.org/img/cover.png";
const uniq = () => Math.random().toString(36).slice(2);
const page = (kind: string) => `https://flaky.example.org/${kind}/${uniq()}`;

describe("transient refusals are retried", () => {
  test.each([["once", 403], ["throttled", 429], ["unavailable", 503]])("%s (%i, then fine) yields the image on the retry", async (kind) => {
    expect(await fetchPageThumbnail(page(kind))).toBe(COVER);
  });

  test("two refusals in a row are still overcome (third attempt)", async () => {
    expect(await fetchPageThumbnail(page("twice"))).toBe(COVER);
  });

  test("gives up after three attempts in all -- the fourth belongs to the next lookup", async () => {
    const url = page("thrice");
    expect(await fetchPageThumbnail(url)).toBe(""); // attempts 1-3 are refused
    expect(await fetchPageThumbnail(url)).toBe(COVER); // attempt 4 is the first of this lookup
  });

  test("a page that always refuses ends promptly with no image", async () => {
    const started = Date.now();
    expect(await fetchPageThumbnail(page("always"))).toBe("");
    expect(Date.now() - started).toBeLessThan(3500); // well inside the 4s deadline
  });
});

describe("a page that is gone is not retried", () => {
  test("404 costs exactly one attempt", async () => {
    const url = page("gone");
    expect(await fetchPageThumbnail(url)).toBe(""); // one attempt, refused
    expect(await fetchPageThumbnail(url)).toBe(COVER); // had it retried, this would have been the third request
  });
});
