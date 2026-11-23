// Verifies the JWT that Cloudflare Access adds to every request it lets through
// (the Cf-Access-Jwt-Assertion header). Access does the sign-in; this check makes sure
// a request really came through Access for this app, so the API stays closed even if
// the Worker is reached some other way (a preview URL, a new domain, Access turned off).

export interface AccessIdentity {
  /** The signed-in user's email, or a service token's client id. */
  email: string;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

const KEYS_TTL_MS = 60 * 60 * 1000;
const REFETCH_MIN_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;

const te = new TextEncoder();
let keyCache: { url: string; keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

/** Accepts "myteam", "myteam.cloudflareaccess.com" or "https://myteam.cloudflareaccess.com/". */
export function teamOrigin(teamDomain: string): string {
  let host = teamDomain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!host.includes(".")) host += ".cloudflareaccess.com";
  return `https://${host.toLowerCase()}`;
}

function b64urlBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): any {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

async function loadKeys(url: string, force: boolean): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (keyCache && keyCache.url === url) {
    const age = now - keyCache.fetchedAt;
    if (age < KEYS_TTL_MS && (!force || age < REFETCH_MIN_MS)) return keyCache.keys;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch Cloudflare Access signing keys (${res.status}) from ${url}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  keyCache = { url, keys, fetchedAt: now };
  return keys;
}

/** Test hook: forget cached signing keys. */
export function clearAccessKeyCache() {
  keyCache = null;
}

/**
 * Reads the team domain and AUD tag from an Access token WITHOUT checking its signature.
 * Only for the setup screen: when ACCESS_TEAM_DOMAIN and ACCESS_AUD are not set yet, this shows
 * the values the visitor's own token carries, so they can copy them into wrangler.jsonc.
 * Never use it to decide whether someone is signed in.
 */
export function peekAccessJwt(token: string | undefined | null): { teamDomain: string; aud: string } | null {
  const parts = token?.split(".");
  if (!parts || parts.length !== 3) return null;
  try {
    const claims = b64urlJson(parts[1]) as { aud?: unknown; iss?: unknown };
    const aud = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
    if (typeof claims.iss !== "string" || typeof aud !== "string") return null;
    return { teamDomain: claims.iss.replace(/^https?:\/\//, "").replace(/\/.*$/, ""), aud };
  } catch {
    return null;
  }
}

/**
 * Returns who the request belongs to, or null if the token is missing, forged, expired,
 * or was issued for a different Access application or team.
 */
export async function verifyAccessJwt(token: string | undefined | null, teamDomain: string, aud: string): Promise<AccessIdentity | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header: { alg?: string; kid?: string };
  let claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string; common_name?: string };
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  const origin = teamOrigin(teamDomain);
  const certsUrl = `${origin}/cdn-cgi/access/certs`;
  let key = (await loadKeys(certsUrl, false)).get(header.kid);
  // Access rotates its keys; an unknown kid may just mean our copy is stale.
  if (!key) key = (await loadKeys(certsUrl, true)).get(header.kid);
  if (!key) return null;

  let sigOk = false;
  try {
    sigOk = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), te.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return null;
  }
  if (!sigOk) return null;

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(aud.trim())) return null;
  if (claims.iss !== origin) return null;
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now) return null;
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > now) return null;

  const email = claims.email ?? claims.common_name;
  if (!email) return null;
  return { email };
}
