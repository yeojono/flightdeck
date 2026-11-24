export interface Dim {
  id: string;
  label: string;
  group: string;
  mapped: boolean;
  /** Some line items have no value for it (attributes, wheel type). */
  optional?: boolean;
}
export interface StoreSummary {
  id: number;
  label: string;
  currency: string | null;
  fx_rate: number;
  /** Imported before the current tag or cleaning rules: its next sync re-imports everything. */
  needs_resync: number;
}
export interface Meta {
  dimensions: Dim[];
  stores: StoreSummary[];
  range: { first_day: string | null; last_day: string | null; orders: number };
  reportingCurrency: string;
  /** Only orders with this Shopify tag are imported. Null imports every order. */
  orderTag: string | null;
}
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
  includeMissing?: boolean;
  limit?: number;
}
export interface ReportRequest extends ReportBase, ReportSpec {}
export interface Row {
  g1?: string;
  g2?: string;
  /** Wheels sold: a wheelset counts as 2, a single front or rear wheel as 1, anything else as 0. */
  wheels: number;
  units: number;
  orders: number;
  revenue: number;
  line_items: number;
}
export interface Report {
  rows: Row[];
  totals: Row | null;
}
export interface Store {
  id: number;
  shop: string;
  label: string;
  client_id: string;
  scopes: string | null;
  shop_name: string | null;
  currency: string | null;
  timezone: string | null;
  fx_rate: number;
  sync_cursor: string | null;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  order_count: number;
  first_day: string | null;
  needs_resync: number;
}
export interface Run {
  id: number;
  store_id: number;
  store_label: string;
  kind: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  orders: number;
  line_items: number;
  bytes_done: number;
  bytes_total: number;
  message: string | null;
}
export interface AttributeKey {
  key: string;
  line_items: number;
  stores: number;
  distinct_values: number;
  dimension_id: number | null;
}
export interface Dimension {
  id: number;
  name: string;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

let onUnauthorised: () => void = () => {};
export function setUnauthorisedHandler(fn: () => void) {
  onUnauthorised = fn;
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: init?.body !== undefined || (init?.method && init.method !== "GET") ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : init?.method && init.method !== "GET" ? "{}" : undefined,
    signal: init?.signal,
    credentials: "same-origin",
    // When the Cloudflare Access session expires, Access answers with a redirect to its sign-in page.
    // Following it from fetch() would fail on CORS, so stop and treat it as signed out instead.
    redirect: "manual",
  });
  if (res.type === "opaqueredirect") {
    onUnauthorised();
    throw new ApiError("Your sign-in has expired. Reload the page to sign in again.", 401);
  }
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    if (res.status === 401) onUnauthorised();
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

/** Several reports over the same filters in one request, which the server answers from one read of the data. */
export const runReports = (base: ReportBase, reports: ReportSpec[], signal?: AbortSignal) =>
  api<{ reports: Report[] }>("/reports", { body: { ...base, reports }, signal }).then((r) => r.reports);
export const runReport = ({ groupBy, includeMissing, limit, ...base }: ReportRequest, signal?: AbortSignal) =>
  runReports(base, [{ groupBy, includeMissing, limit }], signal).then((r) => r[0]);
