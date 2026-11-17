import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

// Through the whole built Worker (worker/auth-wrapper.ts -> worker/index.ts), because the two
// protections live at different layers: the Origin check at the entry, the headers on the way out.
const BASE = "http://security-test.example";
const post = (headers: Record<string, string> = {}) =>
  SELF.fetch(`${BASE}/api/items`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

test("a write from another site is refused with 403 and never reaches the route", async () => {
  const response = await post({ origin: "https://evil.example" });
  expect(response.status).toBe(403);
  expect(await response.text()).toBe("Forbidden");
});

test("a write from the same host, or from a caller with no Origin, gets through to the route", async () => {
  // The route's own validation answers (the empty body is not a valid item).
  expect((await post({ origin: BASE })).status).toBe(400);
  expect((await post()).status).toBe(400);
});

test("responses carry the security headers, HTML and API alike", async () => {
  for (const [path, accept] of [["/api/items", "application/json"], ["/no-such-page", "text/html"]] as const) {
    const response = await SELF.fetch(`${BASE}${path}`, { headers: { accept } });
    expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
    expect(response.headers.get("x-frame-options"), path).toBe("DENY");
    expect(response.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
  }
});

test("an HTML page gets a per-request script nonce, and every inline script carries it", async () => {
  const load = async () => {
    const response = await SELF.fetch(`${BASE}/no-such-page`, { headers: { accept: "text/html" } });
    const csp = response.headers.get("content-security-policy") ?? "";
    return { csp, html: await response.text(), nonce: /'nonce-([^']+)'/.exec(csp)?.[1] ?? "" };
  };
  const first = await load();
  const second = await load();
  expect(first.nonce).not.toBe("");
  expect(second.nonce).not.toBe(first.nonce);
  // The script policy is the nonce one: no unsafe-inline for scripts.
  expect(first.csp.split("; ").find((directive) => directive.startsWith("script-src"))).toBe(`script-src 'self' 'nonce-${first.nonce}'`);

  const inline = [...first.html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]).filter((attributes) => !/\bsrc=/.test(attributes));
  expect(inline.length).toBeGreaterThan(0);
  for (const attributes of inline) expect(attributes).toContain(`nonce="${first.nonce}"`);
});

test("a response that is not an HTML page keeps the nonce-less policy", async () => {
  const response = await SELF.fetch(`${BASE}/api/items`, { headers: { accept: "application/json" } });
  expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-inline'");
});
