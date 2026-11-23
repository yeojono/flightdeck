export interface Dim {
  id: string;
  label: string;
  group: string;
  mapped: boolean;
}
export interface StoreSummary {
  id: number;
  label: string;
  currency: string | null;
  fx_rate: number;
}
export interface Meta {
  dimensions: Dim[];
  stores: StoreSummary[];
  range: { first_day: string | null; last_day: string | null; orders: number };
  reportingCurrency: string;
}
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
  includeMissing?: boolean;
  limit?: number;
}
export interface Row {
  g1?: string;
  g2?: string;
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
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    if (res.status === 401 && path !== "/login") onUnauthorised();
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

export const runReport = (req: ReportRequest, signal?: AbortSignal) => api<Report>("/report", { body: req, signal });
