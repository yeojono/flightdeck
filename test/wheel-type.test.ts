// Wheel type (wheelset, single wheel, rebuild): telling them apart, reading their values, and importing only
// tagged orders. Titles, keys and values here are ones in real use. Counting wheels sold is in wheels.test.ts.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { generateJsonl } from "../scripts/mock-data.mjs";
import { type Carry, SWEEP_UNSEEN, hasTag, importScope, makeDayFormatter, parseJsonl, writeParsed } from "../worker/ingest";
import { type ReportRequest, WHEELS_PER_UNIT } from "../worker/report";
import { buildBulkQuery, orderTag } from "../worker/shopify";
import { cleanValue, wheelKind } from "../worker/wheels";
import { runReport } from "./run-report";

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const day = makeDayFormatter("UTC");

/** Just enough of the D1 API over node:sqlite to run writeParsed. */
function d1(db: DatabaseSync): D1Database {
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    exec: () => db.prepare(sql).run(...(args as any[])),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (list: any[]) => list.map((s) => s.exec()) } as unknown as D1Database;
}

interface Line {
  title: string;
  props: Record<string, string>;
  qty?: number;
}
let nextId = 1;
/** One order per entry in the shape of a Shopify bulk export. `tags` undefined leaves the field out. */
function jsonl(orders: Array<{ id?: number; tags?: string[]; lines: Line[] }>): string {
  const out: string[] = [];
  for (const o of orders) {
    const gid = `gid://shopify/Order/${o.id ?? nextId++}`;
    out.push(JSON.stringify({ id: gid, createdAt: "2026-05-01T00:00:00Z", currencyCode: "AUD", ...(o.tags ? { tags: o.tags } : {}) }));
    for (const l of o.lines) {
      out.push(
        JSON.stringify({
          id: `gid://shopify/LineItem/${nextId++}`,
          __parentId: gid,
          title: l.title,
          quantity: l.qty ?? 1,
          currentQuantity: l.qty ?? 1,
          customAttributes: Object.entries(l.props).map(([key, value]) => ({ key, value })),
        }),
      );
    }
  }
  return out.join("\n") + "\n";
}

const SET_NEW = "Wingman Origin Alloy Wheelset | Clockwork Hubs | Origin Black Rim Set";
const SET_OLD = "Project 321 G3 Hubs + Wingman Origin Custom Alloy Wheels (Front + Rear)";
const REAR_NEW = "Wingman Origin Alloy Rear Wheel | Clockwork Hub | Origin Black Rim";
const REAR_OLD = "Yama Hub + Wingman Origin Custom Alloy Wheel (Rear Only)";

describe("wheelKind", () => {
  it.each([
    [SET_NEW, "set"],
    [SET_OLD, "set"],
    ["Industry Nine Hydra 2 + DT Swiss FR571 Custom Alloy Wheelset (Front + Rear)", "set"],
    ["E*Thirteen Sidekick Hubs + Yama DH Custom Alloy Wheels (Front + Rear) (For DH)", "set"],
    ["Zipp 3Zero Moto 29' WheelSet - SPECIAL OFFER", "set"],
    [REAR_NEW, "single"],
    [REAR_OLD, "single"],
    ["New Rear Wheel", "single"],
    ['29" Origin Front Wheel - Black w/ Silver SPokes', "single"],
    ["Matching Front Wheel - Spec TBC", "single"],
    ['Rebuild on Origin 27_5" 32H', "rebuild"],
    ["Premium Event Wheel Rebuild", "rebuild"],
    ["Wingman Origin Rebuild", "rebuild"],
  ])("%s -> %s", (title, kind) => expect(wheelKind(title)).toBe(kind));

  it.each([
    "Tubeless Tape Install",
    "Tubeless Valve (Insert Compatible)",
    "Bladed Spoke Upgrade (Per Wheel)",
    "Wheel Shell",
    "Clockwork Ratchet Upgrade - 45 Tooth",
    "Hydra2 - Rear 12x148mm Boost 6-Bolt",
    'DT Swiss FR541 29" Alloy Rim',
    "Shimano Saint M820 Brake Set - Open Box",
    "SRAM Code RSC - Front Only",
    "$200 non-refundable deposit for future Wingman alloy wheelset sale.",
    "Wheelset - Express Shipping",
  ])("%s is not a wheel", (title) => expect(wheelKind(title)).toBeNull());

  it("reads the variant too", () => {
    expect(wheelKind("Custom Wheel Build", "Front")).toBe("single");
    expect(wheelKind("Custom Wheel Build", null)).toBeNull();
    expect(wheelKind("DT Swiss FR541 / 350 Wheelset - Special Offer", "Mullet / XD")).toBe("set");
  });

  it("is the same rule as the wheels sold count: a set is 2 wheels, a single is 1, anything else 0", () => {
    const db = new DatabaseSync(":memory:");
    const perUnit = db.prepare(`SELECT ${WHEELS_PER_UNIT} AS n FROM (SELECT ? AS title, ? AS variant_title) li`);
    const products: Array<[string | null, string | null]> = [
      ...[SET_NEW, SET_OLD, REAR_NEW, REAR_OLD].map((t): [string, null] => [t, null]),
      ["Industry Nine Hydra 2 + DT Swiss FR571 Custom Alloy Wheelset (Front + Rear)", null],
      ["Zipp 3Zero Moto 29' WheelSet - SPECIAL OFFER", null],
      ["Non Boost Wheel Set", null],
      ["Wingman Origin Alloy Rear Wheel | Clockwork Hub | Origin Black Rim", "148x12 Boost / SRAM XD / 29"],
      ["Custom Wheel Build", "Front"],
      ["Custom Wheel Build", "Rear"],
      ["Custom Wheel Build", null],
      ["Origin Black 27.5 Rear on Sidekick Pro XD Boost (Complete wheel)", null],
      ["Wingman/Yama Rear DH Wheel", null],
      ["Front Wheel to match wheelset", null],
      ["Front and rear wheel, rear only has the insert", null],
      ["Upgrade 4845 front wheel to WAO Triad + 240 EXP", null],
      ["Premium Event Wheel Rebuild", null],
      ['Rebuild on Origin 27_5" 32H', null],
      ["Rear wheel rebuild", "Front"],
      ["Wheel Shell", null],
      ["Bladed Spoke Upgrade (Per Wheel)", null],
      ["Wheelset - Express Shipping", null],
      ["$200 non-refundable deposit for future Wingman alloy wheelset sale.", null],
      ["Tubeless Valve (Insert Compatible)", "Rear"],
      ["Hydra2 - Rear 12x148mm Boost 6-Bolt", "Black"],
      ["SRAM Code RSC - Front Only", null],
      ["Major True Stock Canyon Wheel", null],
      [null, null],
    ];
    const wheels = { set: 2, single: 1, rebuild: 0 };
    for (const [title, variant] of products) {
      const kind = wheelKind(title, variant);
      expect([title, variant, (perUnit.get(title, variant) as any).n]).toEqual([title, variant, kind ? wheels[kind] : 0]);
    }
  });
});

describe("cleanValue", () => {
  it("reads a bare size on a wheelset as the set, and on anything else as one wheel", () => {
    for (const v of ["29", '29"', "29″", '29" Set', "29 set"]) expect(cleanValue("size", v, "set").toLowerCase()).toBe("29 set");
    for (const v of ["29", '29"', "29″"]) {
      expect(cleanValue("size", v, "single")).toBe("29");
      expect(cleanValue("diameter", v, "rebuild")).toBe("29");
      expect(cleanValue("size", v, null)).toBe("29"); // a Wheel Shell
    }
    expect(cleanValue("size", "Mullet", "set")).toBe("Mullet Set");
    expect(cleanValue("size", "27.5", "set")).toBe("27.5 Set");
    expect(cleanValue("diameter", '27_5"', "rebuild")).toBe("27.5");
    expect(cleanValue("wheel sizing", "700c", "set")).toBe("700c Set");
    expect(cleanValue("size", "Match my wheelset", "set")).toBe("Match my wheelset");
    // Only size properties: a wheelset's hole count of 32 stays 32.
    expect(cleanValue("hole count", "32", "set")).toBe("32");
  });

  it.each([
    ["hole count", "32 / 28 (Recommended)", "32/28"],
    ["hole count ( rear / front )", "32 / 28", "32/28"],
    ["hole count ( front / rear )", "28 / 32", "32/28"],
    ["hole count ( front / rear )", "32 / 32", "32/32"],
    ["hole count", "32H", "32"],
    ["hole count", "28", "28"],
    ["brake rotor mount", "6 Bolt", "6-Bolt"],
    ["brake mount", "6-Bolt", "6-Bolt"],
    ["brake rotor mount", "Center Lock", "Centerlock"],
    ["brake rotor mount", "P321 6-Lock", "P321 6-Lock"],
    ["freehub / driver", "Shimano Micro Spline", "Shimano Microspline"],
    ["driver", "HG", "Shimano HG"],
    ["freehub / driver", "HG Road", "Shimano HG Road"],
    ["driver", "Shimano Mini HG", "Shimano Mini HG"],
    ["freehub", "SRAM XD", "SRAM XD"],
    ["front hub size", "110x15 (Boost)", "110x15"],
    ["front hub", "110x15 Boost", "110x15"],
    ["front hub size", "110x20 Boost (2021+) (Black & Silver Only)", "110x20 Boost"],
    ["front hub size", "110x20 (Boost 2021+ DH Forks)", "110x20 Boost"],
    ["front hub size", "110x20 (Black & Silver only)", "110x20"],
    ["rear hub size", "148x12 (Boost)", "148x12"],
    ["rear hub", "148x12 Boost", "148x12"],
    ["rear hub size", "157x12 (Super Boost)", "157x12 Super Boost"],
    ["hub size", "157x12", "157x12"],
  ])("%s: %s -> %s", (key, raw, clean) => expect(cleanValue(key, raw, "set")).toBe(clean));

  it("leaves properties it has no rule for to the general clean-up", () => {
    expect(cleanValue("hub colour", "Black/Silver", "set")).toBe("Black/Silver");
    expect(cleanValue("rim", "Origin Alloy (Black)", null)).toBe("Origin Alloy (Black)");
    // Free text about a customer's own hub is not a hub size.
    expect(cleanValue("hub", "Hope pro 5 black 32h 12x148 | Rear | HG | 6 Bolt", "rebuild")).toBe("Hope pro 5 black 32h 12x148 | Rear | HG | 6 Bolt");
  });
});

/** A database as it is in use today (keys seen, nothing mapped but Freehub), then upgraded. */
function upgradedDb() {
  const db = new DatabaseSync(":memory:");
  for (const m of ["0001_init.sql", "0002_drop_login_attempts.sql"]) db.exec(migration(m));
  db.exec(`INSERT INTO stores (id, shop, label, client_id, client_secret_enc, sync_cursor) VALUES (1, 's', 'Store', 'x', 'x', '2026-11-01T00:00:00Z')`);
  const keys = [
    "size", "wheel sizing", "diameter", "driver", "freehub", "freehub / driver", "driver type", "hub colour", "brake mount", "brake rotor mount",
    "hole count", "hole count ( rear / front )", "hole count ( front / rear )", "spokes", "spoke", "front hub size", "front hub", "rear hub size",
    "rear hub", "hub size", "valve colour", "rim", "rim model", "for", "hub",
  ];
  keys.forEach((k, i) => db.prepare(`INSERT INTO line_item_props (store_id, line_item_id, key, value, order_id) VALUES (1, ?, ?, 'x', 900000)`).run(900000 + i, k));
  db.exec(migration("0003_value_grouping.sql"));
  return db;
}
const dimId = (db: DatabaseSync, name: string) => (db.prepare("SELECT id FROM dimensions WHERE name = ?").get(name) as any)?.id as number;
function report(db: DatabaseSync, req: ReportRequest) {
  return Object.fromEntries(runReport(db, req).rows.map((r) => [r.g2 === undefined ? r.g1 : `${r.g1} | ${r.g2}`, r.units]));
}

describe("upgrade migration", () => {
  it("maps keys that mean the same thing to one attribute", () => {
    const db = upgradedDb();
    db.exec(migration("0004_wheels.sql"));
    const mapped = db.prepare(`SELECT d.name, group_concat(k.key, ', ' ORDER BY k.key) AS keys FROM dimensions d LEFT JOIN dimension_keys k ON k.dimension_id = d.id GROUP BY d.id ORDER BY d.sort`).all();
    expect(Object.fromEntries(mapped.map((r: any) => [r.name, r.keys]))).toEqual({
      Rim: "rim, rim model",
      Hub: null,
      "Hub colour": "hub colour",
      "Wheel size": "diameter, size, wheel sizing",
      Freehub: "driver, driver type, freehub, freehub / driver",
      "Brake mount": "brake mount, brake rotor mount",
      "Hole count": "hole count, hole count ( front / rear ), hole count ( rear / front )",
      Spokes: "spoke, spokes",
      "Front hub size": "front hub, front hub size",
      "Rear hub size": "hub size, rear hub, rear hub size",
      "Valve colour": "valve colour",
    });
  });

  it("leaves your own attributes and mappings alone", () => {
    const db = upgradedDb();
    db.exec(`INSERT INTO dimensions (name, sort) VALUES ('spokes', 9)`);
    db.exec(`INSERT INTO dimension_keys (key, dimension_id) VALUES ('valve colour', 3), ('size', 2)`);
    db.exec(migration("0004_wheels.sql"));
    // Colour had a key, so it keeps its name; an attribute named spokes exists, so no second one.
    expect(dimId(db, "Colour")).toBe(3);
    expect(dimId(db, "Hub colour")).toBeUndefined();
    expect((db.prepare(`SELECT COUNT(*) n FROM dimensions WHERE name LIKE 'spokes'`).get() as any).n).toBe(1);
    expect((db.prepare(`SELECT dimension_id d FROM dimension_keys WHERE key = 'size'`).get() as any).d).toBe(2);
    expect((db.prepare(`SELECT dimension_id d FROM dimension_keys WHERE key = 'valve colour'`).get() as any).d).toBe(3);
    expect((db.prepare(`SELECT dimension_id d FROM dimension_keys WHERE key = 'spoke'`).get() as any).d).toBe(dimId(db, "spokes"));
  });
});

describe("sets and single wheels in reports", () => {
  const db = upgradedDb();
  db.exec(migration("0004_wheels.sql"));
  const p = parseJsonl(
    jsonl([
      { lines: [{ title: SET_NEW, props: { Size: "29", "Hole Count": "32 / 28 (Recommended)", Freehub: "Shimano HG", "Rear Hub": "148x12 Boost" }, qty: 3 }] },
      { lines: [{ title: SET_NEW, props: { Size: '29" Set', "Rear Hub Size": "157x12 (Super Boost)" }, qty: 4 }, { title: "Tubeless Valve (Insert Compatible)", props: { "Valve Colour": "Black" }, qty: 2 }] },
      { lines: [{ title: SET_OLD, props: { "Wheel Sizing": "Mullet Set", "Hole Count ( Front / Rear )": "28 / 32", "Freehub / Driver": "HG" } }] },
      { lines: [{ title: SET_NEW, props: { Size: "Mullet" } }] },
      { lines: [{ title: REAR_NEW, props: { Size: '29"', "Hole Count": "32", Driver: "Shimano Micro Spline", "Rear Hub Size": "157x12" }, qty: 5 }] },
      { lines: [{ title: REAR_OLD, props: { "Wheel Sizing": "29″", "Hub Size": "148x12" }, qty: 6 }] },
      { lines: [{ title: 'Rebuild on Origin 27_5" 32H', props: { Diameter: '27_5"', "Hole Count": "32H", Spoke: "Sandvik T302+ Black J Bend", Rim: "Origin" } }] },
      { lines: [{ title: "Rebuild on Wingman Origin", props: { Diameter: '27.5"', "Rim Model": "Wingman Origin" } }] },
      { lines: [{ title: "Wheel Shell", props: { Size: '29"' }, qty: 7 }] },
      { lines: [{ title: SET_OLD, props: { Spokes: "Pillar Sandvik T302+ Black" } }] },
    ]),
    day,
  );
  // Importing replaces what was there, as a full resync does.
  beforeAll(async () => {
    db.exec("DELETE FROM line_item_props");
    await writeParsed(d1(db), 1, 1, p);
  });

  const size = `dim:${dimId(db, "Wheel size")}`;

  it("keeps a 29 set apart from a 29 single wheel, however each was written", () => {
    expect(report(db, { groupBy: [size] })).toEqual({ "29 Set": 7, "Mullet Set": 2, "29": 5 + 6 + 7, "27.5": 2 });
    expect(report(db, { groupBy: [size, "wheel_type"] })).toEqual({
      "29 Set | Wheelset": 7,
      "Mullet Set | Wheelset": 2,
      "29 | Single wheel": 11,
      "27.5 | Rebuild": 2,
    });
  });

  it("filters sets and single wheels apart", () => {
    expect(report(db, { groupBy: ["wheel_type"] })).toEqual({ Wheelset: 10, "Single wheel": 11, Rebuild: 2 });
    expect(report(db, { groupBy: [size], filters: [{ dim: "wheel_type", values: ["Wheelset"] }] })).toEqual({ "29 Set": 7, "Mullet Set": 2 });
    expect(report(db, { groupBy: [size], filters: [{ dim: "wheel_type", values: ["Single wheel"] }] })).toEqual({ "29": 11 });
    expect(report(db, { groupBy: [size], filters: [{ dim: "wheel_type", values: ["Single wheel", "Rebuild"] }] })).toEqual({ "29": 11, "27.5": 2 });
    // Add-ons and parts have no wheel type; they only show when asked for.
    expect(report(db, { groupBy: ["wheel_type"], includeMissing: true })).toEqual({ Wheelset: 10, "Single wheel": 11, Rebuild: 2, "(not set)": 9 });
    // Filtering by a size finds only that kind of wheel.
    expect(report(db, { groupBy: ["wheel_type"], filters: [{ dim: size, values: ["29"] }] })).toEqual({ "Single wheel": 11 });
    expect(report(db, { groupBy: ["wheel_type"], filters: [{ dim: size, values: ['29" Set'] }] })).toEqual({ Wheelset: 7 });
  });

  it("merges the other properties across their keys and spellings", () => {
    const by = (name: string) => report(db, { groupBy: [`dim:${dimId(db, name)}`] });
    expect(by("Hole count")).toEqual({ "32/28": 3 + 1, "32": 5 + 1 });
    expect(by("Freehub")).toEqual({ "Shimano HG": 3 + 1, "Shimano Microspline": 5 });
    expect(by("Valve colour")).toEqual({ Black: 2 });
    // These three come from the combined values the migration saves, which the Attributes page can undo.
    expect(by("Rear hub size")).toEqual({ "148x12": 3 + 6, "157x12": 4 + 5 });
    expect(by("Spokes")).toEqual({ "Pillar Sandvik T302+ Black": 2 });
    expect(by("Rim")).toEqual({ Origin: 2 });
    db.exec(`DELETE FROM value_groups WHERE value = '157x12 Super Boost'`);
    expect(by("Rear hub size")).toEqual({ "148x12": 9, "157x12": 5, "157x12 Super Boost": 4 });
  });
});

describe("importing only tagged orders", () => {
  it("matches the whole tag, ignoring case", () => {
    expect(hasTag(["VIP", "Wheels"], "wheels")).toBe(true);
    expect(hasTag("vip, wheels", "wheels")).toBe(true);
    expect(hasTag(["wheels-deposit", "no wheels"], "wheels")).toBe(false);
    expect(hasTag(undefined, "wheels")).toBe(false);
  });

  it("asks Shopify for the tag on a full resync and for tags on a changes-only sync", () => {
    const full = buildBulkQuery({ since: null, withProducts: true, tag: "wheels", withTags: true });
    expect(full).toContain(`orders(query: "tag:'wheels'")`);
    expect(full).toMatch(/sourceName tags\n/);
    const changes = buildBulkQuery({ since: "2026-11-01T00:00:00Z", withProducts: true, tag: null, withTags: true });
    expect(changes).toContain(`orders(query: "updated_at:>='2026-11-01T00:00:00Z'")`);
    expect(changes).toMatch(/sourceName tags\n/);
    expect(buildBulkQuery({ since: "2026-11-01T00:00:00Z", withProducts: true, tag: "wheels" })).toContain(`(query: "tag:'wheels' AND updated_at:>='2026-11-01T00:00:00Z'")`);
    expect(buildBulkQuery({ since: null, withProducts: true })).toContain("orders {");
  });

  it("reads the tag setting", () => {
    expect(orderTag({ ORDER_TAG: " Wheels " })).toBe("Wheels");
    expect(orderTag({ ORDER_TAG: `wheels' OR "x` })).toBe("wheels OR x");
    expect(orderTag({})).toBe("");
    expect(importScope({ ORDER_TAG: "Wheels" })).toBe(importScope({ ORDER_TAG: "wheels" }));
    expect(importScope({ ORDER_TAG: "wheels" })).not.toBe(importScope({ ORDER_TAG: "" }));
  });

  const file = jsonl([
    { id: 1, tags: ["wheels"], lines: [{ title: SET_NEW, props: { Size: "29" } }] },
    { id: 2, tags: ["brakes"], lines: [{ title: "SRAM Code RSC", props: { Side: "Front" } }, { title: "Lewis Heavy Duty Rotor", props: {} }] },
    { id: 3, tags: ["VIP", "Wheels"], lines: [{ title: REAR_NEW, props: { Size: '29"' } }, { title: "Tubeless Tape Install", props: {} }] },
    { id: 4, tags: [], lines: [{ title: "Sealant", props: {} }] },
  ]);

  it("keeps tagged orders with all their line items and skips the rest", () => {
    const p = parseJsonl(file, day, { tag: "wheels" });
    expect(p.orderIds).toEqual([1, 3]);
    expect(p.untaggedIds).toEqual([2, 4]);
    expect(p.lineItems.map((l) => l[2])).toEqual([SET_NEW, REAR_NEW, "Tubeless Tape Install"]);
    expect(p.props.map((r) => r[4] ?? r[2])).toEqual(["29 Set", "29"]);
    // Without a tag set, everything is imported.
    expect(parseJsonl(file, day).orderIds).toEqual([1, 2, 3, 4]);
    expect(parseJsonl(file, day, { tag: "" }).lineItems.length).toBe(6);
  });

  it("gives the same result wherever the file is cut into chunks", () => {
    const whole = parseJsonl(file, day, { tag: "wheels" });
    const lines = file.trimEnd().split("\n");
    for (let cut = 1; cut < lines.length; cut++) {
      const a = parseJsonl(lines.slice(0, cut).join("\n"), day, { tag: "wheels" });
      // The carry goes through a workflow step result, so it must survive JSON.
      const carry = JSON.parse(JSON.stringify(a.carry)) as Carry | null;
      const b = parseJsonl(lines.slice(cut).join("\n"), day, { tag: "wheels", carry });
      expect([...a.orderIds, ...b.orderIds]).toEqual(whole.orderIds);
      expect([...a.lineItems, ...b.lineItems]).toEqual(whole.lineItems);
      expect([...a.props, ...b.props]).toEqual(whole.props);
    }
  });

  it("removes an order that lost its tag, and what a full resync did not see", async () => {
    const db = upgradedDb();
    db.exec(migration("0004_wheels.sql"));
    db.exec("DELETE FROM line_item_props");
    const counts = () => db.prepare("SELECT (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM line_items) l, (SELECT COUNT(*) FROM line_item_props) p").get();
    const ids = () => db.prepare("SELECT id FROM orders ORDER BY id").all().map((r: any) => r.id);

    // Run 1, before the tag setting: everything is imported.
    await writeParsed(d1(db), 1, 1, parseJsonl(file, day));
    expect(counts()).toEqual({ o: 4, l: 6, p: 3 });

    // Run 2, changes only: order 3 has lost the tag, order 5 is new.
    const changes = jsonl([
      { id: 3, tags: ["VIP"], lines: [{ title: REAR_NEW, props: { Size: '29"' } }, { title: "Tubeless Tape Install", props: {} }] },
      { id: 5, tags: ["wheels"], lines: [{ title: REAR_OLD, props: { Size: '27.5"' } }] },
    ]);
    await writeParsed(d1(db), 1, 2, parseJsonl(changes, day, { tag: "wheels" }));
    expect(ids()).toEqual([1, 2, 4, 5]);
    expect(counts()).toEqual({ o: 4, l: 5, p: 3 });

    // Run 3, full resync with the tag: Shopify returns orders 1 and 5 only. The untagged 2 and 4 are swept at the end.
    const full = jsonl([
      { id: 1, tags: ["wheels"], lines: [{ title: SET_NEW, props: { Size: "29" } }] },
      { id: 5, tags: ["wheels"], lines: [{ title: REAR_OLD, props: { Size: '27.5"' } }] },
    ]);
    await writeParsed(d1(db), 1, 3, parseJsonl(full, day, { tag: "wheels" }));
    expect(ids()).toEqual([1, 2, 4, 5]); // nothing disappears while the resync runs
    for (const sql of SWEEP_UNSEEN) db.prepare(sql).run(1, 3);
    expect(ids()).toEqual([1, 5]);
    expect(counts()).toEqual({ o: 2, l: 2, p: 2 });
    // Another store's orders are not touched by this store's sweep.
    db.exec(`INSERT INTO orders (store_id, id, created_at, day, run_id) VALUES (2, 77, '2026-05-01T00:00:00Z', '2026-05-01', 1)`);
    for (const sql of SWEEP_UNSEEN) db.prepare(sql).run(1, 3);
    expect((db.prepare("SELECT COUNT(*) n FROM orders WHERE store_id = 2").get() as any).n).toBe(1);
  });

  it("imports only the tagged orders from a store-sized export", () => {
    const raw = generateJsonl("mock-au", { orders: 300 });
    const orders = raw.trim().split("\n").map((l) => JSON.parse(l)).filter((o) => o.id.includes("/Order/"));
    const tagged = orders.filter((o) => o.tags.some((t: string) => t.toLowerCase() === "wheels"));
    expect(tagged.length).toBeGreaterThan(150);
    expect(tagged.length).toBeLessThan(orders.length);
    const p = parseJsonl(raw, day, { tag: "wheels" });
    expect(p.orderIds.length).toBe(tagged.length);
    expect(p.orderIds.length + p.untaggedIds.length).toBe(300);
    // Every wheel in the mock data is a set or a single, and sets always read as sets.
    const kinds = new Set(p.lineItems.map((l) => l[12]));
    expect(kinds).toEqual(new Set(["set", "single", null]));
    const sizes = new Map<string, Set<unknown>>();
    for (const [id, key, value, , norm] of p.props as Array<[number, string, string, number, string | null]>) {
      if (key !== "wheel size") continue;
      const kind = p.lineItems.find((l) => l[0] === id)![12];
      const v = norm ?? value;
      sizes.set(v, (sizes.get(v) ?? new Set()).add(kind));
    }
    for (const [v, k] of sizes) expect([...k]).toEqual([/ set$/i.test(v) ? "set" : "single"]);
    expect([...sizes.keys()].filter((v) => v !== "26").sort()).toEqual(["27.5", "27.5 Set", "29", "29 Set", "Mullet Set"]);
  });
});
