/**
 * The whole database as one CSV: a row per line item, with its order, its store, every attribute
 * as shown in reports, and every property as imported. Store credentials are never included.
 *
 * Rows are read in pages by primary key and streamed, so the size of the export is not limited by
 * Worker memory. Each page is one query (D1 allows a limited number per request).
 */

export type ExportQuery = (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;

export const EXPORT_PAGE_ROWS = 5000;

/** Fixed columns, in order: CSV header and the field of the page query it comes from. */
const COLUMNS: Array<[string, string]> = [
  ["Store", "store"],
  ["Shop", "shop"],
  ["Order", "order_name"],
  ["Order ID", "order_id"],
  ["Created at", "created_at"],
  ["Day", "day"],
  ["Cancelled", "cancelled"],
  ["Test order", "test"],
  ["Currency", "currency"],
  ["Financial status", "financial_status"],
  ["Sales channel", "source_name"],
  ["State / province", "province"],
  ["State / province code", "province_code"],
  ["Country", "country"],
  ["Country code", "country_code"],
  ["Line item ID", "id"],
  ["Product", "title"],
  ["Variant", "variant_title"],
  ["SKU", "sku"],
  ["Vendor", "vendor"],
  ["Product ID", "product_id"],
  ["Product type", "product_type"],
  ["Wheel type", "wheel_type"],
  ["Quantity ordered", "quantity"],
  ["Quantity now", "current_quantity"],
  ["Unit price", "unit_price"],
  ["Line total", "total"],
  ["Rate to reporting currency", "fx_rate"],
];

// props: {"<key>": ["<value as imported>", "<cleaned value or null>"], ...}
const PAGE_SQL = `SELECT s.label AS store, s.shop || '.myshopify.com' AS shop, s.fx_rate,
    o.name AS order_name, o.created_at, o.day, o.cancelled, o.test, o.currency, o.financial_status, o.source_name,
    o.province, o.province_code, o.country, o.country_code,
    li.store_id, li.order_id, li.id, li.title, li.variant_title, li.sku, li.vendor, li.product_id, li.product_type,
    CASE li.wheel_kind WHEN 'set' THEN 'Wheelset' WHEN 'single' THEN 'Single wheel' WHEN 'rebuild' THEN 'Rebuild' END AS wheel_type,
    li.quantity, li.current_quantity, li.unit_price, li.total,
    (SELECT json_group_object(p.key, json_array(p.value, p.norm)) FROM line_item_props p
      WHERE p.store_id = li.store_id AND p.line_item_id = li.id) AS props
  FROM line_items li
  JOIN orders o ON o.store_id = li.store_id AND o.id = li.order_id
  JOIN stores s ON s.id = li.store_id
  WHERE (li.store_id, li.order_id, li.id) > (?1, ?2, ?3)
  ORDER BY li.store_id, li.order_id, li.id
  LIMIT ?4`;

export function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s) && typeof v !== "number") s = "'" + s; // stop spreadsheets treating values as formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvLine = (cells: unknown[]) => cells.map(csvCell).join(",") + "\r\n";

/** Yields the CSV in pieces: the header first, then one piece per page of line items. */
export async function* exportCsv(query: ExportQuery, pageRows = EXPORT_PAGE_ROWS): AsyncGenerator<string> {
  const dims = (await query(
    `SELECT d.id, d.name FROM dimensions d WHERE EXISTS (SELECT 1 FROM dimension_keys k WHERE k.dimension_id = d.id) ORDER BY d.sort, d.name`,
    [],
  )) as Array<{ id: number; name: string }>;
  const dimKeys = (await query("SELECT key, dimension_id FROM dimension_keys ORDER BY key", [])) as Array<{ key: string; dimension_id: number }>;
  const groups = (await query("SELECT dimension_id, value, label FROM value_groups", [])) as Array<{ dimension_id: number; value: string; label: string }>;
  const keys = ((await query("SELECT DISTINCT key FROM line_item_props ORDER BY key", [])) as Array<{ key: string }>).map((r) => r.key);

  const keysOf = new Map<number, string[]>();
  for (const k of dimKeys) keysOf.set(k.dimension_id, [...(keysOf.get(k.dimension_id) ?? []), k.key]);
  // Combined values match without regard to case, as they do in reports.
  const labelOf = new Map(groups.map((g) => [`${g.dimension_id}\n${g.value.toLowerCase()}`, g.label]));

  yield "﻿" + csvLine([...COLUMNS.map(([header]) => header), ...dims.map((d) => d.name), ...keys.map((k) => `Property: ${k}`)]);

  let after: [number, number, number] = [-1, -1, -1];
  for (;;) {
    const rows = await query(PAGE_SQL, [...after, pageRows]);
    let out = "";
    for (const r of rows) {
      const props: Record<string, [string, string | null]> = r.props ? JSON.parse(r.props as string) : {};
      const cells: unknown[] = COLUMNS.map(([, field]) => r[field]);
      for (const d of dims) {
        // The cleaned value, or the label it was combined under on the Attributes page.
        const key = keysOf.get(d.id)?.find((k) => props[k]);
        const value = key ? (props[key][1] ?? props[key][0]) : null;
        cells.push(value === null ? null : (labelOf.get(`${d.id}\n${value.toLowerCase()}`) ?? value));
      }
      for (const k of keys) cells.push(props[k]?.[0]);
      out += csvLine(cells);
    }
    if (out) yield out;
    if (rows.length < pageRows) return;
    const last = rows[rows.length - 1];
    after = [Number(last.store_id), Number(last.order_id), Number(last.id)];
  }
}
