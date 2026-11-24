// Product metafields (ultimate_hub_set, ultimate_rim_set) imported with each line item and used as attributes.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { generateJsonl } from "../scripts/mock-data.mjs";
import { INSERT_LINE_ITEMS, INSERT_ORDERS, INSERT_PROPS, importScope, makeDayFormatter, metafieldText, parseJsonl } from "../worker/ingest";
import type { ReportRequest } from "../worker/report";
import { buildBulkQuery, productMetafields } from "../worker/shopify";
import { runReport } from "./run-report";

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const MIGRATIONS = ["0001_init.sql", "0002_drop_login_attempts.sql", "0003_value_grouping.sql", "0004_wheels.sql", "0005_product_metafields.sql"];
const SETTING = { PRODUCT_METAFIELDS: "custom.ultimate_hub_set, custom.ultimate_rim_set" };
const day = makeDayFormatter("UTC");

describe("the PRODUCT_METAFIELDS setting", () => {
  it("reads namespace.key pairs, with custom as the default namespace", () => {
    expect(productMetafields(SETTING)).toEqual([
      { namespace: "custom", key: "ultimate_hub_set" },
      { namespace: "custom", key: "ultimate_rim_set" },
    ]);
    expect(productMetafields({ PRODUCT_METAFIELDS: "ultimate_hub_set,specs.rim" })).toEqual([
      { namespace: "custom", key: "ultimate_hub_set" },
      { namespace: "specs", key: "rim" },
    ]);
  });

  it("ignores blanks, repeats and anything that could break the query", () => {
    expect(productMetafields({})).toEqual([]);
    expect(productMetafields({ PRODUCT_METAFIELDS: " , " })).toEqual([]);
    expect(productMetafields({ PRODUCT_METAFIELDS: `custom.a, custom.a, custom.b") { id } x: metafield(key: "c` })).toEqual([{ namespace: "custom", key: "a" }]);
  });

  it("re-imports stores in full when it changes, and leaves them alone when it is unset", () => {
    const before = importScope({ ORDER_TAG: "wheels" });
    expect(before).toBe("tag:wheels|rules:2");
    expect(importScope({ ORDER_TAG: "wheels", ...SETTING })).not.toBe(before);
    expect(importScope({ ORDER_TAG: "wheels", PRODUCT_METAFIELDS: "custom.ultimate_hub_set" })).not.toBe(importScope({ ORDER_TAG: "wheels", ...SETTING }));
  });
});

describe("the export query", () => {
  it("asks for each metafield on the line item's product", () => {
    const q = buildBulkQuery({ since: null, withProducts: true, metafields: productMetafields(SETTING) });
    expect(q).toContain(
      `product { id productType mf0: metafield(namespace: "custom", key: "ultimate_hub_set") { value } mf1: metafield(namespace: "custom", key: "ultimate_rim_set") { value } }`,
    );
  });

  it("asks for no metafields without the products scope or the setting", () => {
    expect(buildBulkQuery({ since: null, withProducts: false, metafields: productMetafields(SETTING) })).not.toContain("metafield");
    expect(buildBulkQuery({ since: null, withProducts: true })).toContain("product { id productType }");
  });
});

describe("reading metafields from the export", () => {
  const order = { id: "gid://shopify/Order/1", createdAt: "2026-05-01T00:00:00Z" };
  const line = (n: number, product: unknown, customAttributes: unknown[] = []) =>
    JSON.stringify({ id: `gid://shopify/LineItem/${n}`, __parentId: order.id, title: "Wheelset", quantity: 1, currentQuantity: 1, product, customAttributes });
  const props = (lines: string[]) =>
    parseJsonl([JSON.stringify(order), ...lines].join("\n"), day, { metafields: productMetafields(SETTING) }).props.map(([id, key, value]) => [id, key, value]);

  it("stores each metafield like a line item property, under its key", () => {
    const p = props([line(1, { id: "gid://shopify/Product/9", mf0: { value: " Clockwork  Hubs " }, mf1: { value: "Origin Black Rim Set" } })]);
    expect(p).toEqual([
      [1, "ultimate_hub_set", "Clockwork Hubs"],
      [1, "ultimate_rim_set", "Origin Black Rim Set"],
    ]);
  });

  it("skips metafields the product does not have, and line items with no product", () => {
    expect(props([line(1, { id: "gid://shopify/Product/9", mf0: null, mf1: { value: "" } }), line(2, null)])).toEqual([]);
  });

  it("keeps a property typed on the line item over the product's metafield", () => {
    const p = props([line(1, { mf0: { value: "From product" } }, [{ key: "Ultimate_Hub_Set", value: "From line item" }])]);
    expect(p).toEqual([[1, "ultimate_hub_set", "From line item"]]);
  });

  it("joins a list metafield into one value", () => {
    expect(metafieldText('["Clockwork Hubs","Yama Hubs"]')).toBe("Clockwork Hubs, Yama Hubs");
    expect(metafieldText("[Not JSON] Hubs")).toBe("[Not JSON] Hubs");
    expect(metafieldText(null)).toBe("");
  });

  it("ignores metafields when the export did not ask for them", () => {
    const p = parseJsonl([JSON.stringify(order), line(1, { mf0: { value: "Clockwork Hubs" } })].join("\n"), day);
    expect(p.props).toEqual([]);
  });
});

describe("Hub set and Rim set attributes", () => {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(migration(m));
  db.exec(`INSERT INTO stores (id, shop, label, client_id, client_secret_enc) VALUES (1, 'au', 'AU store', 'x', 'x')`);
  const file = generateJsonl("mock-au", { orders: 300 });
  const p = parseJsonl(file, day, { metafields: productMetafields(SETTING) });
  db.prepare(INSERT_ORDERS).run(1, JSON.stringify(p.orders), 1);
  db.prepare(INSERT_LINE_ITEMS).run(1, JSON.stringify(p.lineItems));
  db.prepare(INSERT_PROPS).run(1, JSON.stringify(p.props));

  const dimId = (name: string) => (db.prepare("SELECT id FROM dimensions WHERE name = ?").get(name) as { id: number }).id;
  const report = (req: ReportRequest) => runReport(db, req) as { rows: any[]; totals: any };

  // Tally straight from the export: wheelsets carry the metafields, single wheels and add-ons do not.
  const expected = new Map<string, number>();
  const live = new Set<string>();
  for (const l of file.trim().split("\n").map((x) => JSON.parse(x))) {
    if (l.id.includes("/Order/")) {
      if (!l.cancelledAt && !l.test) live.add(l.id);
    } else if (live.has(l.__parentId) && l.product?.mf0) {
      expected.set(l.product.mf0.value, (expected.get(l.product.mf0.value) ?? 0) + l.currentQuantity);
    }
  }

  it("are created by the migration with the metafield keys mapped", () => {
    const keys = db.prepare("SELECT k.key, d.name FROM dimension_keys k JOIN dimensions d ON d.id = k.dimension_id WHERE k.key LIKE 'ultimate%' ORDER BY k.key").all();
    expect(keys).toEqual([
      { key: "ultimate_hub_set", name: "Hub set" },
      { key: "ultimate_rim_set", name: "Rim set" },
    ]);
  });

  it("leaves keys you already mapped alone when the migration runs again", () => {
    const db2 = new DatabaseSync(":memory:");
    for (const m of MIGRATIONS.slice(0, 4)) db2.exec(migration(m));
    db2.exec(`INSERT INTO dimension_keys (key, dimension_id) VALUES ('ultimate_hub_set', 2)`);
    db2.exec(migration("0005_product_metafields.sql"));
    db2.exec(migration("0005_product_metafields.sql"));
    expect(db2.prepare("SELECT dimension_id FROM dimension_keys WHERE key = 'ultimate_hub_set'").get()).toEqual({ dimension_id: 2 });
    expect(db2.prepare("SELECT COUNT(*) AS n FROM dimensions WHERE name IN ('Hub set', 'Rim set')").get()).toEqual({ n: 2 });
  });

  it("group by hub set, counting only line items that have one", () => {
    const { rows } = report({ groupBy: [`dim:${dimId("Hub set")}`], includeCancelled: false });
    expect(Object.fromEntries(rows.map((r) => [r.g1, r.units]))).toEqual(Object.fromEntries(expected));
    expect(rows.length).toBeGreaterThan(1);
  });

  it("filter by hub set and rim set together", () => {
    const [hub] = [...expected.keys()];
    const hubOnly = report({ groupBy: [], filters: [{ dim: `dim:${dimId("Hub set")}`, values: [hub] }] }).totals;
    expect(hubOnly.units).toBe(expected.get(hub));
    const byRim = report({ groupBy: [`dim:${dimId("Rim set")}`], filters: [{ dim: `dim:${dimId("Hub set")}`, values: [hub] }] }).rows;
    expect(byRim.reduce((a, r) => a + r.units, 0)).toBe(expected.get(hub));
    const rim = byRim[0].g1;
    const both = report({
      groupBy: [],
      filters: [
        { dim: `dim:${dimId("Hub set")}`, values: [hub] },
        { dim: `dim:${dimId("Rim set")}`, values: [rim] },
      ],
    }).totals;
    expect(both.units).toBe(byRim[0].units);
    // Every product in the mock that carries the metafields is a wheelset: 2 wheels a unit.
    expect(both.wheels).toBe(both.units * 2);
  });
});
