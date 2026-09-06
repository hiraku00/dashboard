import { expect, test } from "vitest";
import { webcrypto } from "node:crypto";

import {
  guardRequest,
  isAccessConfigured,
  readAssertion,
  readConfig,
  verifyAccessJwt,
} from "../app/lib/access.ts";

// The module verifies with WebCrypto and fetches the JWKS over the network.
// Both are stubbed here so these are real signature checks against a key pair
// generated in-process, not assertions about the shape of the source.
globalThis.crypto ??= webcrypto;

const TEAM = "example.cloudflareaccess.com";
const AUD = "aud-tag-under-test";
const KID = "test-key-id";

const keyPair = await webcrypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = { ...(await webcrypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: KID, alg: "RS256", use: "sig" };

const base64Url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encodeJson = (value) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

async function makeJwt(payload, { kid = KID, alg = "RS256", signer = keyPair.privateKey } = {}) {
  const head = encodeJson({ alg, kid, typ: "JWT" });
  const body = encodeJson(payload);
  const signature = await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signer,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${base64Url(new Uint8Array(signature))}`;
}

const validPayload = (overrides = {}) => ({
  iss: `https://${TEAM}`,
  aud: [AUD],
  exp: Math.floor(Date.now() / 1000) + 3600,
  nbf: Math.floor(Date.now() / 1000) - 60,
  email: "someone@example.com",
  sub: "user-1",
  ...overrides,
});

let jwksRequests = 0;
globalThis.fetch = async (url) => {
  jwksRequests += 1;
  if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) {
    return new Response("not found", { status: 404 });
  }
  return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
};

const config = { teamDomain: TEAM, audience: AUD };

test("readConfig requires both values and normalises the team domain", () => {
  expect(readConfig({})).toBe(null);
  expect(readConfig({ ACCESS_TEAM_DOMAIN: TEAM })).toBe(null);
  expect(readConfig({ ACCESS_AUD: AUD })).toBe(null);
  expect(readConfig({ ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, ACCESS_AUD: AUD })).toEqual(config);
  expect(isAccessConfigured({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD })).toBe(true);
  expect(isAccessConfigured({})).toBe(false);
});

test("readAssertion prefers the header and falls back to the cookie", () => {
  expect(readAssertion(new Request("https://x/", { headers: { "cf-access-jwt-assertion": " tok " } }))).toBe("tok");
  expect(readAssertion(new Request("https://x/", { headers: { cookie: "a=1; CF_Authorization=tok2; b=2" } }))).toBe("tok2");
  expect(readAssertion(new Request("https://x/"))).toBe("");
  // A cookie whose name merely ends with the same suffix must not match.
  expect(readAssertion(new Request("https://x/", { headers: { cookie: "NOT_CF_Authorization=nope" } }))).toBe("");
});

test("accepts a correctly signed assertion and reports the identity", async () => {
  const identity = await verifyAccessJwt(await makeJwt(validPayload()), config);
  expect(identity?.email).toBe("someone@example.com");
  expect(identity?.subject).toBe("user-1");
});

test("accepts a service-token assertion", async () => {
  const identity = await verifyAccessJwt(
    await makeJwt(validPayload({ email: undefined, common_name: "collector-token" })),
    config,
  );
  expect(identity?.commonName).toBe("collector-token");
});

test("rejects an assertion for a different Access application", async () => {
  expect(await verifyAccessJwt(await makeJwt(validPayload({ aud: ["other-app"] })), config)).toBe(null);
});

test("rejects an assertion from a different team domain", async () => {
  expect(await verifyAccessJwt(await makeJwt(validPayload({ iss: "https://attacker.cloudflareaccess.com" })), config)).toBe(null);
});

test("rejects expired and not-yet-valid assertions", async () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  expect(await verifyAccessJwt(await makeJwt(validPayload({ exp: past })), config)).toBe(null);
  const future = Math.floor(Date.now() / 1000) + 600;
  expect(await verifyAccessJwt(await makeJwt(validPayload({ nbf: future })), config)).toBe(null);
});

test("rejects a token signed by a key that is not in the JWKS", async () => {
  const other = await webcrypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  // Same kid, so it resolves a key -- but the signature will not verify.
  expect(await verifyAccessJwt(await makeJwt(validPayload(), { signer: other.privateKey }), config)).toBe(null);
  // Unknown kid resolves nothing.
  expect(await verifyAccessJwt(await makeJwt(validPayload(), { kid: "unknown" }), config)).toBe(null);
});

test("rejects a tampered payload", async () => {
  const token = await makeJwt(validPayload());
  const [head, , signature] = token.split(".");
  const forged = `${head}.${encodeJson(validPayload({ email: "attacker@example.com" }))}.${signature}`;
  expect(await verifyAccessJwt(forged, config)).toBe(null);
});

test("rejects alg=none and malformed tokens", async () => {
  expect(await verifyAccessJwt(await makeJwt(validPayload(), { alg: "none" }), config)).toBe(null);
  expect(await verifyAccessJwt("not.a.jwt", config)).toBe(null);
  expect(await verifyAccessJwt("onlyonepart", config)).toBe(null);
  expect(await verifyAccessJwt("", config)).toBe(null);
});

test("guardRequest is a no-op until both settings are present", async () => {
  const request = new Request("https://x/api/items");
  expect(await guardRequest(request, {})).toBe(null);
  expect(await guardRequest(request, { ACCESS_TEAM_DOMAIN: TEAM })).toBe(null);
});

test("guardRequest denies an unauthenticated request once configured", async () => {
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  const denied = await guardRequest(new Request("https://x/api/manage-asset/state"), env);
  expect(denied?.status).toBe(403);
});

test("guardRequest allows a valid assertion once configured", async () => {
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  const request = new Request("https://x/api/manage-asset/state", {
    headers: { "cf-access-jwt-assertion": await makeJwt(validPayload()) },
  });
  expect(await guardRequest(request, env)).toBe(null);
});

test("guardRequest fails closed when the JWKS cannot be fetched", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const request = new Request("https://x/", {
      // A kid the cache does not hold, forcing a JWKS fetch.
      headers: { "cf-access-jwt-assertion": await makeJwt(validPayload(), { kid: "rotated" }) },
    });
    const response = await guardRequest(request, { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
    expect(response?.status).toBe(503);
  } finally {
    globalThis.fetch = saved;
  }
});

test("caches the JWKS instead of fetching it per request", async () => {
  const before = jwksRequests;
  const token = await makeJwt(validPayload());
  await verifyAccessJwt(token, config);
  await verifyAccessJwt(token, config);
  await verifyAccessJwt(token, config);
  expect(jwksRequests - before <= 1, `expected at most one JWKS fetch, saw ${jwksRequests - before}`).toBeTruthy();
});
