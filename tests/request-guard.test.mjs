import { describe, expect, test } from "vitest";
import { applySecurityHeaders, contentSecurityPolicy, isCrossSiteWrite, newNonce } from "../app/lib/request-guard.ts";

const request = (method, origin, url = "https://dash.example/api/items") =>
  new Request(url, { method, headers: origin === undefined ? {} : { origin } });

describe("isCrossSiteWrite", () => {
  test("a write from another site is refused, from the same host is not", () => {
    expect(isCrossSiteWrite(request("POST", "https://evil.example"))).toBe(true);
    expect(isCrossSiteWrite(request("DELETE", "https://evil.example"))).toBe(true);
    expect(isCrossSiteWrite(request("PATCH", "https://dash.example"))).toBe(false);
    // The host includes the port, so another port is another site.
    expect(isCrossSiteWrite(request("POST", "http://dash.example:8080", "http://dash.example/api/items"))).toBe(true);
  });

  test("reads and non-browser callers (no Origin) are never refused", () => {
    expect(isCrossSiteWrite(request("GET", "https://evil.example"))).toBe(false);
    expect(isCrossSiteWrite(request("HEAD", "https://evil.example"))).toBe(false);
    expect(isCrossSiteWrite(request("POST", undefined))).toBe(false);
  });

  test("an unreadable Origin (\"null\") on a write is refused", () => {
    expect(isCrossSiteWrite(request("POST", "null"))).toBe(true);
  });
});

test("applySecurityHeaders sets the headers but keeps one the app already set", () => {
  const headers = new Headers({ "x-frame-options": "SAMEORIGIN" });
  applySecurityHeaders(headers);
  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  const csp = headers.get("content-security-policy");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  // No external script origin and no eval.
  expect(csp).toMatch(/script-src 'self' 'unsafe-inline'(;|$)/);
  expect(csp).not.toContain("unsafe-eval");
  expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
});

test("a nonce replaces unsafe-inline for scripts, and each nonce is new", () => {
  const nonce = newNonce();
  expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  expect(newNonce()).not.toBe(nonce);
  const csp = contentSecurityPolicy(nonce);
  expect(csp).toContain(`script-src 'self' 'nonce-${nonce}'`);
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  // The nonce-less policy (API responses) keeps working as before.
  expect(contentSecurityPolicy()).toMatch(/script-src 'self' 'unsafe-inline'(;|$)/);
});
