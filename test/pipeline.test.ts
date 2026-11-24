// Runs the real ingest SQL and report SQL against SQLite, using fake Shopify export data.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { generateJsonl } from "../scripts/mock-data.mjs";
import {
  DELETE_ORDER_LINES,
  DELETE_ORDER_PROPS,
  INSERT_LINE_ITEMS,
  INSERT_ORDERS,
  INSERT_PROPS,
  completeLineBytes,
  gidToNumber,
  makeDayFormatter,
  normaliseKey,
  parseJsonl,
} from "../worker/ingest";
import { type ReportRequest, type ReportSpec, finishReports, planReports } from "../worker/report";
import { buildBulkQuery, hasScope, normaliseShop } from "../worker/shopify";
import { normaliseValue } from "../worker/values";
import { suggestWordGroups } from "../src/grouping";
import { runReport } from "./run-report";

const db = new DatabaseSync(":memory:");
const numbered = (sql: string) => sql; // node:sqlite understands ?1 / ?2 like D1 does

function ingest(storeId: number, jsonl: string, tz: string, chunkBytes = 50_000) {
  // Mirror the workflow: walk the file in byte ranges cut at line boundaries.
  const bytes = new TextEncoder().encode(jsonl);
  let offset = 0;
  let orders = 0;
  while (offset < bytes.length) {
    const buf = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
    const usable = completeLineBytes(buf, offset + buf.length >= bytes.length);
    expect(usable).toBeGreaterThan(0);
    const p = parseJsonl(new TextDecoder().decode(buf.subarray(0, usable)), makeDayFormatter(tz));
    const ids = JSON.stringify(p.orderIds);
    db.prepare(numbered(DELETE_ORDER_PROPS)).run(storeId, ids);
    db.prepare(numbered(DELETE_ORDER_LINES)).run(storeId, ids);
    db.prepare(numbered(INSERT_ORDERS)).run(storeId, JSON.stringify(p.orders), 1);
    db.prepare(numbered(INSERT_LINE_ITEMS)).run(storeId, JSON.stringify(p.lineItems));
    db.prepare(numbered(INSERT_PROPS)).run(storeId, JSON.stringify(p.props));
    orders += p.orders.length;
    offset += usable;
  }
  return orders;
}

const report = (req: ReportRequest) => runReport(db, req) as { rows: any[]; totals: any };

const AU = generateJsonl("mock-au", { orders: 400 });
const US = generateJsonl("mock-us", { orders: 300 });

// Independent tally straight from the raw export, to check the SQL against.
function expectedByAttr(jsonl: string, key: string) {
  const live = new Set<string>();
  const out = new Map<string, number>();
  for (const line of jsonl.trim().split("\n")) {
    const o = JSON.parse(line);
    if (o.id.includes("/Order/")) {
      if (!o.cancelledAt && !o.test) live.add(o.id);
    } else if (live.has(o.__parentId)) {
      const v = o.customAttributes.find((a: any) => normaliseKey(a.key) === key)?.value;
      const k = v && normaliseValue(v).toLowerCase();
      if (k) out.set(k, (out.get(k) ?? 0) + o.currentQuantity);
    }
  }
  return out;
}

beforeAll(() => {
  for (const m of ["0001_init.sql", "0002_drop_login_attempts.sql", "0003_value_grouping.sql", "0004_wheels.sql"]) {
    db.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));
  }
  db.exec(`INSERT INTO stores (id, shop, label, client_id, client_secret_enc, currency, fx_rate) VALUES
    (1, 'au', 'AU store', 'x', 'x', 'AUD', 1), (2, 'us', 'US store', 'x', 'x', 'USD', 1.5)`);
  expect(ingest(1, AU, "Australia/Sydney")).toBe(400);
  expect(ingest(2, US, "America/Denver")).toBe(300);
  // Rim = "rim" (AU) + "rim choice" (US); Colour = "hub colour" (AU) + "hub color" (US)
  db.exec(`INSERT OR IGNORE INTO dimension_keys (key, dimension_id) VALUES
    ('rim', 1), ('rim choice', 1), ('hub', 2), ('hub choice', 2), ('hub colour', 3), ('hub color', 3), ('wheel size', 4)`);
});

describe("helpers", () => {
  it("normalises shop domains and rejects anything else", () => {
    expect(normaliseShop("My-Store.myshopify.com")).toBe("my-store");
    expect(normaliseShop("https://my-store.myshopify.com/admin")).toBe("my-store");
    expect(normaliseShop("https://admin.shopify.com/store/my-store/orders")).toBe("my-store");
    expect(normaliseShop("evil.com/x")).toBeNull();
    expect(normaliseShop("a b")).toBeNull();
  });
  it("normalises property keys", () => {
    expect(normaliseKey("  Hub  Color: ")).toBe("hub color");
    expect(gidToNumber("gid://shopify/LineItem/123?x=1")).toBe(123);
  });
  it("computes the order day in the store timezone", () => {
    expect(makeDayFormatter("Australia/Sydney")("2026-01-01T20:00:00Z")).toBe("2026-01-02");
    expect(makeDayFormatter("America/Denver")("2026-01-01T03:00:00Z")).toBe("2025-12-31");
  });
  it("builds the export query", () => {
    expect(hasScope("write_orders,read_products", "orders")).toBe(true);
    expect(hasScope("read_customers", "orders")).toBe(false);
    const q = buildBulkQuery({ since: "2026-11-01T00:00:00Z", withProducts: false });
    expect(q).toContain(`orders(query: "updated_at:>='2026-11-01T00:00:00Z'")`);
    expect(q).toContain("customAttributes { key value }");
    expect(q).not.toContain("productType");
    expect(q).not.toContain("tags");
  });
});

describe("ingest", () => {
  it("loads every order, line item and property exactly once", () => {
    const lines = (AU + US).trim().split("\n").map((l) => JSON.parse(l));
    const items = lines.filter((l) => l.id.includes("/LineItem/"));
    expect((db.prepare("SELECT COUNT(*) n FROM orders").get() as any).n).toBe(700);
    expect((db.prepare("SELECT COUNT(*) n FROM line_items").get() as any).n).toBe(items.length);
    expect((db.prepare("SELECT COUNT(*) n FROM line_item_props").get() as any).n).toBe(items.reduce((a, i) => a + i.customAttributes.length, 0));
  });
  it("re-importing the same data does not duplicate anything", () => {
    const before = db.prepare("SELECT (SELECT COUNT(*) FROM line_items) a, (SELECT COUNT(*) FROM line_item_props) b").get();
    ingest(1, AU, "Australia/Sydney", 7_777);
    expect(db.prepare("SELECT (SELECT COUNT(*) FROM line_items) a, (SELECT COUNT(*) FROM line_item_props) b").get()).toEqual(before);
  });
});

describe("report", () => {
  it("groups by a mapped attribute across stores with differently named keys", () => {
    const expected = new Map(expectedByAttr(AU, "rim"));
    for (const [k, v] of expectedByAttr(US, "rim choice")) expected.set(k, (expected.get(k) ?? 0) + v);
    const { rows } = report({ groupBy: ["dim:1"] });
    expect(rows.length).toBe(expected.size);
    for (const r of rows) expect(r.units).toBe(expected.get(r.g1.toLowerCase()));
    expect(rows[0].units).toBeGreaterThanOrEqual(rows[1].units);
  });

  it("merges values that differ only by case", () => {
    const { rows } = report({ groupBy: ["dim:3"] });
    expect(rows.filter((r) => r.g1.toLowerCase() === "black").length).toBe(1);
  });

  it("filters by country and store, and splits by a second dimension", () => {
    const all = report({ groupBy: ["dim:2"] });
    const au = report({ groupBy: ["dim:2", "province"], filters: [{ dim: "country", values: ["Australia"] }] });
    expect(au.rows.every((r) => r.g2.endsWith(", AU"))).toBe(true);
    expect(au.totals.units).toBeLessThan(all.totals.units);
    expect(au.rows.reduce((a, r) => a + r.units, 0)).toBe(au.totals.units);

    const us = report({ groupBy: ["prop:rim choice"], filters: [{ dim: "store", values: ["US store"] }] });
    const expected = expectedByAttr(US, "rim choice");
    for (const r of us.rows) expect(r.units).toBe(expected.get(r.g1.toLowerCase()));
  });

  it("filters by attribute value and date range", () => {
    const r = report({ groupBy: ["month"], filters: [{ dim: "dim:4", values: ['29" Set'] }], from: "2026-01-01", to: "2026-06-30" });
    expect(r.rows.length).toBe(6);
    expect(r.rows.map((x) => x.g1)).toEqual([...r.rows.map((x) => x.g1)].sort());
    expect(r.rows.every((x) => x.g1 >= "2026-01" && x.g1 <= "2026-06")).toBe(true);
  });

  it("excludes cancelled and test orders unless asked, and applies the conversion rate", () => {
    const base = report({ groupBy: [] }).totals;
    const withCancelled = report({ groupBy: [], includeCancelled: true }).totals;
    expect(withCancelled.orders).toBeGreaterThan(base.orders);
    const us = report({ groupBy: [], filters: [{ dim: "store", values: ["US store"] }] }).totals;
    const raw = db
      .prepare(`SELECT SUM(li.total * li.current_quantity / li.quantity) t FROM line_items li JOIN orders o ON o.store_id = li.store_id AND o.id = li.order_id
                WHERE li.store_id = 2 AND o.test = 0 AND o.cancelled = 0`)
      .get() as any;
    expect(us.revenue).toBeCloseTo(raw.t * 1.5, 1);
  });

  it("can include line items without the attribute", () => {
    const withMissing = report({ groupBy: ["dim:1"], includeMissing: true });
    expect(withMissing.rows.some((r) => r.g1 === "(not set)")).toBe(true);
  });

  it("answers several reports from one read, the same as asking for each alone", () => {
    const base = { from: "2026-01-01", filters: [{ dim: "dim:4", values: ['29" Set', "Mullet Set"] }, { dim: "country", values: ["Australia", "United States"] }] };
    const specs: ReportSpec[] = [
      { groupBy: [] },
      { groupBy: ["month"], limit: 2000 },
      { groupBy: ["wheel_type"] },
      { groupBy: ["dim:1"] },
      { groupBy: ["dim:1"], includeMissing: true },
      { groupBy: ["dim:3", "province"] },
      { groupBy: ["prop:rim choice", "dim:2"], includeMissing: true },
      { groupBy: ["dim:2"], limit: 3 },
    ];
    const plan = planReports(base, specs);
    // One statement reads the line items; the other two are the small mapping tables.
    expect(plan.statements.length).toBe(3);
    expect(planReports({}, [{ groupBy: ["month"] }, { groupBy: ["country"] }]).statements.length).toBe(1);
    const together = finishReports(
      plan,
      plan.statements.map((st) => db.prepare(st.sql).all(...(st.params as any[]))),
    );
    expect(together.length).toBe(specs.length);
    specs.forEach((spec, i) => expect(together[i]).toEqual(runReport(db, { ...base, ...spec })));
    expect(together[0].rows).toEqual([together[0].totals]);
    expect(together[7].rows.length).toBe(3);
  });

  it("counts an order once per group and once in the total", () => {
    const raw = db
      .prepare(`SELECT COUNT(DISTINCT li.store_id || ':' || li.order_id) AS orders, COUNT(*) AS line_items FROM line_items li
                JOIN orders o ON o.store_id = li.store_id AND o.id = li.order_id WHERE o.test = 0 AND o.cancelled = 0`)
      .get() as any;
    const { rows, totals } = report({ groupBy: ["store"] });
    expect(totals).toMatchObject(raw);
    expect(rows.reduce((n, r) => n + r.orders, 0)).toBe(raw.orders);
    // An order with several kinds of product is counted under each of them, but still once overall.
    const byType = report({ groupBy: ["product_type"] });
    expect(byType.totals.orders).toBe(raw.orders);
    expect(byType.rows.reduce((n, r) => n + r.orders, 0)).toBeGreaterThan(raw.orders);
  });

  it("shows a value under its most common spelling", () => {
    const { rows } = report({ groupBy: ["dim:3"] });
    expect(rows.find((r) => r.g1.toLowerCase() === "black").g1).toBe("Black");
  });

  it("rejects unknown dimensions and bad dates", () => {
    const plan = (req: ReportRequest) => planReports(req, [req]);
    expect(() => plan({ groupBy: ["nope"] })).toThrow();
    expect(() => plan({ groupBy: [], from: "1; DROP TABLE orders" })).toThrow();
    expect(() => plan({ groupBy: ["dim:1 OR 1=1"] })).toThrow();
    expect(() => plan({ groupBy: [], filters: [{ dim: "nope", values: ["x"] }] })).toThrow();
    expect(() => plan({ groupBy: ["month", "month"] })).toThrow();
    expect(() => planReports({}, [])).toThrow();
    expect(() => planReports({}, Array.from({ length: 41 }, () => ({ groupBy: [] })))).toThrow();
  });
});
