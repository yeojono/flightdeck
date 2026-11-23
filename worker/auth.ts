import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { hmac, safeEqual } from "./crypto";
import type { Env } from "./env";

const COOKIE = "wi_session";
const SESSION_DAYS = 14;
const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;

type Ctx = Context<{ Bindings: Env }>;

async function isValidSession(env: Env, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(env.APP_SECRET, sig, await hmac(env.APP_SECRET, `session:${exp}`));
}

export function configProblem(env: Env): string | null {
  if (!env.APP_SECRET || env.APP_SECRET.length < 16) return "APP_SECRET is not set (use a random string of at least 16 characters).";
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 8) return "ADMIN_PASSWORD is not set (at least 8 characters).";
  return null;
}

export async function requireSession(c: Ctx, next: Next) {
  const problem = configProblem(c.env);
  if (problem) return c.json({ error: `Server is not configured: ${problem}` }, 500);
  if (!(await isValidSession(c.env, getCookie(c, COOKIE)))) return c.json({ error: "Not signed in" }, 401);
  await next();
}

export async function sessionStatus(c: Ctx) {
  const problem = configProblem(c.env);
  if (problem) return c.json({ signedIn: false, configError: problem });
  return c.json({ signedIn: await isValidSession(c.env, getCookie(c, COOKIE)) });
}

export async function login(c: Ctx) {
  const problem = configProblem(c.env);
  if (problem) return c.json({ error: `Server is not configured: ${problem}` }, 500);

  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  const now = Date.now();
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ts > ?").bind(ip, now - WINDOW_MS).first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_FAILURES) return c.json({ error: "Too many attempts. Try again in 15 minutes." }, 429);

  const body = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  const ok = typeof body.password === "string" && (await safeEqual(c.env.APP_SECRET, body.password, c.env.ADMIN_PASSWORD));
  if (!ok) {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO login_attempts (ip, ts) VALUES (?, ?)").bind(ip, now),
      c.env.DB.prepare("DELETE FROM login_attempts WHERE ts < ?").bind(now - WINDOW_MS),
    ]);
    return c.json({ error: "Wrong password" }, 401);
  }

  const exp = now + SESSION_DAYS * 86400 * 1000;
  const token = `${exp}.${await hmac(c.env.APP_SECRET, `session:${exp}`)}`;
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return c.json({ signedIn: true });
}

export function logout(c: Ctx) {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ signedIn: false });
}
