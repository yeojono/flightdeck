// Value cleaning and combining: the general rules, the report SQL and the Freehub migration.
// What depends on the product (wheelsets, single wheels) is in wheels.test.ts.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { suggestWordGroups } from "../src/grouping";
import { INSERT_LINE_ITEMS, INSERT_ORDERS, INSERT_PROPS, makeDayFormatter, parseJsonl } from "../worker/ingest";
import type { ReportRequest } from "../worker/report";
import { normaliseValue } from "../worker/values";
import { runReport } from "./run-report";

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const m of ["0001_init.sql", "0002_drop_login_attempts.sql", "0003_value_grouping.sql", "0004_wheels.sql"]) db.exec(migration(m));
  db.exec(`INSERT INTO stores (id, shop, label, client_id, client_secret_enc) VALUES (1, 's', 'Store', 'x', 'x')`);
  db.exec(`INSERT INTO dimension_keys (key, dimension_id) VALUES ('hub colour', 3), ('colour', 3)`);
  return db;
}

/** One order per value, each with a single line item carrying that value under the given key. */
function load(db: DatabaseSync, values: Array<[key: string, value: string, qty: number]>) {
  const lines: string[] = [];
  values.forEach(([key, value, qty], i) => {
    const order = `gid://shopify/Order/${i + 1}`;
    lines.push(JSON.stringify({ id: order, createdAt: "2026-05-01T00:00:00Z", currencyCode: "AUD" }));
    lines.push(
      JSON.stringify({ id: `gid://shopify/LineItem/${i + 1}`, __parentId: order, title: "Hub", quantity: qty, currentQuantity: qty, customAttributes: [{ key, value }] }),
    );
  });
  const p = parseJsonl(lines.join("\n"), makeDayFormatter("UTC"));
  db.prepare(INSERT_ORDERS).run(1, JSON.stringify(p.orders), 1);
  db.prepare(INSERT_LINE_ITEMS).run(1, JSON.stringify(p.lineItems));
  db.prepare(INSERT_PROPS).run(1, JSON.stringify(p.props));
}

const report = (db: DatabaseSync, req: ReportRequest) => runReport(db, req).rows as Array<{ g1: string; units: number }>;

const COLOURS: Array<[string, string, number]> = [
  ["Hub Colour", "Black", 40],
  ["hub colour", "black", 5],
  ["Colour", "“Black”", 2],
  ["hub colour", "Black / Silver", 11],
  ["Colour", "Black/Silver", 3],
  ["hub colour", "Matte Black", 7],
  ["hub colour", "Silver", 30],
  ["hub colour", "Matte Silver", 4],
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
  it("merges spellings of the same value and keeps the original", () => {
    const db = freshDb();
    load(db, COLOURS);
    const rows = report(db, { groupBy: ["dim:3"] });
    expect(Object.fromEntries(rows.map((r) => [r.g1, r.units]))).toEqual({ Black: 47, "Black/Silver": 14, "Matte Black": 7, Silver: 30, "Matte Silver": 4 });
    expect((db.prepare(`SELECT value FROM line_item_props WHERE norm = 'Black/Silver'`).get() as any).value).toBe("Black / Silver");
  });

  it("filters by a value as typed or as cleaned", () => {
    const db = freshDb();
    load(db, COLOURS);
    for (const v of ["Black / Silver", "black/silver", "“Black/Silver”"]) {
      const rows = report(db, { groupBy: ["dim:3"], filters: [{ dim: "dim:3", values: [v] }] });
      expect(rows).toEqual([expect.objectContaining({ g1: "Black/Silver", units: 14 })]);
    }
  });

  it("shows combined values under their label, and filters by it", () => {
    const db = freshDb();
    load(db, COLOURS);
    // What PUT /api/dimensions/3/groups stores for "Combine these" on the “Matte” suggestion.
    db.exec(`INSERT INTO value_groups (dimension_id, value, label) VALUES (3, 'matte black', 'Black'), (3, 'Matte Silver', 'Silver')`);
    const rows = report(db, { groupBy: ["dim:3"] });
    expect(Object.fromEntries(rows.map((r) => [r.g1, r.units]))).toEqual({ Black: 54, "Black/Silver": 14, Silver: 34 });
    const black = report(db, { groupBy: ["dim:3"], filters: [{ dim: "dim:3", values: ["Black"] }] });
    expect(black).toEqual([expect.objectContaining({ g1: "Black", units: 54 })]);
    // Raw property columns are not affected by an attribute's combined values.
    expect(report(db, { groupBy: ["prop:hub colour"] }).some((r) => r.g1 === "Matte Black")).toBe(true);
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
    const s = suggestWordGroups(values(["Matte Black", "Silver Matte", "Black", "Silver", "Red", "Match my wheelset"]));
    expect(s).toEqual([
      {
        word: "Matte",
        pairs: [
          { from: "Matte Black", to: "Black" },
          { from: "Silver Matte", to: "Silver" },
        ],
      },
    ]);
  });

  it("ignores one-off differences and values already combined", () => {
    expect(suggestWordGroups(values(["Black", "Black Matte", "Red"]))).toEqual([]);
    expect(suggestWordGroups(values(["Black Matte", "Black", "Red Matte", "Red"], { "Black Matte": "Black" }))).toEqual([]);
  });

  it("never suggests dropping a word that changes what the value is", () => {
    // A 29 set is two wheels; a 29 is one. A Boost hub is not the same hub without it.
    expect(suggestWordGroups(values(["Mullet Set", "29 Set", "27.5", "Mullet", "29", "27.5 Set"]))).toEqual([]);
    expect(suggestWordGroups(values(["110x20 Boost", "110x20", "100x15 Boost", "100x15"]))).toEqual([]);
  });
});
