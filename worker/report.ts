/**
 * Builds the aggregate SQL behind every chart and table.
 *
 * A "dimension" is anything you can group or filter by:
 *   - built-ins:  store, country, province, product, product_type, month, ...
 *   - dim:<id>    a named attribute (e.g. Rim) fed by one or more line item property keys
 *   - prop:<key>  a raw line item property key
 */

import { normaliseValue } from "./values";
import { NOT_A_WHEEL, SET_WORDS } from "./wheels";

export interface ReportFilter {
  dim: string;
  values: string[];
}

export interface ReportRequest {
  groupBy: string[];
  filters?: ReportFilter[];
  from?: string | null;
  to?: string | null;
  search?: string | null;
  includeCancelled?: boolean;
  /** Keep line items that have no value for a grouped attribute (shown as "(not set)"). */
  includeMissing?: boolean;
  limit?: number;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
  totalsSql: string;
  totalsParams: unknown[];
}

export const TIME_DIMS = ["day", "week", "month", "quarter", "year"] as const;

/** `optional` dimensions have no value for some line items, which are left out when grouping unless asked for. */
export const BUILTIN_DIMS: Array<{ id: string; label: string; group: string; sql: string; optional?: boolean }> = [
  { id: "store", label: "Store", group: "Order", sql: "s.label" },
  { id: "country", label: "Country", group: "Location", sql: "COALESCE(o.country, o.country_code, '(unknown)')" },
  {
    id: "province",
    label: "State / province",
    group: "Location",
    sql: "CASE WHEN o.province IS NULL AND o.province_code IS NULL THEN '(unknown)' ELSE COALESCE(o.province, o.province_code) || ', ' || COALESCE(o.country_code, '') END",
  },
  {
    // Set at import from the product title and variant (see wheels.ts). Add-ons and parts have none.
    id: "wheel_type",
    label: "Wheel type",
    group: "Product",
    sql: "CASE li.wheel_kind WHEN 'set' THEN 'Wheelset' WHEN 'single' THEN 'Single wheel' WHEN 'rebuild' THEN 'Rebuild' END",
    optional: true,
  },
  { id: "product", label: "Product", group: "Product", sql: "COALESCE(li.title, '(untitled)')" },
  { id: "variant", label: "Product variant", group: "Product", sql: "COALESCE(li.title, '(untitled)') || CASE WHEN li.variant_title IS NULL OR li.variant_title = '' THEN '' ELSE ' / ' || li.variant_title END" },
  { id: "product_type", label: "Product type", group: "Product", sql: "COALESCE(NULLIF(li.product_type, ''), '(none)')" },
  { id: "vendor", label: "Vendor", group: "Product", sql: "COALESCE(NULLIF(li.vendor, ''), '(none)')" },
  { id: "sku", label: "SKU", group: "Product", sql: "COALESCE(NULLIF(li.sku, ''), '(none)')" },
  { id: "channel", label: "Sales channel", group: "Order", sql: "COALESCE(o.source_name, '(unknown)')" },
  { id: "day", label: "Day", group: "Time", sql: "o.day" },
  { id: "week", label: "Week", group: "Time", sql: "date(o.day, 'weekday 0', '-6 days')" },
  { id: "month", label: "Month", group: "Time", sql: "substr(o.day, 1, 7)" },
  { id: "quarter", label: "Quarter", group: "Time", sql: "substr(o.day, 1, 4) || '-Q' || ((CAST(substr(o.day, 6, 2) AS INTEGER) + 2) / 3)" },
  { id: "year", label: "Year", group: "Time", sql: "substr(o.day, 1, 4)" },
];

/**
 * How many wheels one unit of a line item is: 2 for a wheelset, 1 for a single front or rear wheel,
 * 0 for anything else. Read from the product title and variant, because that is the only place every
 * store says it consistently ("... Wheelset", "... Wheels (Front + Rear)", "... Rear Wheel",
 * "... Wheel (Rear Only)"). Services and add-ons that mention wheels (rebuilds, wheel shells,
 * "per wheel" upgrades, deposits, shipping) count as 0. SQLite LIKE ignores case.
 *
 * wheelKind in wheels.ts is the same rule run at import (2 is its "set", 1 its "single"), which is
 * what the Wheel type dimension shows. Change the two together.
 */
const WHEEL_TEXT = "(COALESCE(li.title, '') || ' ' || COALESCE(li.variant_title, ''))";
const has = (...words: string[]) => "(" + words.map((w) => `${WHEEL_TEXT} LIKE '%${w}%'`).join(" OR ") + ")";
export const WHEELS_PER_UNIT = `(CASE
      WHEN NOT ${has("wheel")} THEN 0
      WHEN ${has(...NOT_A_WHEEL)} THEN 0
      WHEN ${has(...SET_WORDS)} OR (${has("front")} AND ${has("rear")} AND NOT ${has("only")}) THEN 2
      WHEN ${has("front", "rear")} THEN 1
      ELSE 0
    END)`;

export function isTimeDim(id: string): boolean {
  return (TIME_DIMS as readonly string[]).includes(id);
}
export function isAttributeDim(id: string): boolean {
  return id.startsWith("dim:") || id.startsWith("prop:");
}
export function isOptionalDim(id: string): boolean {
  return isAttributeDim(id) || !!BUILTIN_DIMS.find((d) => d.id === id)?.optional;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class ReportError extends Error {}

export function buildReport(req: ReportRequest): BuiltQuery {
  const grouped = compose(req, true);
  // Totals use the same filters. They are built separately so each statement binds exactly the parameters it uses.
  const totals = compose(req, false);
  return { sql: grouped.sql, params: grouped.params, totalsSql: totals.sql, totalsParams: totals.params };
}

function compose(req: ReportRequest, withGroups: boolean): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `?${params.length}`;
  };

  // Each distinct dimension is bound once and its SQL reused in SELECT and WHERE.
  const cache = new Map<string, string>();
  const expr = (id: string): string => {
    const hit = cache.get(id);
    if (hit) return hit;
    let sql: string;
    if (id.startsWith("dim:")) {
      const dimId = Number(id.slice(4));
      if (!Number.isInteger(dimId)) throw new ReportError(`Unknown dimension ${id}`);
      // The cleaned value, or the label it was combined under on the Attributes page.
      sql = `(SELECT COALESCE(g.label, p.norm, p.value) FROM line_item_props p JOIN dimension_keys k ON k.key = p.key
              LEFT JOIN value_groups g ON g.dimension_id = k.dimension_id AND g.value = COALESCE(p.norm, p.value)
              WHERE p.store_id = li.store_id AND p.line_item_id = li.id AND k.dimension_id = ${bind(dimId)} LIMIT 1)`;
    } else if (id.startsWith("prop:")) {
      sql = `(SELECT COALESCE(p.norm, p.value) FROM line_item_props p
              WHERE p.store_id = li.store_id AND p.line_item_id = li.id AND p.key = ${bind(id.slice(5))})`;
    } else {
      const b = BUILTIN_DIMS.find((d) => d.id === id);
      if (!b) throw new ReportError(`Unknown dimension ${id}`);
      sql = b.sql;
    }
    cache.set(id, sql);
    return sql;
  };

  const groupBy = (req.groupBy ?? []).slice(0, 2);
  if (new Set(groupBy).size !== groupBy.length) throw new ReportError("Group by and split by must be different");

  const where: string[] = ["o.test = 0"];
  if (!req.includeCancelled) where.push("o.cancelled = 0");
  if (req.from) {
    if (!DAY.test(req.from)) throw new ReportError("Invalid from date");
    where.push(`o.day >= ${bind(req.from)}`);
  }
  if (req.to) {
    if (!DAY.test(req.to)) throw new ReportError("Invalid to date");
    where.push(`o.day <= ${bind(req.to)}`);
  }
  if (req.search?.trim()) {
    const like = "%" + req.search.trim().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    where.push(`(li.title LIKE ${bind(like)} ESCAPE '\\' OR li.sku LIKE ?${params.length} ESCAPE '\\')`);
  }
  for (const f of req.filters ?? []) {
    if (!f?.values?.length) continue;
    // Attribute values are matched as typed and as cleaned, so a saved filter for 29" still finds 29.
    const values = f.values.map(String);
    if (isAttributeDim(f.dim)) values.push(...values.map(normaliseValue));
    where.push(`${expr(f.dim)} COLLATE NOCASE IN (SELECT value FROM json_each(${bind(JSON.stringify([...new Set(values)]))}))`);
  }
  for (const id of groupBy) {
    if (isOptionalDim(id) && !req.includeMissing) where.push(`${expr(id)} IS NOT NULL`);
  }

  const metrics = `
    SUM(li.current_quantity * ${WHEELS_PER_UNIT}) AS wheels,
    SUM(li.current_quantity) AS units,
    COUNT(DISTINCT li.store_id || ':' || li.order_id) AS orders,
    ROUND(SUM(CASE WHEN li.quantity > 0 THEN li.total * li.current_quantity / li.quantity ELSE 0 END * s.fx_rate), 2) AS revenue,
    COUNT(*) AS line_items`;
  const from = `
    FROM line_items li
    JOIN orders o ON o.store_id = li.store_id AND o.id = li.order_id
    JOIN stores s ON s.id = li.store_id
    WHERE ${where.join("\n      AND ")}`;

  if (!withGroups || !groupBy.length) return { sql: `SELECT${metrics}${from}`, params };

  const selects = groupBy.map((id, i) => `COALESCE(${expr(id)}, '(not set)') AS g${i + 1}`);
  const groups = groupBy.map((id, i) => (isTimeDim(id) ? `g${i + 1}` : `g${i + 1} COLLATE NOCASE`));
  const limit = Math.min(Math.max(Number(req.limit) || 5000, 1), 20000);
  const order = isTimeDim(groupBy[0]) ? "g1 ASC, wheels DESC, units DESC" : "wheels DESC, units DESC";
  const sql = `SELECT ${selects.join(", ")},${metrics}${from}\n    GROUP BY ${groups.join(", ")}\n    ORDER BY ${order}\n    LIMIT ${limit}`;
  return { sql, params };
}
