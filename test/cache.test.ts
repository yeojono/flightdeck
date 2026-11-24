// Checks that cached answers are reused, and never served once the data or the mappings have changed.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { BUMP_DATA, BUMP_VIEW, cached, digest, pruneCache } from "../worker/cache";

/** Just enough of a D1 binding, on an in-memory SQLite database. */
function fakeD1(db: DatabaseSync) {
  const statement = (sql: string, params: any[] = []): any => ({
    sql,
    params,
    bind: (...p: any[]) => statement(sql, p),
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => ({ results: db.prepare(sql).all(...params) }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: any[]) => stmts.map((s) => ({ results: db.prepare(s.sql).all(...s.params) })),
  };
}

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

let db: DatabaseSync;
let env: any;
let writes: Promise<unknown>[];
const ctx = { waitUntil: (p: Promise<unknown>) => void writes.push(p) };
/** Asks for `key`, counting how often the answer had to be worked out. */
async function ask(key: string, scope: "data" | "view", answer: unknown, calls: { n: number }, during?: () => void) {
  const json = await cached(env, ctx, key, scope, async () => {
    calls.n++;
    during?.();
    return answer;
  });
  await Promise.all(writes.splice(0));
  return JSON.parse(json);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(migration("0001_init.sql"));
  db.exec(migration("0006_cache.sql"));
  env = { DB: fakeD1(db), CF_VERSION_METADATA: { id: "deploy-1" } };
  writes = [];
});

describe("cache", () => {
  it("works an answer out once and then serves the stored one", async () => {
    const calls = { n: 0 };
    expect(await ask("report:a", "view", { rows: [1] }, calls)).toEqual({ rows: [1] });
    expect(await ask("report:a", "view", { rows: [2] }, calls)).toEqual({ rows: [1] });
    expect(calls.n).toBe(1);
    // Another question is not answered with it.
    expect(await ask("report:b", "view", { rows: [3] }, calls)).toEqual({ rows: [3] });
    expect(calls.n).toBe(2);
  });

  it("drops everything when data is imported", async () => {
    const calls = { n: 0 };
    await ask("report:a", "view", "old", calls);
    await ask("stats:orders", "data", "old", calls);
    db.exec(BUMP_DATA);
    expect(await ask("report:a", "view", "new", calls)).toBe("new");
    expect(await ask("stats:orders", "data", "new", calls)).toBe("new");
    expect(calls.n).toBe(4);
  });

  it("drops reports, but not counts of the data, when a mapping is saved", async () => {
    const calls = { n: 0 };
    await ask("report:a", "view", "old", calls);
    await ask("stats:orders", "data", "old", calls);
    db.exec(BUMP_VIEW);
    db.exec(BUMP_VIEW);
    expect(await ask("report:a", "view", "new", calls)).toBe("new");
    expect(await ask("stats:orders", "data", "new", calls)).toBe("old");
    expect(calls.n).toBe(3);
  });

  it("never serves an answer worked out while the data was changing", async () => {
    const calls = { n: 0 };
    // The import lands after the answer's version was read but before it is stored.
    expect(await ask("report:a", "view", "stale", calls, () => db.exec(BUMP_DATA))).toBe("stale");
    expect(await ask("report:a", "view", "fresh", calls)).toBe("fresh");
    expect(await ask("report:a", "view", "unused", calls)).toBe("fresh");
    expect(calls.n).toBe(2);
  });

  it("starts afresh after a deploy", async () => {
    const calls = { n: 0 };
    await ask("report:a", "view", "old code", calls);
    env.CF_VERSION_METADATA = { id: "deploy-2" };
    expect(await ask("report:a", "view", "new code", calls)).toBe("new code");
  });

  it("still answers when the cache table has not been created yet", async () => {
    db.exec("DROP TABLE cache");
    const calls = { n: 0 };
    expect(await ask("report:a", "view", 1, calls)).toBe(1);
    expect(await ask("report:a", "view", 2, calls)).toBe(2);
    await pruneCache(env.DB);
  });

  it("does not keep answers too big for a row, and prunes old ones", async () => {
    const calls = { n: 0 };
    await ask("report:big", "view", "x".repeat(1_000_001), calls);
    await ask("report:big", "view", "x".repeat(1_000_001), calls);
    expect(calls.n).toBe(2);

    await ask("report:a", "view", 1, calls);
    db.prepare("INSERT INTO cache (key, version, value, created_at) VALUES ('report:old', 'v', '1', ?)").run(Date.now() - 3 * 86_400_000);
    await pruneCache(env.DB);
    expect(db.prepare("SELECT key FROM cache ORDER BY key").all()).toEqual([{ key: "report:a" }]);
  });

  it("names the same request the same way", async () => {
    expect(await digest({ a: 1, b: [2] })).toBe(await digest({ a: 1, b: [2] }));
    expect(await digest({ a: 1 })).not.toBe(await digest({ a: 2 }));
    expect(await digest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
