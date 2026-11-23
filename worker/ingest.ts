import type { Env } from "./env";
import { orderTag } from "./shopify";
import { RULES_VERSION, normColumn, wheelKind } from "./wheels";

/**
 * Turns Shopify bulk-export JSONL into rows and writes them to D1.
 *
 * The export is one JSON object per line. Each order is followed by its line items,
 * one per line, with a `__parentId` pointing at the order.
 */

export interface Parsed {
  orderIds: number[];
  orders: unknown[][];
  lineItems: unknown[][];
  props: unknown[][];
  /** Orders that came with a country, used to detect missing address access. */
  withAddress: number;
  /** Orders in the export that do not carry the required tag. Any copy already imported is removed. */
  untaggedIds: number[];
  /** The last order seen, for the next chunk: its line items may start there. */
  carry: Carry | null;
}

/** An order's line items follow it in the export, so a chunk can end between an order and its line items. */
export interface Carry {
  orderId: number;
  kept: boolean;
}

export interface ParseOptions {
  /** Only keep orders with this tag (matched whole, ignoring case). Empty keeps every order. */
  tag?: string | null;
  /** The carry returned for the previous chunk of the same export. */
  carry?: Carry | null;
}

/**
 * What decides which orders a store holds and how their values were cleaned. A store whose data was
 * imported under a different scope (another tag, older rules) gets a full resync at its next sync.
 */
export function importScope(env: Pick<Env, "ORDER_TAG">): string {
  return `tag:${orderTag(env).toLowerCase()}|rules:${RULES_VERSION}`;
}

export function hasTag(tags: unknown, tag: string): boolean {
  const want = tag.trim().toLowerCase();
  // The bulk export gives a list; a comma separated string is accepted too.
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  return list.some((t) => String(t).trim().toLowerCase() === want);
}

const MAX_VALUE_LENGTH = 500;

export function gidToNumber(gid: unknown): number | null {
  if (typeof gid !== "string") return null;
  const tail = gid.slice(gid.lastIndexOf("/") + 1).split("?")[0];
  const n = Number(tail);
  return Number.isSafeInteger(n) ? n : null;
}

/** Property keys are matched case-insensitively and ignoring extra spaces or a trailing colon. */
export function normaliseKey(key: unknown): string {
  return String(key ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*:$/, "")
    .toLowerCase();
}

/** Returns a function mapping an ISO timestamp to YYYY-MM-DD in the given IANA timezone. */
export function makeDayFormatter(timeZone: string | null): (iso: string) => string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  return (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    const parts = fmt.formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
}

function money(set: any): number {
  const n = Number(set?.shopMoney?.amount);
  return Number.isFinite(n) ? n : 0;
}

export function parseJsonl(text: string, dayOf: (iso: string) => string, opts: ParseOptions = {}): Parsed {
  const out: Parsed = { orderIds: [], orders: [], lineItems: [], props: [], withAddress: 0, untaggedIds: [], carry: opts.carry ?? null };
  const tag = opts.tag?.trim() || null;
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl === -1) nl = text.length;
    const line = text.slice(pos, nl).trim();
    pos = nl + 1;
    if (!line) continue;
    const obj = JSON.parse(line);
    const gid: string = obj.id ?? "";

    if (gid.includes("/Order/")) {
      const id = gidToNumber(gid);
      if (id === null) continue;
      const kept = !tag || hasTag(obj.tags, tag);
      out.carry = { orderId: id, kept };
      if (!kept) {
        out.untaggedIds.push(id);
        continue;
      }
      const addr = [obj.shippingAddress, obj.billingAddress].find((a) => a && (a.countryCodeV2 || a.country)) ?? null;
      if (addr) out.withAddress++;
      out.orderIds.push(id);
      out.orders.push([
        id,
        obj.name ?? null,
        obj.createdAt,
        dayOf(obj.createdAt),
        obj.cancelledAt ? 1 : 0,
        obj.test ? 1 : 0,
        obj.currencyCode ?? null,
        obj.displayFinancialStatus ?? null,
        obj.sourceName ?? null,
        addr?.provinceCode ?? null,
        addr?.province ?? null,
        addr?.countryCodeV2 ?? null,
        addr?.country ?? null,
      ]);
    } else if (gid.includes("/LineItem/")) {
      const id = gidToNumber(gid);
      const orderId = gidToNumber(obj.__parentId);
      if (id === null || orderId === null) continue;
      if (out.carry?.orderId === orderId && !out.carry.kept) continue;
      const quantity = Number(obj.quantity) || 0;
      const attrs: Array<[string, string]> = [];
      const seen = new Set<string>();
      for (const attr of obj.customAttributes ?? []) {
        const key = normaliseKey(attr?.key);
        const value = String(attr?.value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_LENGTH);
        if (!key || !value || seen.has(key)) continue;
        seen.add(key);
        attrs.push([key, value]);
      }
      // Whether this is a wheelset or a single wheel decides how some of its values are read.
      const kind = wheelKind(obj.title, obj.variantTitle);
      out.lineItems.push([
        id,
        orderId,
        obj.title ?? null,
        obj.variantTitle ?? null,
        obj.sku ?? null,
        obj.vendor ?? null,
        gidToNumber(obj.product?.id),
        obj.product?.productType ?? null,
        quantity,
        obj.currentQuantity == null ? quantity : Number(obj.currentQuantity) || 0,
        money(obj.originalUnitPriceSet),
        money(obj.discountedTotalSet),
        kind,
      ]);
      for (const [key, value] of attrs) out.props.push([id, key, value, orderId, normColumn(key, value, kind)]);
    }
  }
  return out;
}

function slices<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const col = (i: number) => `json_extract(value, '$[${i}]')`;
const cols = (n: number) => Array.from({ length: n }, (_, i) => col(i)).join(", ");

/** ?3 is the sync run writing the row, which is how a full resync knows which orders it did not see. */
export const INSERT_ORDERS = `INSERT OR REPLACE INTO orders
  (store_id, id, name, created_at, day, cancelled, test, currency, financial_status, source_name, province_code, province, country_code, country, run_id)
  SELECT ?1, ${cols(13)}, ?3 FROM json_each(?2)`;

export const INSERT_LINE_ITEMS = `INSERT OR REPLACE INTO line_items
  (store_id, id, order_id, title, variant_title, sku, vendor, product_id, product_type, quantity, current_quantity, unit_price, total, wheel_kind)
  SELECT ?1, ${cols(13)} FROM json_each(?2)`;

export const INSERT_PROPS = `INSERT OR REPLACE INTO line_item_props
  (store_id, line_item_id, key, value, order_id, norm)
  SELECT ?1, ${cols(5)} FROM json_each(?2)`;

export const DELETE_ORDER_PROPS = `DELETE FROM line_item_props WHERE store_id = ?1 AND order_id IN (SELECT value FROM json_each(?2))`;
export const DELETE_ORDER_LINES = `DELETE FROM line_items WHERE store_id = ?1 AND order_id IN (SELECT value FROM json_each(?2))`;
export const DELETE_ORDERS = `DELETE FROM orders WHERE store_id = ?1 AND id IN (SELECT value FROM json_each(?2))`;

/**
 * Run in this order after a full resync (?1 store, ?2 run): removes every order the run did not
 * write, with its line items. That covers orders deleted in Shopify and orders that no longer
 * carry the required tag, without emptying the store while the resync runs.
 */
const NOT_THIS_RUN = `SELECT id FROM orders WHERE store_id = ?1 AND run_id IS NOT ?2`;
export const SWEEP_UNSEEN = [
  `DELETE FROM line_item_props WHERE store_id = ?1 AND order_id IN (${NOT_THIS_RUN})`,
  `DELETE FROM line_items WHERE store_id = ?1 AND order_id IN (${NOT_THIS_RUN})`,
  `DELETE FROM orders WHERE store_id = ?1 AND run_id IS NOT ?2`,
];

/**
 * Writes one parsed chunk in a single D1 batch (one transaction). Rows are passed as
 * JSON arrays and expanded with json_each, which keeps each statement to two bound
 * parameters regardless of row count. Safe to re-run for the same chunk.
 */
export async function writeParsed(db: D1Database, storeId: number, runId: number, p: Parsed): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  // Orders in this chunk are being replaced, so drop their old line items first.
  for (const ids of slices(p.orderIds, 5000)) {
    const json = JSON.stringify(ids);
    stmts.push(db.prepare(DELETE_ORDER_PROPS).bind(storeId, json));
    stmts.push(db.prepare(DELETE_ORDER_LINES).bind(storeId, json));
  }
  // An order that lost its tag since it was imported goes entirely.
  for (const ids of slices(p.untaggedIds, 5000)) {
    const json = JSON.stringify(ids);
    stmts.push(db.prepare(DELETE_ORDER_PROPS).bind(storeId, json));
    stmts.push(db.prepare(DELETE_ORDER_LINES).bind(storeId, json));
    stmts.push(db.prepare(DELETE_ORDERS).bind(storeId, json));
  }
  for (const rows of slices(p.orders, 1000)) stmts.push(db.prepare(INSERT_ORDERS).bind(storeId, JSON.stringify(rows), runId));
  for (const rows of slices(p.lineItems, 1000)) stmts.push(db.prepare(INSERT_LINE_ITEMS).bind(storeId, JSON.stringify(rows)));
  for (const rows of slices(p.props, 2000)) stmts.push(db.prepare(INSERT_PROPS).bind(storeId, JSON.stringify(rows)));
  if (stmts.length) await db.batch(stmts);
}

/**
 * Finds where to cut a byte chunk so it ends on a line boundary.
 * Returns the number of bytes that hold complete lines, or -1 if there is no newline.
 */
export function completeLineBytes(buf: Uint8Array, isLastChunk: boolean): number {
  if (isLastChunk) return buf.length;
  return buf.lastIndexOf(10) + 1 || -1;
}
