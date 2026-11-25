/**
 * Works out every chart and table.
 *
 * A "dimension" is anything you can group or filter by:
 *   - built-ins:  store, country, province, product, product_type, month, ...
 *   - dim:<id>    a named attribute (e.g. Rim) fed by one or more line item property keys
 *   - prop:<key>  a raw line item property key
 *
 * D1 bills every row a statement steps over, including the rows of its own sorts and temporary
 * tables, so a GROUP BY per chart costs a full pass per chart. Instead, one statement reads the
 * matching line items once (planReports) and the grouping is done here in the Worker
 * (finishReports). Any number of charts that share the same filters share that one read.
 *
 * Two things keep that read small. Each line item carries a copy of its properties, so they
 * come with its row. And when an attribute is filtered, the read starts from the line items
 * that have the wanted value instead of from every line item in the date range.
 */

import { normaliseValue } from "./values";
import { NOT_A_WHEEL, SET_WORDS } from "./wheels";

export interface ReportFilter {
  dim: string;
  values: string[];
}

/** What is counted: the filters every report in a request shares. */
export interface ReportBase {
  filters?: ReportFilter[];
  from?: string | null;
  to?: string | null;
  search?: string | null;
  includeCancelled?: boolean;
}

/** How it is broken down. */
export interface ReportSpec {
  groupBy: string[];
  /** Keep line items that have no value for a grouped attribute (shown as "(not set)"). */
  includeMissing?: boolean;
  limit?: number;
}

export interface ReportRequest extends ReportBase, ReportSpec {}

export interface ReportRow {
  g1?: string;
  g2?: string;
  /** Wheels sold: a wheelset counts as 2, a single front or rear wheel as 1, anything else as 0. */
  wheels: number;
  units: number;
  orders: number;
  revenue: number;
  line_items: number;
}

export interface ReportResult {
  rows: ReportRow[];
  totals: ReportRow;
}

export interface Statement {
  sql: string;
  params: unknown[];
}

/** Where each grouped dimension's value comes from: a column of the line item read, or its properties. */
type Source = { column: string; store?: boolean } | { dimId: number } | { prop: string };

export interface ReportPlan {
  /** Run these in one batch, in order, and hand the rows of each to finishReports: the line items, the stores, and (when attributes are used) the two mapping tables. */
  statements: Statement[];
  /** Every dimension the reports and attribute filters use, each worked out once per line item. */
  sources: Source[];
  /** Per report: which sources it groups by, and whether a line item without a value is left out. */
  specs: Array<{ group: number[]; required: boolean[]; time: boolean; limit: number }>;
  /** Attribute filters, applied to the rows read: the source and the folded values it accepts. */
  attributeFilters: Array<{ source: number; accept: Set<string> }>;
  hasProps: boolean;
  /** The read starts from the first attribute filter's matches, which can list a line item twice. */
  startsFromFilter: boolean;
}

/** The most reports one request can ask for. */
export const MAX_REPORTS = 40;

export const TIME_DIMS = ["day", "week", "month", "quarter", "year"] as const;

/** `optional` dimensions have no value for some line items, which are left out when grouping unless asked for. */
export const BUILTIN_DIMS: Array<{ id: string; label: string; group: string; sql: string; optional?: boolean }> = [
  // The store's id. Its label is filled in from the stores table in the Worker (see STORES).
  { id: "store", label: "Store", group: "Order", sql: "li.store_id" },
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

/**
 * Store labels and conversion rates. Read once per request and applied in the Worker, which is
 * cheaper than joining the stores table to every order, and one less join for SQLite to plan.
 */
const STORES = "SELECT id, label, fx_rate FROM stores";
/** Which property keys feed which attribute, and the values combined by hand. Both are small tables. */
const DIMENSION_KEYS = "SELECT key, dimension_id FROM dimension_keys ORDER BY dimension_id, key";
const VALUE_GROUPS = "SELECT dimension_id, value, label FROM value_groups";

function source(id: string): Source | null {
  if (id.startsWith("dim:")) {
    const dimId = Number(id.slice(4));
    if (!Number.isInteger(dimId)) throw new ReportError(`Unknown dimension ${id}`);
    return { dimId };
  }
  if (id.startsWith("prop:")) return { prop: id.slice(5) };
  return null;
}

/**
 * Plans one read of the line items that match `base`, carrying what every report in `specs` needs.
 * Built-in dimensions are worked out in SQL and attributes from the line item's properties, which
 * come back as one JSON object per line item.
 */
export function planReports(base: ReportBase, specs: ReportSpec[]): ReportPlan {
  if (!Array.isArray(specs) || !specs.length) throw new ReportError("Nothing to report");
  if (specs.length > MAX_REPORTS) throw new ReportError(`At most ${MAX_REPORTS} reports per request`);

  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `?${params.length}`;
  };
  const builtin = (id: string) => {
    const b = BUILTIN_DIMS.find((d) => d.id === id);
    if (!b) throw new ReportError(`Unknown dimension ${id}`);
    return b;
  };

  // Each dimension is read once per line item, however many reports use it.
  const sources: Source[] = [];
  const slots = new Map<string, number>();
  const columns = new Map<string, string>();
  let hasProps = false;
  const slotOf = (id: string): number => {
    let slot = slots.get(id);
    if (slot === undefined) {
      const attribute = source(id);
      if (attribute) hasProps = true;
      else if (builtin(id)) columns.set(id, `b${columns.size}`);
      slots.set(id, (slot = sources.push(attribute ?? { column: columns.get(id)!, store: id === "store" }) - 1));
    }
    return slot;
  };

  const where: string[] = ["o.test = 0"];
  if (!base.includeCancelled) where.push("o.cancelled = 0");
  if (base.from) {
    if (!DAY.test(base.from)) throw new ReportError("Invalid from date");
    where.push(`o.day >= ${bind(base.from)}`);
  }
  if (base.to) {
    if (!DAY.test(base.to)) throw new ReportError("Invalid to date");
    where.push(`o.day <= ${bind(base.to)}`);
  }
  if (base.search?.trim()) {
    const like = "%" + base.search.trim().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    where.push(`(li.title LIKE ${bind(like)} ESCAPE '\\' OR li.sku LIKE ?${params.length} ESCAPE '\\')`);
  }
  const attributeFilters: ReportPlan["attributeFilters"] = [];
  let found = "";
  for (const f of base.filters ?? []) {
    if (!f?.values?.length) continue;
    const values = f.values.map(String);
    if (isAttributeDim(f.dim)) {
      // Attribute values are matched as typed and as cleaned, so a saved filter for 29" still finds 29.
      const accepted = [...new Set([...values, ...values.map(normaliseValue)])];
      const slot = slotOf(f.dim);
      // The first attribute filter decides where the read starts (see `found` below).
      if (!attributeFilters.length) {
        const src = sources[slot];
        const list = bind(JSON.stringify(accepted));
        if ("dimId" in src) {
          const dim = bind(src.dimId);
          // A value combined under a label on the Attributes page is found by that label too. The
          // values are gathered into one list first: SQLite only uses the index for a plain list.
          found = `f.key IN (SELECT key FROM dimension_keys WHERE dimension_id = ${dim})
        AND COALESCE(f.norm, f.value) COLLATE NOCASE IN (SELECT value FROM json_each((
          SELECT json_group_array(v) FROM (
            SELECT value AS v FROM json_each(${list})
            UNION ALL SELECT g.value FROM value_groups g
              WHERE g.dimension_id = ${dim} AND g.label COLLATE NOCASE IN (SELECT value FROM json_each(${list}))))))`;
        } else if ("prop" in src) {
          found = `f.key = ${bind(src.prop)} AND COALESCE(f.norm, f.value) COLLATE NOCASE IN (SELECT value FROM json_each(${list}))`;
        }
      }
      attributeFilters.push({ source: slot, accept: new Set(accepted.map(fold)) });
    } else if (f.dim === "store") {
      where.push(`li.store_id IN (SELECT id FROM stores WHERE label COLLATE NOCASE IN (SELECT value FROM json_each(${bind(JSON.stringify([...new Set(values)]))})))`);
    } else {
      where.push(`${builtin(f.dim).sql} COLLATE NOCASE IN (SELECT value FROM json_each(${bind(JSON.stringify([...new Set(values)]))}))`);
    }
  }

  const planned = specs.map((spec) => {
    const groupBy = (spec?.groupBy ?? []).slice(0, 2).map(String);
    if (new Set(groupBy).size !== groupBy.length) throw new ReportError("Group by and split by must be different");
    return {
      group: groupBy.map(slotOf),
      // A line item with no value for a grouped attribute is left out unless asked for.
      required: groupBy.map((id) => isOptionalDim(id) && !spec.includeMissing),
      time: groupBy.length > 0 && isTimeDim(groupBy[0]),
      limit: Math.min(Math.max(Number(spec.limit) || 5000, 1), 20000),
    };
  });

  const select = [
    `li.current_quantity * ${WHEELS_PER_UNIT} AS w`,
    "li.current_quantity AS u",
    "CASE WHEN li.quantity > 0 THEN li.total * li.current_quantity / li.quantity ELSE 0 END AS r",
    "li.store_id AS s",
    "li.order_id AS o",
    ...[...columns].map(([id, name]) => `${builtin(id).sql} AS ${name}`),
  ];
  const startsFromFilter = attributeFilters.length > 0;
  if (startsFromFilter) select.push("li.id AS i");
  // The line item carries a copy of its properties, so they cost no rows to read. A line item
  // whose copy was never written (NULL) has them read from line_item_props instead.
  if (hasProps) {
    select.push(`COALESCE(li.props, (SELECT json_group_object(p.key, COALESCE(p.norm, p.value)) FROM line_item_props p
      WHERE p.store_id = li.store_id AND p.line_item_id = li.id)) AS p`);
  }
  // Without an attribute filter the read is every line item in the date range. With one, it starts
  // from the line items that can match the first such filter, found by value through the
  // line_item_props_shown index, and looks each one up by key. That list is gathered first
  // (MATERIALIZED) and the joins are CROSS JOINs, which keeps SQLite to exactly that order and
  // stops it scanning orders to build a lookup filter. Every attribute filter is still applied to
  // the rows read, so the list only has to hold every line item that could match.
  const facts = startsFromFilter
    ? `WITH m AS MATERIALIZED (
      SELECT f.store_id, f.order_id, f.line_item_id FROM line_item_props f
      WHERE ${found})
    SELECT ${select.join(",\n    ")}
    FROM m
    CROSS JOIN line_items li ON li.store_id = m.store_id AND li.order_id = m.order_id AND li.id = m.line_item_id
    CROSS JOIN orders o ON o.store_id = li.store_id AND o.id = li.order_id
    WHERE ${where.join("\n      AND ")}`
    : `SELECT ${select.join(",\n    ")}
    FROM line_items li
    JOIN orders o ON o.store_id = li.store_id AND o.id = li.order_id
    WHERE ${where.join("\n      AND ")}`;

  const statements: Statement[] = [
    { sql: facts, params },
    { sql: STORES, params: [] },
  ];
  if (hasProps) statements.push({ sql: DIMENSION_KEYS, params: [] }, { sql: VALUE_GROUPS, params: [] });
  return { statements, sources, specs: planned, attributeFilters, hasProps, startsFromFilter };
}

/** Lower-cases A to Z only, which is how SQLite's NOCASE (and so the value_groups table) compares text. */
function fold(s: string): string {
  return /[A-Z]/.test(s) ? s.replace(/[A-Z]+/g, (m) => m.toLowerCase()) : s;
}

const NOT_SET = "(not set)";

/** The distinct values of one dimension, numbered. Spellings that differ only by case share a number. */
class Values {
  private ids = new Map<string, number>();
  private spellings = new Map<string, { id: number; count: number }>();
  private notSet = -1;

  id(value: string): number {
    let seen = this.spellings.get(value);
    if (!seen) {
      const key = fold(value);
      let id = this.ids.get(key);
      if (id === undefined) this.ids.set(key, (id = this.ids.size));
      this.spellings.set(value, (seen = { id, count: 0 }));
    }
    seen.count++;
    return seen.id;
  }
  /** Where line items with no value are counted. A real value spelled "(not set)" lands there too. */
  missing(): number {
    if (this.notSet < 0) this.notSet = this.id(NOT_SET);
    return this.notSet;
  }
  /** Each value under its most common spelling. */
  names(): string[] {
    const best: Array<{ name: string; count: number }> = [];
    for (const [name, { id, count }] of this.spellings) {
      const b = best[id];
      if (!b || count > b.count || (count === b.count && name < b.name)) best[id] = { name, count };
    }
    return best.map((b) => b.name);
  }
  get size(): number {
    return this.ids.size;
  }
}

interface Tally {
  ids: number[];
  wheels: number;
  units: number;
  revenue: number;
  orders: number;
  lastOrder: number;
  line_items: number;
}
const tally = (ids: number[] = []): Tally => ({ ids, wheels: 0, units: 0, revenue: 0, orders: 0, lastOrder: -1, line_items: 0 });
const totalsOf = (t: Tally) => ({ wheels: t.wheels, units: t.units, orders: t.orders, revenue: Number(t.revenue.toFixed(2)), line_items: t.line_items });
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Turns the rows of a plan's statements into its reports, in the order they were asked for.
 * Values are grouped ignoring case (A to Z). Rows are ordered by wheels then units, or by date
 * first when the report is over time.
 */
export function finishReports(plan: ReportPlan, results: unknown[][]): ReportResult[] {
  const facts = results[0] as Array<Record<string, unknown>>;
  const stores = new Map((results[1] as Array<{ id: number; label: string; fx_rate: number }>).map((st) => [st.id, st]));

  // An attribute takes the first of its keys (in name order) that the line item carries, and shows
  // the cleaned value or the label it was combined under on the Attributes page.
  const keysOf = new Map<number, string[]>();
  const labels = new Map<string, string>();
  if (plan.hasProps) {
    for (const k of results[2] as Array<{ key: string; dimension_id: number }>) {
      keysOf.set(k.dimension_id, [...(keysOf.get(k.dimension_id) ?? []), k.key]);
    }
    for (const g of results[3] as Array<{ dimension_id: number; value: string; label: string }>) labels.set(`${g.dimension_id}\n${fold(g.value)}`, g.label);
  }
  const readers = plan.sources.map((src): ((row: Record<string, unknown>, props: Record<string, string> | null) => string | null) => {
    if ("column" in src) {
      const { column } = src;
      if (src.store) return (row) => stores.get(Number(row[column]))?.label ?? null;
      return (row) => (row[column] == null ? null : String(row[column]));
    }
    if ("prop" in src) {
      const { prop } = src;
      return (_, props) => props?.[prop] ?? null;
    }
    const { dimId } = src;
    const keys = keysOf.get(dimId) ?? [];
    const shown = new Map<string, string>();
    return (_, props) => {
      if (!props) return null;
      for (const key of keys) {
        const value = props[key];
        if (value === undefined) continue;
        let label = shown.get(value);
        if (label === undefined) shown.set(value, (label = labels.get(`${dimId}\n${fold(value)}`) ?? value));
        return label;
      }
      return null;
    };
  });

  // Pass 1: every line item that passes the attribute filters, as numbers. ids[s][n] is the value
  // line item n has for source s, or -1 for none.
  const sources = plan.sources;
  const values = sources.map(() => new Values());
  const ids = sources.map(() => new Int32Array(facts.length));
  const wheels = new Float64Array(facts.length);
  const units = new Float64Array(facts.length);
  const revenue = new Float64Array(facts.length);
  const order = new Int32Array(facts.length);
  const orderNumbers = new Map<string, number>();
  const found: Array<string | null> = new Array(sources.length);
  let count = 0;
  let inOrder = true;
  // A line item with two keys of the filtered attribute can be found once for each.
  const met = new Set<string>();
  rows: for (const row of facts) {
    // A line item whose store is gone is not reported (there are none unless a delete was interrupted).
    const store = stores.get(Number(row.s));
    if (!store) continue;
    if (plan.startsFromFilter) {
      const lineItem = `${row.s}:${row.i}`;
      if (met.has(lineItem)) continue;
      met.add(lineItem);
    }
    const props = plan.hasProps && row.p && row.p !== "{}" ? (JSON.parse(row.p as string) as Record<string, string>) : null;
    for (let s = 0; s < sources.length; s++) found[s] = readers[s](row, props);
    for (const f of plan.attributeFilters) {
      const v = found[f.source];
      if (v === null || !f.accept.has(fold(v))) continue rows;
    }
    for (let s = 0; s < sources.length; s++) ids[s][count] = found[s] === null ? -1 : values[s].id(found[s]!);
    const orderKey = `${row.s}:${row.o}`;
    let number = orderNumbers.get(orderKey);
    if (number === undefined) orderNumbers.set(orderKey, (number = orderNumbers.size));
    else if (number !== order[count - 1]) inOrder = false;
    order[count] = number;
    wheels[count] = Number(row.w) || 0;
    units[count] = Number(row.u) || 0;
    // Revenue is in the store's currency until its conversion rate is applied.
    revenue[count] = (Number(row.r) || 0) * store.fx_rate;
    count++;
  }
  // Orders are counted by noticing when the order changes, so an order's line items must sit together.
  // They do in the order the database reads them; if that ever changes, put them together here.
  const sequence = Array.from({ length: count }, (_, n) => n);
  if (!inOrder) sequence.sort((a, b) => order[a] - order[b]);

  // Pass 2: one loop over those line items per report.
  return plan.specs.map((spec) => {
    const [first, second] = spec.group;
    const missing = spec.group.map((s, n) => (spec.required[n] ? -1 : values[s].missing()));
    const width = second === undefined ? 1 : values[second].size + 1;
    const groups = new Map<number, Tally>();
    const totals = tally();
    const add = (t: Tally, n: number) => {
      t.wheels += wheels[n];
      t.units += units[n];
      t.revenue += revenue[n];
      t.line_items++;
      if (t.lastOrder !== order[n]) {
        t.lastOrder = order[n];
        t.orders++;
      }
    };
    for (const n of sequence) {
      if (first !== undefined) {
        let a = ids[first][n];
        if (a < 0 && (a = missing[0]) < 0) continue;
        let b = 0;
        if (second !== undefined) {
          b = ids[second][n];
          if (b < 0 && (b = missing[1]) < 0) continue;
        }
        const key = a * width + b;
        let group = groups.get(key);
        if (!group) groups.set(key, (group = tally(second === undefined ? [a] : [a, b])));
        add(group, n);
      }
      add(totals, n);
    }

    const total = totalsOf(totals);
    // With nothing to group by, the one row is the total.
    if (first === undefined) return { rows: [total], totals: total };
    const names = spec.group.map((s) => values[s].names());
    const rows = [...groups.values()].map((t): ReportRow => {
      const row: ReportRow = { g1: names[0][t.ids[0]], ...totalsOf(t) };
      if (second !== undefined) row.g2 = names[1][t.ids[1]];
      return row;
    });
    rows.sort((a, b) => (spec.time ? compare(a.g1!, b.g1!) : 0) || b.wheels - a.wheels || b.units - a.units);
    return { rows: rows.slice(0, spec.limit), totals: total };
  });
}
