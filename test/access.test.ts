// Checks the fallback Cloudflare Access JWT verification against tokens signed with a local key.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearAccessKeyCache, teamOrigin, verifyAccessJwt } from "../worker/access";

const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";
const KID = "key-1";

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString("base64url");

let keys: CryptoKeyPair;
let otherKeys: CryptoKeyPair;

async function sign(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: CryptoKey } = {}) {
  const header = b64url(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? keys.privateKey, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
}

const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ aud: [AUD], iss: `https://${TEAM}`, email: "me@example.com", exp: now() + 600, nbf: now() - 10 });

beforeAll(async () => {
  const alg = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  keys = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
  otherKeys = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessKeyCache();
});

async function stubCerts() {
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const fetchMock = vi.fn(async (url: string) => {
    expect(url).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    return Response.json({ keys: [{ kid: KID, kty: "RSA", alg: "RS256", n: jwk.n, e: jwk.e }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Cloudflare Access JWT", () => {
  it("normalises the team domain", () => {
    expect(teamOrigin("myteam")).toBe("https://myteam.cloudflareaccess.com");
    expect(teamOrigin("https://MyTeam.cloudflareaccess.com/")).toBe("https://myteam.cloudflareaccess.com");
  });

  it("accepts a valid token and caches the keys", async () => {
    const fetchMock = await stubCerts();
    expect(await verifyAccessJwt(await sign(good()), TEAM, AUD)).toEqual({ email: "me@example.com" });
    expect(await verifyAccessJwt(await sign({ ...good(), aud: AUD }), "myteam", AUD)).toEqual({ email: "me@example.com" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects missing, malformed, forged and mismatched tokens", async () => {
    await stubCerts();
    expect(await verifyAccessJwt(undefined, TEAM, AUD)).toBeNull();
    expect(await verifyAccessJwt("not.a.jwt", TEAM, AUD)).toBeNull();
    expect(await verifyAccessJwt(await sign(good(), { key: otherKeys.privateKey }), TEAM, AUD)).toBeNull();
    expect(await verifyAccessJwt(await sign(good(), { alg: "HS256" }), TEAM, AUD)).toBeNull();
    expect(await verifyAccessJwt(await sign(good(), { kid: "unknown" }), TEAM, AUD)).toBeNull();
    expect(await verifyAccessJwt(await sign({ ...good(), aud: ["someone-else"] }), TEAM, AUD)).toBeNull();
    expect(await verifyAccessJwt(await sign({ ...good(), iss: "https://evil.cloudflareaccess.com" }), TEAM, AUD)).toBeNull();
    expect(await verifyAccessJwt(await sign({ ...good(), exp: now() - 3600 }), TEAM, AUD)).toBeNull();
    expect(await verifyAccessJwt(await sign({ ...good(), nbf: now() + 3600 }), TEAM, AUD)).toBeNull();
    expect(await verifyAccessJwt(await sign({ ...good(), email: undefined }), TEAM, AUD)).toBeNull();
  });

  it("tampering with the claims breaks the signature", async () => {
    await stubCerts();
    const [h, , s] = (await sign(good())).split(".");
    const forged = `${h}.${b64url(JSON.stringify({ ...good(), email: "attacker@example.com" }))}.${s}`;
    expect(await verifyAccessJwt(forged, TEAM, AUD)).toBeNull();
  });
});
