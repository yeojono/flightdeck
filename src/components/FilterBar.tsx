import { useEffect, useMemo, useRef, useState } from "react";
import { type Dim, type Meta, runReport } from "../api";
import { DEFAULT_FILTERS, type FilterState, PRESETS, type Preset } from "../lib";

interface Option {
  value: string;
  count: number;
}

const optionCache = new Map<string, Promise<Option[]>>();
export function clearOptionCache() {
  optionCache.clear();
}
function loadOptions(dim: string): Promise<Option[]> {
  let p = optionCache.get(dim);
  if (!p) {
    p = runReport({ groupBy: [dim], limit: 500, includeCancelled: true }).then((r) => r.rows.map((x) => ({ value: x.g1 ?? "", count: x.units })));
    p.catch(() => optionCache.delete(dim));
    optionCache.set(dim, p);
  }
  return p;
}

function MultiSelect({ label, dim, values, onChange, onRemove }: { label: string; dim: string; values: string[]; onChange: (v: string[]) => void; onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Option[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    loadOptions(dim).then(setOptions, (e) => setError(e.message));
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, dim]);

  const selected = new Set(values.map((v) => v.toLowerCase()));
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (options ?? []).filter((o) => !q || o.value.toLowerCase().includes(q));
  }, [options, query]);
  const toggle = (v: string) => onChange(selected.has(v.toLowerCase()) ? values.filter((x) => x.toLowerCase() !== v.toLowerCase()) : [...values, v]);
  const summary = values.length === 0 ? "All" : values.length === 1 ? values[0] : `${values[0]} +${values.length - 1}`;

  return (
    <div className="ms" ref={ref}>
      <button type="button" className={`ms-button${values.length ? " active" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="ms-label">{label}</span>
        <span className="ms-value">{summary}</span>
        <span className="caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="ms-pop" role="dialog" aria-label={`Filter by ${label}`}>
          {/* Enter here is not a request to run the query. */}
          <input
            autoFocus
            placeholder={`Search ${label.toLowerCase()}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
          />
          <div className="ms-list">
            {error && <div className="ms-note">{error}</div>}
            {!options && !error && <div className="ms-note">Loading…</div>}
            {options && !shown.length && <div className="ms-note">No values found</div>}
            {shown.map((o) => (
              <label key={o.value} className="ms-option">
                <input type="checkbox" checked={selected.has(o.value.toLowerCase())} onChange={() => toggle(o.value)} />
                <span className="ms-option-name" title={o.value}>
                  {o.value}
                </span>
                <span className="ms-count">{o.count.toLocaleString()}</span>
              </label>
            ))}
          </div>
          <div className="ms-foot">
            <button type="button" className="link" onClick={() => onChange([])} disabled={!values.length}>
              Clear
            </button>
            {onRemove && (
              <button type="button" className="link" onClick={onRemove}>
                Remove filter
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const PINNED = new Set(DEFAULT_FILTERS.filters.map((f) => f.dim));
const TIME = new Set(["day", "week", "month", "quarter", "year"]);

export function DimOptions({ dims, exclude }: { dims: Dim[]; exclude?: (d: Dim) => boolean }) {
  const groups = new Map<string, Dim[]>();
  for (const d of dims) {
    if (exclude?.(d)) continue;
    groups.set(d.group, [...(groups.get(d.group) ?? []), d]);
  }
  return (
    <>
      {[...groups.entries()].map(([g, list]) => (
        <optgroup key={g} label={g}>
          {list.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

const fields = (f: FilterState) => JSON.stringify([f.preset, f.from, f.to, f.filters.map((x) => [x.dim, x.values]), f.search, f.includeCancelled]);

/**
 * The filter form. Changing it does not run anything: `state` is the form as it stands, `applied`
 * is what the reports on screen were run with, and Run query (or Enter) runs them with the form.
 * The button is only enabled while the two differ.
 */
export function FilterBar({ meta, state, onChange, applied, onRun }: { meta: Meta; state: FilterState; onChange: (s: FilterState) => void; applied: FilterState; onRun: () => void }) {
  const changed = fields(state) !== fields(applied);
  const labelOf = (id: string) => meta.dimensions.find((d) => d.id === id)?.label ?? id.replace(/^prop:/, "");
  const setFilter = (dim: string, values: string[]) => onChange({ ...state, filters: state.filters.map((f) => (f.dim === dim ? { ...f, values } : f)) });
  const active = state.filters.some((f) => f.values.length) || state.search || state.includeCancelled;
  const used = new Set(state.filters.map((f) => f.dim));

  return (
    <form
      className="filters"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onRun();
      }}
    >
      <select className="control" value={state.preset} onChange={(e) => onChange({ ...state, preset: e.target.value as Preset })} aria-label="Date range">
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      {state.preset === "custom" && (
        <>
          <input className="control" type="date" value={state.from} max={state.to || undefined} onChange={(e) => onChange({ ...state, from: e.target.value })} aria-label="From date" />
          <input className="control" type="date" value={state.to} min={state.from || undefined} onChange={(e) => onChange({ ...state, to: e.target.value })} aria-label="To date" />
        </>
      )}
      {state.filters.map((f) => (
        <MultiSelect
          key={f.dim}
          dim={f.dim}
          label={labelOf(f.dim)}
          values={f.values}
          onChange={(v) => setFilter(f.dim, v)}
          onRemove={PINNED.has(f.dim) ? undefined : () => onChange({ ...state, filters: state.filters.filter((x) => x.dim !== f.dim) })}
        />
      ))}
      <select
        className="control add"
        value=""
        onChange={(e) => e.target.value && onChange({ ...state, filters: [...state.filters, { dim: e.target.value, values: [] }] })}
        aria-label="Add a filter"
      >
        <option value="">+ Add filter</option>
        <DimOptions dims={meta.dimensions} exclude={(d) => used.has(d.id) || TIME.has(d.id) || !d.mapped} />
      </select>
      <input className="control search" type="search" placeholder="Product name or SKU" value={state.search} onChange={(e) => onChange({ ...state, search: e.target.value })} />
      <label className="check">
        <input type="checkbox" checked={state.includeCancelled} onChange={(e) => onChange({ ...state, includeCancelled: e.target.checked })} />
        Include cancelled
      </label>
      {active && (
        <button type="button" className="link" onClick={() => onChange({ ...DEFAULT_FILTERS, preset: state.preset, from: state.from, to: state.to })}>
          Reset
        </button>
      )}
      <button type="submit" className="primary" disabled={!changed} title={changed ? undefined : "Change a filter to run the query again"}>
        Run query
      </button>
    </form>
  );
}
