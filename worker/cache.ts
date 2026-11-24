/**
 * Keeps answers that are expensive to work out, so asking again costs a few row reads instead
 * of another pass over the data.
 *
 * Two counters in the settings table say how fresh an answer has to be:
 *   data_version  goes up whenever orders, line items or their properties are written
 *   view_version  goes up whenever something that changes how they are reported is saved
 *                 (attribute mappings, combined values, store labels, conversion rates)
 * An answer is stored with the counters read before it was worked out and is only served while
 * they still match, so one worked out from older data can never be served as current. A new
 * deploy starts afresh too, because the Worker's version is part of what has to match.
 *
 * Everything here is optional: if the cache table is missing (the migration has not been run
 * yet) or a cache statement fails, the answer is simply worked out every time.
 */

import type { Env } from "./env";

const bump = (key: string) => `INSERT INTO settings (key, value) VALUES ('${key}', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`;
/** Run in the same batch as any write to orders, line items or their properties. */
export const BUMP_DATA = bump("data_version");
/** Run after saving anything else that changes what a report shows. */
export const BUMP_VIEW = bump("view_version");

/** `data` answers depend only on the imported rows; `view` answers also depend on how they are reported. */
export type Scope = "data" | "view";

/** D1 holds at most 2 MB in a row. Longer answers are not kept. */
const MAX_LENGTH = 1_000_000;
const KEEP_DAYS = 2;

/** Returns the answer for `key` as JSON text, working it out with `compute` only if no current one is stored. */
export async function cached(env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }, key: string, scope: Scope, compute: () => Promise<unknown>): Promise<string> {
  let version: string | null = null;
  try {
    const [versions, hit] = await env.DB.batch<{ key?: string; value: string; version?: string }>([
      env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('data_version', 'view_version')"),
      env.DB.prepare("SELECT version, value FROM cache WHERE key = ?").bind(key),
    ]);
    const counter = (name: string) => versions.results.find((r) => r.key === name)?.value ?? "0";
    version = `${env.CF_VERSION_METADATA?.id ?? "dev"}/${counter("data_version")}` + (scope === "view" ? `/${counter("view_version")}` : "");
    if (hit.results[0]?.version === version) return hit.results[0].value;
  } catch {
    // No cache table yet: carry on without one.
  }

  const value = JSON.stringify(await compute());
  if (version !== null && value.length <= MAX_LENGTH) {
    ctx.waitUntil(
      env.DB.prepare("INSERT OR REPLACE INTO cache (key, version, value, created_at) VALUES (?, ?, ?, ?)")
        .bind(key, version, value, Date.now())
        .run()
        .catch(() => {}),
    );
  }
  return value;
}

/** A short, stable name for a request, for use as a cache key. */
export async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Drops answers stored more than two days ago. An out-of-date one is otherwise only replaced when it is asked for again. */
export async function pruneCache(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM cache WHERE created_at < ?")
    .bind(Date.now() - KEEP_DAYS * 86_400_000)
    .run()
    .catch(() => {});
}
