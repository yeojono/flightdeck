import { useEffect, useRef, useState } from "react";
import { type Report, type ReportFilter, type ReportRequest, type Row, runReport } from "./api";

// ---------- Metrics & formatting ----------

export type Metric = "wheels" | "orders" | "revenue" | "units";
export const METRICS: Array<{ id: Metric; label: string }> = [
  { id: "wheels", label: "Wheels" },
  { id: "orders", label: "Orders" },
  { id: "revenue", label: "Revenue" },
  // Every product counted once per unit, accessories included. Kept for things like tyres and tape.
  { id: "units", label: "Units" },
];
export const metricLabel = (m: Metric) => METRICS.find((x) => x.id === m)?.label ?? m;

const nf = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-AU", { notation: "compact", maximumFractionDigits: 1 });

export function formatValue(v: number, metric: Metric, currency: string): string {
  if (metric !== "revenue") return nf.format(v ?? 0);
  try {
    return new Intl.NumberFormat("en-AU", { style: "currency", currency, maximumFractionDigits: 0 }).format(v ?? 0);
  } catch {
    return nf.format(v ?? 0);
  }
}
export function formatAxis(v: number): string {
  return Math.abs(v) >= 10000 ? compact.format(v) : nf.format(v);
}
export function formatCompact(v: number, metric: Metric, currency: string): string {
  if (Math.abs(v) < 10000) return formatValue(v, metric, currency);
  if (metric !== "revenue") return compact.format(v);
  try {
    return new Intl.NumberFormat("en-AU", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(v);
  } catch {
    return compact.format(v);
  }
}
export function percent(part: number, whole: number): string {
  if (!whole) return "";
  const p = (part / whole) * 100;
  return `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
}
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------- Filter state (shared by Overview and Explore) ----------

export type Preset = "30d" | "90d" | "12m" | "ytd" | "all" | "custom";
export const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "12m", label: "Last 12 months" },
  { id: "ytd", label: "Year to date" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom range" },
];

export interface FilterState {
  preset: Preset;
  from: string;
  to: string;
  filters: ReportFilter[];
  search: string;
  includeCancelled: boolean;
}
export const DEFAULT_FILTERS: FilterState = {
  preset: "12m",
  from: "",
  to: "",
  filters: [
    { dim: "store", values: [] },
    { dim: "wheel_type", values: [] },
    { dim: "country", values: [] },
    { dim: "province", values: [] },
  ],
  search: "",
  includeCancelled: false,
};

/** Filters saved before a pinned filter existed do not have it yet: put it back in its usual place. */
export function withPinned(f: FilterState): FilterState {
  const have = new Set(f.filters.map((x) => x.dim));
  if (DEFAULT_FILTERS.filters.every((p) => have.has(p.dim))) return f;
  const pinned = DEFAULT_FILTERS.filters.map((p) => f.filters.find((x) => x.dim === p.dim) ?? p);
  return { ...f, filters: [...pinned, ...f.filters.filter((x) => !pinned.some((p) => p.dim === x.dim))] };
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function dateRange(f: FilterState): { from: string | null; to: string | null } {
  const today = new Date();
  const back = (days: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - days);
    return iso(d);
  };
  switch (f.preset) {
    case "30d":
      return { from: back(29), to: null };
    case "90d":
      return { from: back(89), to: null };
    case "12m": {
      const d = new Date(today.getFullYear() - 1, today.getMonth(), 1);
      return { from: iso(d), to: null };
    }
    case "ytd":
      return { from: `${today.getFullYear()}-01-01`, to: null };
    case "custom":
      return { from: f.from || null, to: f.to || null };
    default:
      return { from: null, to: null };
  }
}

/** A sensible time bucket for the selected range. */
export function timeGrain(f: FilterState): "day" | "week" | "month" {
  if (f.preset === "30d") return "day";
  if (f.preset === "90d") return "week";
  if (f.preset === "custom" && f.from) {
    const days = (new Date(f.to || Date.now()).getTime() - new Date(f.from).getTime()) / 86400000;
    return days <= 45 ? "day" : days <= 200 ? "week" : "month";
  }
  return "month";
}

export function toRequest(f: FilterState, extra: Partial<ReportRequest> & { groupBy: string[] }): ReportRequest {
  return {
    ...dateRange(f),
    filters: f.filters.filter((x) => x.values.length),
    search: f.search || null,
    includeCancelled: f.includeCancelled,
    ...extra,
  };
}

// ---------- Hooks ----------

export function useStored<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...(initial as object), ...JSON.parse(raw) } : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: keep in memory only */
    }
  }, [key, value]);
  return [value, setValue];
}

/** Runs a report whenever the request changes. Keeps the previous result on screen while reloading. */
export function useReport(req: ReportRequest | null): { data: Report | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ data: Report | null; loading: boolean; error: string | null }>({ data: null, loading: !!req, error: null });
  const key = req ? JSON.stringify(req) : "";
  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    // Short delay so typing in a filter does not fire a request per keystroke.
    const timer = setTimeout(() => {
      runReport(JSON.parse(key), ctrl.signal)
        .then((data) => setState({ data, loading: false, error: null }))
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          setState({ data: null, loading: false, error: err.message });
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [key]);
  return state;
}

export function useTheme(): Theme {
  const [dark, setDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return dark ? DARK : LIGHT;
}

// ---------- Chart theme ----------

export interface Theme {
  dark: boolean;
  surface: string;
  text: string;
  textSecondary: string;
  muted: string;
  grid: string;
  axis: string;
  series: string[];
  other: string;
  /** Sequential ramp, light to dark, for heatmaps. */
  ramp: string[];
}
const RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];
export const LIGHT: Theme = {
  dark: false,
  surface: "#fcfcfb",
  text: "#0b0b0b",
  textSecondary: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  other: "#c3c2b7",
  ramp: RAMP,
};
export const DARK: Theme = {
  dark: true,
  surface: "#1a1a19",
  text: "#f0efec",
  textSecondary: "#c3c2b7",
  muted: "#898781",
  grid: "#2c2c2a",
  axis: "#383835",
  series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767"],
  other: "#52514e",
  ramp: [...RAMP].reverse(),
};

export const OTHER = "Other";
export const MAX_SERIES = 7;

/**
 * Keeps each series on the same colour slot while filters change, so a value does not
 * change colour just because its rank moved. Slots are only reused when a value drops out.
 */
export function useStableSlots(scope: string, names: string[]): Map<string, number> {
  const ref = useRef<{ scope: string; slots: Map<string, number> }>({ scope, slots: new Map() });
  if (ref.current.scope !== scope) ref.current = { scope, slots: new Map() };
  const prev = ref.current.slots;
  const next = new Map<string, number>();
  const used = new Set<number>();
  for (const n of names) {
    const s = prev.get(n);
    if (s !== undefined && !used.has(s)) {
      next.set(n, s);
      used.add(s);
    }
  }
  let free = 0;
  for (const n of names) {
    if (next.has(n)) continue;
    while (used.has(free)) free++;
    next.set(n, free);
    used.add(free);
  }
  ref.current.slots = next;
  return next;
}

// ---------- Shaping report rows for charts ----------

export interface Shaped {
  /** One entry per primary group, with a value per series. */
  data: Array<Record<string, number | string>>;
  series: string[];
  total: number;
  foldedGroups: number;
}

export function shape(rows: Row[], metric: Metric, opts: { time: boolean; split: boolean; topN: number }): Shaped {
  const g1Totals = new Map<string, number>();
  const g2Totals = new Map<string, number>();
  for (const r of rows) {
    const v = Number(r[metric]) || 0;
    g1Totals.set(r.g1 ?? "", (g1Totals.get(r.g1 ?? "") ?? 0) + v);
    if (opts.split) g2Totals.set(r.g2 ?? "", (g2Totals.get(r.g2 ?? "") ?? 0) + v);
  }
  const rank = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  let groups = opts.time ? [...g1Totals.keys()].sort() : rank(g1Totals);
  let folded = 0;
  if (!opts.time && groups.length > opts.topN) {
    folded = groups.length - opts.topN;
    groups = groups.slice(0, opts.topN);
  }
  const keep1 = new Set(groups);

  let series = ["value"];
  let keep2 = new Set<string>();
  if (opts.split) {
    const ranked = rank(g2Totals);
    series = ranked.slice(0, MAX_SERIES);
    keep2 = new Set(series);
    if (ranked.length > MAX_SERIES) series.push(OTHER);
  }

  const index = new Map<string, Record<string, number | string>>();
  for (const g of groups) index.set(g, { name: g });
  if (folded) index.set(OTHER, { name: OTHER });
  let total = 0;
  for (const r of rows) {
    const v = Number(r[metric]) || 0;
    total += v;
    const row = index.get(keep1.has(r.g1 ?? "") ? (r.g1 ?? "") : OTHER);
    if (!row) continue;
    const s = opts.split ? (keep2.has(r.g2 ?? "") ? (r.g2 ?? "") : OTHER) : "value";
    row[s] = ((row[s] as number) ?? 0) + v;
  }
  const data = [...index.values()];
  for (const d of data) for (const s of series) d[s] ??= 0;
  return { data, series, total, foldedGroups: folded };
}

// ---------- CSV ----------

function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets treating values as formulas
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function downloadCsv(filename: string, header: string[], rows: unknown[][]) {
  const text = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
