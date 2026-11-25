// Wheels sold: a wheelset counts as 2, a single front or rear wheel as 1, anything else as 0.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { INSERT_LINE_ITEMS, INSERT_ORDERS, makeDayFormatter, parseJsonl } from "../worker/ingest";
import { runReport } from "./run-report";

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

// Product names as they appear in the stores, with the wheels one unit of each should count as.
const TITLES: Array<[title: string, variant: string | null, wheels: number]> = [
  ["Wingman Origin Alloy Wheelset | Clockwork Hubs | Origin Black Rim Set", null, 2],
  ["Project 321 G3 Hubs + Wingman Origin Custom Alloy Wheels (Front + Rear)", null, 2],
  ["DT Swiss FR541 / 350 Wheelset - Special Offer", "Mullet / XD", 2],
  ["Zipp 3Zero Moto 29' WheelSet - SPECIAL OFFER", null, 2],
  ["Wingman Origin Alloy Rear Wheel | Clockwork Hub | Origin Black Rim", "148x12 Boost / SRAM XD / 29", 1],
  ["Yama Hub + Wingman Origin Custom Alloy Wheel (Rear Only)", null, 1],
  ["29\" Origin Black Front Wheel on Clockwork Black 32H 110x15mm 6B", null, 1],
  ["Custom Wheel Build", "Front", 1],
  ["Bladed Spoke Upgrade (Per Wheel)", null, 0],
  ["Wheel Shell", null, 0],
  ["Premium Event Wheel Rebuild", null, 0],
  ["Upgrade 4845 front wheel to WAO Triad + 240 EXP", null, 0],
  ["$200 non-refundable deposit for future Wingman alloy wheelset sale.", null, 0],
  ["Wheelset - Express Shipping", null, 0],
  ["Tubeless Tape Install", null, 0],
  ["X01 Eagle 12Spd Rear Derailleur", null, 0],
  ["Origin", null, 0],
];

function load(items: Array<{ title: string; variant: string | null; qty: number; current?: number }>) {
  const db = new DatabaseSync(":memory:");
  for (const m of ["0001_init.sql", "0002_drop_login_attempts.sql", "0003_value_grouping.sql", "0004_wheels.sql", "0007_line_item_props_json.sql"]) db.exec(migration(m));
  db.exec(`INSERT INTO stores (id, shop, label, client_id, client_secret_enc) VALUES (1, 's', 'Store', 'x', 'x')`);
  const lines: string[] = [];
  items.forEach((it, i) => {
    const order = `gid://shopify/Order/${i + 1}`;
    lines.push(JSON.stringify({ id: order, createdAt: "2026-05-01T00:00:00Z", currencyCode: "AUD" }));
    lines.push(
      JSON.stringify({
        id: `gid://shopify/LineItem/${i + 1}`,
        __parentId: order,
        title: it.title,
        variantTitle: it.variant,
        quantity: it.qty,
        currentQuantity: it.current ?? it.qty,
        customAttributes: [],
      }),
    );
  });
  const p = parseJsonl(lines.join("\n"), makeDayFormatter("UTC"));
  db.prepare(INSERT_ORDERS).run(1, JSON.stringify(p.orders), 1);
  db.prepare(INSERT_LINE_ITEMS).run(1, JSON.stringify(p.lineItems));
  return db;
}

const report = (db: DatabaseSync, groupBy: string[]) => runReport(db, { groupBy });

describe("wheels sold", () => {
  it.each(TITLES)("%s (%s) counts as %i", (title, variant, wheels) => {
    const db = load([{ title, variant, qty: 1 }]);
    expect(report(db, []).totals.wheels).toBe(wheels);
  });

  it("multiplies by the quantity still on the order after refunds", () => {
    const db = load([
      { title: "Wingman Origin Alloy Wheelset", variant: null, qty: 2 }, // 4 wheels
      { title: "Wingman Origin Alloy Rear Wheel", variant: null, qty: 3, current: 2 }, // 2 wheels
      { title: "Wingman Prodigy Carbon Wheelset", variant: null, qty: 1, current: 0 }, // refunded
      { title: "Tubeless Valve", variant: null, qty: 5 },
    ]);
    const { totals, rows } = report(db, ["product"]);
    expect(totals).toMatchObject({ wheels: 6, units: 9 });
    expect(rows.map((r) => [r.g1, r.wheels])).toEqual([
      ["Wingman Origin Alloy Wheelset", 4],
      ["Wingman Origin Alloy Rear Wheel", 2],
      ["Tubeless Valve", 0],
      ["Wingman Prodigy Carbon Wheelset", 0],
    ]);
  });
});
