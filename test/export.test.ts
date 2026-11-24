// Runs the real export SQL against SQLite and checks the CSV it produces.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { csvCell, exportCsv } from "../worker/export";

const db = new DatabaseSync(":memory:");
const query = async (sql: string, params: unknown[]) => db.prepare(sql).all(...(params as any[])) as Array<Record<string, unknown>>;

/** Minimal RFC 4180 reader, enough to check what the export wrote. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (row.push(cell), (cell = ""));
    else if (ch === "\r" && text[i + 1] === "\n") (row.push(cell), rows.push(row), (row = []), (cell = ""), i++);
    else cell += ch;
  }
  return rows;
}

async function run(pageRows?: number) {
  let text = "";
  for await (const piece of exportCsv(query, pageRows)) text += piece;
  expect(text.startsWith("﻿")).toBe(true);
  const [header, ...rows] = parseCsv(text.slice(1));
  return { header, rows: rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))), raw: rows };
}

beforeAll(() => {
  for (const m of readdirSync(new URL("../migrations/", import.meta.url)).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));
  }
  db.exec(`
    INSERT INTO stores (id, shop, label, client_id, client_secret_enc, access_token_enc, currency, fx_rate) VALUES
      (1, 'au', 'AU store', 'client-id-1', 'SECRET-ENC', 'TOKEN-ENC', 'AUD', 1), (2, 'us', 'US, store', 'client-id-2', 'SECRET-ENC', 'TOKEN-ENC', 'USD', 1.5);
    INSERT INTO orders (store_id, id, name, created_at, day, cancelled, test, currency, country_code, country) VALUES
      (1, 10, '#1010', '2026-01-01T00:00:00Z', '2026-01-01', 0, 0, 'AUD', 'AU', 'Australia'),
      (1, 11, '#1011', '2026-01-02T00:00:00Z', '2026-01-02', 1, 0, 'AUD', 'AU', 'Australia'),
      (2, 10, '#2010', '2026-01-03T00:00:00Z', '2026-01-03', 0, 1, 'USD', 'US', 'United States');
    INSERT INTO line_items (store_id, id, order_id, title, variant_title, sku, quantity, current_quantity, unit_price, total, wheel_kind) VALUES
      (1, 100, 10, 'Trail "Pro" Wheelset', '29', 'W-1', 1, 1, 1500, 1500, 'set'),
      (1, 101, 10, 'Valve caps', NULL, '-CAPS', 2, 2, 10, 20, NULL),
      (1, 102, 11, 'Rear Wheel', NULL, NULL, 1, 0, 800, 800, 'single'),
      (2, 100, 10, 'Line one
line two', NULL, NULL, 1, 1, 900, 900, NULL);
    INSERT INTO line_item_props (store_id, line_item_id, key, value, order_id, norm) VALUES
      (1, 100, 'rim', 'wingman origin', 10, 'Wingman Origin'),
      (1, 100, 'wheel size', '29"', 10, '29'),
      (1, 100, 'note', '=HYPERLINK("x")', 10, NULL),
      (2, 100, 'rim choice', 'Carbon, wide', 10, 'Carbon, wide');
    INSERT OR REPLACE INTO dimension_keys (key, dimension_id)
      SELECT k.key, d.id FROM (SELECT 'rim' AS key, 'Rim' AS dim UNION ALL SELECT 'rim choice', 'Rim' UNION ALL SELECT 'wheel size', 'Wheel size') k
      JOIN dimensions d ON d.name = k.dim;
  `);
});

describe("csvCell", () => {
  it("quotes, escapes and defuses formulas", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
  });
});

describe("export", () => {
  it("writes one row per line item with order, store, attribute and property columns", async () => {
    const { header, rows, raw } = await run();
    expect(rows.length).toBe(4);
    for (const r of raw) expect(r.length).toBe(header.length);
    expect(header.slice(0, 4)).toEqual(["Store", "Shop", "Order", "Order ID"]);
    expect(header).toEqual(expect.arrayContaining(["Rim", "Wheel size", "Property: rim", "Property: rim choice", "Property: note"]));
    expect(header).not.toContain("Hub"); // no keys mapped to it

    const set = rows[0];
    expect(set).toMatchObject({ Store: "AU store", Shop: "au.myshopify.com", Order: "#1010", "Order ID": "10", "Line item ID": "100", Product: 'Trail "Pro" Wheelset', "Wheel type": "Wheelset", "Line total": "1500" });
    // Attribute columns show the cleaned, combined value; property columns show what was imported.
    expect(set.Rim).toBe("Origin");
    expect(set["Property: rim"]).toBe("wingman origin");
    expect(set["Wheel size"]).toBe("29");
    expect(set["Property: wheel size"]).toBe('29"');
    expect(set["Property: note"]).toBe(`'=HYPERLINK("x")`);

    expect(rows[1]).toMatchObject({ Product: "Valve caps", SKU: "'-CAPS", Rim: "", "Wheel type": "" });
    expect(rows[2]).toMatchObject({ Order: "#1011", Cancelled: "1", "Quantity now": "0" });
    expect(rows[3]).toMatchObject({ Store: "US, store", "Test order": "1", Product: "Line one\nline two", Rim: "Carbon, wide", "Rate to reporting currency": "1.5" });
  });

  it("gives the same file whatever the page size", async () => {
    const whole = await run();
    for (const size of [1, 2, 3, 4]) expect((await run(size)).raw).toEqual(whole.raw);
  });

  it("leaves store credentials out", async () => {
    let text = "";
    for await (const piece of exportCsv(query)) text += piece;
    expect(text).not.toMatch(/SECRET-ENC|TOKEN-ENC|client-id/);
  });
});
