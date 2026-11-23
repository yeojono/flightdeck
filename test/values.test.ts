// Value cleaning and combining: the rules, the report SQL, the one-off backfill and the Freehub migration.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { suggestWordGroups } from "../src/grouping";
import { INSERT_LINE_ITEMS, INSERT_ORDERS, INSERT_PROPS, makeDayFormatter, parseJsonl } from "../worker/ingest";
import { type ReportRequest, buildReport } from "../worker/report";
import { NORM_VERSION, ensureNormalised, normaliseValue } from "../worker/values";

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(migration("0001_init.sql"));
  db.exec(migration("0002_drop_login_attempts.sql"));
  db.exec(migration("0003_value_grouping.sql"));
  db.exec(`INSERT INTO stores (id, shop, label, client_id, client_secret_enc) VALUES (1, 's', 'Store', 'x', 'x')`);
  db.exec(`INSERT INTO dimension_keys (key, dimension_id) VALUES ('wheel size', 4), ('size', 4)`);
  return db;
}

/** One order per value, each with a single line item carrying that value under the given key. */
function load(db: DatabaseSync, values: Array<[key: string, value: string, qty: number]>) {
  const lines: string[] = [];
  values.forEach(([key, value, qty], i) => {
    const order = `gid://shopify/Order/${i + 1}`;
    lines.push(JSON.stringify({ id: order, createdAt: "2026-05-01T00:00:00Z", currencyCode: "AUD" }));
    lines.push(
      JSON.stringify({ id: `gid://shopify/LineItem/${i + 1}`, __parentId: order, title: "Wheel", quantity: qty, currentQuantity: qty, customAttributes: [{ key, value }] }),
    );
  });
  const p = parseJsonl(lines.join("\n"), makeDayFormatter("UTC"));
  db.prepare(INSERT_ORDERS).run(1, JSON.stringify(p.orders));
  db.prepare(INSERT_LINE_ITEMS).run(1, JSON.stringify(p.lineItems));
  db.prepare(INSERT_PROPS).run(1, JSON.stringify(p.props));
}

function report(db: DatabaseSync, req: ReportRequest) {
  const q = buildReport(req);
  return db.prepare(q.sql).all(...(q.params as any[])) as Array<{ g1: string; units: number }>;
}

// The values from a real Wheel size chart, with made-up quantities.
const SCREENSHOT: Array<[string, string, number]> = [
  ["wheel size", "Mullet Set", 40],
  ["wheel size", '29" Set', 38],
  ["Size", '27.5"', 36],
  ["wheel size", "Mullet", 34],
  ["wheel size", '29"', 32],
  ["size", "29", 30],
  ["wheel size", '27.5" Set', 28],
  ["size", "27.5", 14],
  ["wheel size", "Match my wheelset", 8],
  ["wheel size", "27.5″", 1],
];

describe("normaliseValue", () => {
  it.each([
    ['27.5"', "27.5"],
    ["27.5″", "27.5"],
    ["27.5”", "27.5"],
    ["27.5''", "27.5"],
    ['27.5 "', "27.5"],
    ["29 in", "29"],
    ["29in", "29"],
    ["29 inch", "29"],
    ["29-inch", "29"],
    ["29 Inches Set", "29 Set"],
    ['29" Set', "29 Set"],
    ["Mullet 29 / 27.5", "Mullet 29/27.5"],
    ['"Black"', "Black"],
    ["  Black   Gold ", "Black Gold"],
  ])("%s -> %s", (raw, clean) => expect(normaliseValue(raw)).toBe(clean));

  it("leaves other values alone", () => {
    for (const v of ["Match my wheelset", "29 in black", "Shimano HG", "SRAM XD", "6-bolt", 'Model "X" wheel', "Black/Gold"]) {
      expect(normaliseValue(v)).toBe(v);
    }
  });
});

describe("grouping in reports", () => {
  it("merges spellings of the same value", () => {
    const db = freshDb();
    load(db, SCREENSHOT);
    const rows = report(db, { groupBy: ["dim:4"] });
    expect(Object.fromEntries(rows.map((r) => [r.g1, r.units]))).toEqual({
      "Mullet Set": 40,
      "29 Set": 38,
      "27.5": 36 + 14 + 1,
      Mullet: 34,
      "29": 32 + 30,
      "27.5 Set": 28,
      "Match my wheelset": 8,
    });
    // The original spelling is kept.
    expect((db.prepare(`SELECT value FROM line_item_props WHERE norm = '29 Set'`).get() as any).value).toBe('29" Set');
  });

  it("filters by a value as typed or as cleaned", () => {
    const db = freshDb();
    load(db, SCREENSHOT);
    for (const v of ['29"', "29", "29″"]) {
      const rows = report(db, { groupBy: ["dim:4"], filters: [{ dim: "dim:4", values: [v] }] });
      expect(rows).toEqual([expect.objectContaining({ g1: "29", units: 62 })]);
    }
  });

  it("shows combined values under their label, and filters by it", () => {
    const db = freshDb();
    load(db, SCREENSHOT);
    // What PUT /api/dimensions/4/groups stores for "Combine these" on the “Set” suggestion.
    db.exec(`INSERT INTO value_groups (dimension_id, value, label) VALUES (4, 'mullet set', 'Mullet'), (4, '29 Set', '29'), (4, '27.5 Set', '27.5')`);
    const rows = report(db, { groupBy: ["dim:4"] });
    expect(Object.fromEntries(rows.map((r) => [r.g1, r.units]))).toEqual({ "27.5": 79, "29": 100, Mullet: 74, "Match my wheelset": 8 });
    const mullet = report(db, { groupBy: ["dim:4"], filters: [{ dim: "dim:4", values: ["Mullet"] }] });
    expect(mullet).toEqual([expect.objectContaining({ g1: "Mullet", units: 74 })]);
    // Raw property columns are not affected by an attribute's combined values.
    expect(report(db, { groupBy: ["prop:wheel size"] }).some((r) => r.g1 === "Mullet Set")).toBe(true);
  });
});

/** Just enough of the D1 API over node:sqlite to run ensureNormalised. */
function d1(db: DatabaseSync): D1Database {
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...(args as any[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }),
    run: async () => db.prepare(sql).run(...(args as any[])),
    exec: () => db.prepare(sql).run(...(args as any[])),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (list: any[]) => list.map((s) => s.exec()) } as unknown as D1Database;
}

describe("backfill of existing rows", () => {
  it("cleans values imported before cleaning existed, once", async () => {
    const db = freshDb();
    load(db, SCREENSHOT);
    db.exec("UPDATE line_item_props SET norm = NULL");
    expect(report(db, { groupBy: ["dim:4"] }).length).toBe(10);

    await ensureNormalised(d1(db));
    expect(report(db, { groupBy: ["dim:4"] }).length).toBe(7);
    expect((db.prepare(`SELECT value FROM settings WHERE key = 'value_norm_version'`).get() as any).value).toBe(NORM_VERSION);
    expect((db.prepare(`SELECT COUNT(*) n FROM line_item_props WHERE norm IS NOT NULL`).get() as any).n).toBe(5);

    // Already done: nothing is read again.
    db.exec("UPDATE line_item_props SET norm = NULL");
    await ensureNormalised(d1(db));
    expect((db.prepare(`SELECT COUNT(*) n FROM line_item_props WHERE norm IS NOT NULL`).get() as any).n).toBe(0);
  });
});

describe("Freehub attribute", () => {
  it("maps both freehub and driver keys when upgrading, keeping existing mappings", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(migration("0001_init.sql"));
    db.exec(`INSERT INTO line_item_props (store_id, line_item_id, key, value, order_id) VALUES
      (1, 1, 'driver', 'SRAM XD', 1), (1, 2, 'freehub', 'Shimano HG', 2), (1, 3, 'hub', 'DT 350', 3)`);
    db.exec(`INSERT INTO dimension_keys (key, dimension_id) VALUES ('hub', 2)`);
    db.exec(migration("0003_value_grouping.sql"));
    const freehub = db.prepare(`SELECT id FROM dimensions WHERE name = 'Freehub'`).get() as any;
    expect(db.prepare(`SELECT key, dimension_id FROM dimension_keys ORDER BY key`).all().map((r: any) => ({ ...r }))).toEqual([
      { key: "driver", dimension_id: freehub.id },
      { key: "freehub", dimension_id: freehub.id },
      { key: "hub", dimension_id: 2 },
    ]);
  });

  it("does not add a second Freehub attribute", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(migration("0001_init.sql"));
    db.exec(`INSERT INTO dimensions (name, sort) VALUES ('freehub', 9)`);
    db.exec(migration("0003_value_grouping.sql"));
    expect((db.prepare(`SELECT COUNT(*) n FROM dimensions WHERE name LIKE 'freehub'`).get() as any).n).toBe(1);
  });
});

describe("suggestWordGroups", () => {
  const values = (list: string[], labels: Record<string, string> = {}) => list.map((value) => ({ value, line_items: 1, label: labels[value] ?? null }));

  it("finds a word that separates several pairs", () => {
    const s = suggestWordGroups(values(["Mullet Set", "29 Set", "27.5", "Mullet", "29", "27.5 Set", "Match my wheelset"]));
    expect(s).toEqual([
      {
        word: "Set",
        pairs: [
          { from: "Mullet Set", to: "Mullet" },
          { from: "29 Set", to: "29" },
          { from: "27.5 Set", to: "27.5" },
        ],
      },
    ]);
  });

  it("ignores one-off differences and values already combined", () => {
    expect(suggestWordGroups(values(["Black", "Black Matte", "Red"]))).toEqual([]);
    expect(suggestWordGroups(values(["29 Set", "29", "27.5 Set", "27.5"], { "29 Set": "29" }))).toEqual([]);
  });
});
