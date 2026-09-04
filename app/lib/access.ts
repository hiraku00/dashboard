/** Verifies the JWT Cloudflare Access attaches to every request it lets
 *  through, so the app itself -- not only the Cloudflare edge -- decides
 *  whether a request is authenticated.
 *
 *  Access is configured per hostname. Anything served on a hostname the Access
 *  application does not cover reaches this Worker with no Access check at all,
 *  and the app had nothing of its own to fall back on. Requiring a valid
 *  assertion here means such a route fails closed instead of serving data.
 *
 *  This is deliberately opt-in: with no team domain and audience configured,
 *  isAccessConfigured() is false and the Worker keeps its previous behaviour.
 *  Turning it on is a production change (a wrong audience locks everyone out,
 *  including the collector's service token), so it is enabled by setting the
 *  two values rather than by deploying this file. */

export type AccessConfig = { teamDomain: string; audience: string };

export type AccessIdentity = {
  /** Set for a human signing in through the Access login page. */
  email?: string;
  /** Set for a service token (the Manage Asset collector uses one). */
  commonName?: string;
  subject?: string;
};

/** Access sends the assertion in this header; the browser session also carries
 *  it as a cookie, which is what a direct navigation arrives with. */
const HEADER = "cf-access-jwt-assertion";
const COOKIE = "CF_Authorization";

export function readConfig(env: Record<string, unknown>): AccessConfig | null {
  const teamDomain = typeof env.ACCESS_TEAM_DOMAIN === "string" ? env.ACCESS_TEAM_DOMAIN.trim() : "";
  const audience = typeof env.ACCESS_AUD === "string" ? env.ACCESS_AUD.trim() : "";
  if (!teamDomain || !audience) return null;
  return { teamDomain: teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, ""), audience };
}

export function isAccessConfigured(env: Record<string, unknown>) {
  return readConfig(env) !== null;
}

export function readAssertion(request: Request) {
  const header = request.headers.get(HEADER);
  if (header) return header.trim();
  const cookie = request.headers.get("cookie") ?? "";
  // Cookie values are base64url JWTs, so no quoting or escaping to unpick.
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return match?.[1]?.trim() ?? "";
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
  } catch {
    return null;
  }
}

type Jwks = { keys: Array<JsonWebKey & { kid?: string; alg?: string }> };

// Access rotates its signing keys, and the JWKS is two keys wide precisely so
// a rotation overlaps. Cache briefly rather than per request, and re-fetch on
// a kid miss so a rotation does not lock everyone out until the TTL expires.
const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCache: { teamDomain: string; fetchedAt: number; keys: Jwks["keys"] } | null = null;

async function fetchJwks(teamDomain: string): Promise<Jwks["keys"]> {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access JWKS fetch failed: ${response.status}`);
  const body = (await response.json()) as Jwks;
  return Array.isArray(body.keys) ? body.keys : [];
}

async function resolveKey(teamDomain: string, kid: string) {
  const fresh = jwksCache && jwksCache.teamDomain === teamDomain && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (fresh) {
    const cached = jwksCache?.keys.find((key) => key.kid === kid);
    if (cached) return cached;
  }
  const keys = await fetchJwks(teamDomain);
  jwksCache = { teamDomain, fetchedAt: Date.now(), keys };
  return keys.find((key) => key.kid === kid) ?? null;
}

/** Returns the caller's identity when the assertion is valid, or null when it
 *  is missing, malformed, expired, signed by an unknown key, or issued for a
 *  different Access application. Never throws for a bad token -- only for an
 *  infrastructure failure it cannot judge (an unreachable JWKS). */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  now = Date.now(),
): Promise<AccessIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = decodeJson(headerSegment);
  const payload = decodeJson(payloadSegment);
  if (!header || !payload) return null;
  if (header.alg !== "RS256") return null;
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid) return null;

  const issuer = `https://${config.teamDomain}`;
  if (payload.iss !== issuer) return null;
  const audience = payload.aud;
  const audiences = Array.isArray(audience) ? audience.map(String) : typeof audience === "string" ? [audience] : [];
  if (!audiences.includes(config.audience)) return null;
  const seconds = Math.floor(now / 1000);
  if (typeof payload.exp === "number" && seconds >= payload.exp) return null;
  if (typeof payload.nbf === "number" && seconds < payload.nbf) return null;

  const jwk = await resolveKey(config.teamDomain, kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    { ...jwk, alg: "RS256", ext: true, key_ops: ["verify"] },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(signatureSegment) as unknown as ArrayBuffer,
    signed as unknown as ArrayBuffer,
  );
  if (!valid) return null;

  return {
    email: typeof payload.email === "string" ? payload.email : undefined,
    commonName: typeof payload.common_name === "string" ? payload.common_name : undefined,
    subject: typeof payload.sub === "string" ? payload.sub : undefined,
  };
}

/** The check the Worker runs on every request. Returns null to allow, or the
 *  Response to return instead. */
export async function guardRequest(
  request: Request,
  env: Record<string, unknown>,
): Promise<Response | null> {
  const config = readConfig(env);
  if (!config) return null;
  const token = readAssertion(request);
  if (!token) return deny();
  let identity: AccessIdentity | null;
  try {
    identity = await verifyAccessJwt(token, config);
  } catch {
    // The JWKS was unreachable, so this request cannot be judged either way.
    // Fail closed: the whole point here is to be the layer that holds when the
    // edge check is absent.
    return new Response("Access verification unavailable", { status: 503 });
  }
  return identity ? null : deny();
}

function deny() {
  return new Response("Forbidden", { status: 403 });
}
