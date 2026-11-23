import type { Context, Next } from "hono";
import { peekAccessJwt, verifyAccessJwt } from "./access";
import type { Env } from "./env";

// Sign-in is done by Cloudflare Access in front of the Worker. Every /api/* request must have
// come through Access; anything else gets a 401, so the API stays closed if Access is ever off.

type Ctx = Context<{ Bindings: Env }>;

interface Identity {
  email: string | null;
}

/**
 * Returns who is signed in, or null if the request did not come through Cloudflare Access.
 *
 * 1. ctx.access, set by the runtime when Access authenticated the request. Cloudflare does not
 *    pass it to Workers that serve static assets (like this one), so in practice it is usually
 *    missing; it is checked first in case that changes.
 * 2. The signed JWT Access adds to every request (Cf-Access-Jwt-Assertion), verified against
 *    ACCESS_TEAM_DOMAIN and ACCESS_AUD. This is what normally signs people in.
 */
async function identify(c: Ctx, withEmail: boolean): Promise<Identity | null> {
  const access = (c.executionCtx as ExecutionContext).access;
  if (access) {
    if (!withEmail) return { email: null };
    const id = await access.getIdentity().catch(() => undefined);
    return { email: id?.email ?? null };
  }
  if (c.env.ACCESS_TEAM_DOMAIN && c.env.ACCESS_AUD) {
    const id = await verifyAccessJwt(c.req.header("Cf-Access-Jwt-Assertion"), c.env.ACCESS_TEAM_DOMAIN, c.env.ACCESS_AUD);
    return id && { email: id.email };
  }
  return null;
}

export function configProblem(env: Env): string | null {
  if (!env.APP_SECRET || env.APP_SECRET.length < 16) return "APP_SECRET is not set (use a random string of at least 16 characters).";
  return null;
}

const NOT_SIGNED_IN = "Not signed in through Cloudflare Access. Reload the page to sign in.";

export async function requireAccess(c: Ctx, next: Next) {
  const problem = configProblem(c.env);
  if (problem) return c.json({ error: `Server is not configured: ${problem}` }, 500);
  if (!(await identify(c, false))) return c.json({ error: NOT_SIGNED_IN }, 401);
  await next();
}

/**
 * When Access is in front of the Worker but ACCESS_TEAM_DOMAIN / ACCESS_AUD are not set, the
 * sign-in screen shows the values from the visitor's own (unverified) token to copy into
 * wrangler.jsonc. This grants nothing: the API stays closed until the values are deployed.
 */
function accessSetupHint(c: Ctx) {
  if (c.env.ACCESS_TEAM_DOMAIN && c.env.ACCESS_AUD) return null;
  return peekAccessJwt(c.req.header("Cf-Access-Jwt-Assertion"));
}

export async function sessionStatus(c: Ctx) {
  const id = await identify(c, true);
  return c.json({
    signedIn: !!id,
    email: id?.email ?? null,
    configError: configProblem(c.env),
    accessSetup: id ? null : accessSetupHint(c),
  });
}
