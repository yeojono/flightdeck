import { useMemo, useState } from "react";
import type { AppContext } from "../App";
import { Heatmap, ReportChart, formatBucket } from "../components/Charts";
import { DimOptions, FilterBar } from "../components/FilterBar";
import { METRICS, type Metric, downloadCsv, formatValue, percent, toRequest, useReport, useStored, useTheme } from "../lib";

interface ExploreState {
  metric: Metric;
  groupBy: string;
  splitBy: string;
  topN: number;
  view: "chart" | "heatmap" | "table";
  includeMissing: boolean;
}
const TIME = new Set(["day", "week", "month", "quarter", "year"]);
const isAttr = (id: string) => id.startsWith("dim:") || id.startsWith("prop:");
const TABLE_LIMIT = 500;

export function Explore({ meta, filters, setFilters }: AppContext) {
  const theme = useTheme();
  const firstAttr = meta.dimensions.find((d) => d.group === "Attributes" && d.mapped)?.id ?? "product";
  const [state, setState] = useStored<ExploreState>("wi.explore", { metric: "wheels", groupBy: firstAttr, splitBy: "", topN: 15, view: "chart", includeMissing: false });
  const [sortDesc, setSortDesc] = useState(true);

  // Saved state can point at a dimension that no longer exists.
  const known = (id: string) => meta.dimensions.some((d) => d.id === id);
  const groupBy = known(state.groupBy) ? state.groupBy : firstAttr;
  const splitBy = state.splitBy && known(state.splitBy) && state.splitBy !== groupBy ? state.splitBy : "";
  const time = TIME.has(groupBy);
  const view = state.view === "heatmap" && (!splitBy || time) ? "chart" : state.view;
  const label = (id: string) => meta.dimensions.find((d) => d.id === id)?.label ?? id;
  const set = (patch: Partial<ExploreState>) => setState((s) => ({ ...s, ...patch }));

  const request = toRequest(filters, { groupBy: splitBy ? [groupBy, splitBy] : [groupBy], includeMissing: state.includeMissing, limit: 20000 });
  const { data, loading, error } = useReport(request);
  const rows = data?.rows ?? [];
  // Saved state can name a metric that no longer exists.
  const metric: Metric = METRICS.some((m) => m.id === state.metric) ? state.metric : "wheels";
  const metricLabel = METRICS.find((m) => m.id === metric)!.label;
  const currency = meta.reportingCurrency;
  const total = Number(data?.totals?.[metric]) || 0;

  const sorted = useMemo(() => {
    const out = [...rows];
    if (time) out.sort((a, b) => (a.g1 ?? "").localeCompare(b.g1 ?? "") || b[metric] - a[metric]);
    else out.sort((a, b) => (sortDesc ? b[metric] - a[metric] : a[metric] - b[metric]));
    return out;
  }, [rows, metric, sortDesc, time]);

  const exportCsv = () => {
    const head = [label(groupBy), ...(splitBy ? [label(splitBy)] : []), "Wheels", "Orders", `Revenue (${currency})`, "Units", "Line items"];
    downloadCsv(
      `flightdeck-${groupBy.replace(/[^a-z0-9]+/gi, "-")}${splitBy ? "-by-" + splitBy.replace(/[^a-z0-9]+/gi, "-") : ""}.csv`,
      head,
      sorted.map((r) => [r.g1, ...(splitBy ? [r.g2] : []), r.wheels, r.orders, r.revenue, r.units, r.line_items]),
    );
  };

  return (
    <div className="page">
      <h1>Explore</h1>
      <FilterBar meta={meta} state={filters} onChange={setFilters} />

      <section className="card">
        <div className="controls">
          <label>
            Show
            <div className="segmented" role="group" aria-label="Metric">
              {METRICS.map((m) => (
                <button key={m.id} type="button" className={metric === m.id ? "on" : ""} onClick={() => set({ metric: m.id })}>
                  {m.label}
                </button>
              ))}
            </div>
          </label>
          <label>
            Group by
            <select className="control" value={groupBy} onChange={(e) => set({ groupBy: e.target.value })}>
              <DimOptions dims={meta.dimensions} exclude={(d) => !d.mapped} />
            </select>
          </label>
          <label>
            Split by
            <select className="control" value={splitBy} onChange={(e) => set({ splitBy: e.target.value })}>
              <option value="">None</option>
              <DimOptions dims={meta.dimensions} exclude={(d) => !d.mapped || d.id === groupBy || TIME.has(d.id)} />
            </select>
          </label>
          {!time && (
            <label>
              Show top
              <select className="control" value={state.topN} onChange={(e) => set({ topN: Number(e.target.value) })}>
                {[10, 15, 25, 50].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            View
            <div className="segmented" role="group" aria-label="View">
              <button type="button" className={view === "chart" ? "on" : ""} onClick={() => set({ view: "chart" })}>
                Chart
              </button>
              {splitBy && !time && (
                <button type="button" className={view === "heatmap" ? "on" : ""} onClick={() => set({ view: "heatmap" })}>
                  Heatmap
                </button>
              )}
              <button type="button" className={view === "table" ? "on" : ""} onClick={() => set({ view: "table" })}>
                Table
              </button>
            </div>
          </label>
          <button type="button" className="secondary push" onClick={exportCsv} disabled={!rows.length}>
            Export CSV
          </button>
        </div>
        {(isAttr(groupBy) || isAttr(splitBy)) && (
          <label className="check">
            <input type="checkbox" checked={state.includeMissing} onChange={(e) => set({ includeMissing: e.target.checked })} />
            Include line items that do not have this attribute
          </label>
        )}

        <header className="card-head">
          <h2>
            {metricLabel} by {label(groupBy).toLowerCase()}
            {splitBy && `, split by ${label(splitBy).toLowerCase()}`}
          </h2>
          <span className="muted">
            {data && `${formatValue(total, metric, currency)} total`}
          </span>
        </header>
        {error && <div className="banner error">{error}</div>}
        {rows.length >= 20000 && <div className="banner">Showing the first 20,000 combinations. Narrow the filters for exact totals per value.</div>}

        <div className={loading ? "stale" : ""}>
          {!data && !error && <div className="empty">Loading…</div>}
          {data && view === "chart" && (
            <ReportChart
              rows={rows}
              metric={metric}
              currency={currency}
              scope={splitBy}
              time={time}
              split={!!splitBy}
              topN={state.topN}
              theme={theme}
              seriesLabel={metricLabel}
              height={time ? 360 : undefined}
            />
          )}
          {data && view === "heatmap" && <Heatmap rows={rows} metric={metric} currency={currency} topN={state.topN} theme={theme} />}
          {data && view === "table" && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{label(groupBy)}</th>
                    {splitBy && <th>{label(splitBy)}</th>}
                    {METRICS.map((m) => (
                      <th key={m.id} className="num">
                        {m.id === metric && !time ? (
                          <button className="link" onClick={() => setSortDesc(!sortDesc)} title="Change sort order">
                            {m.label} {sortDesc ? "↓" : "↑"}
                          </button>
                        ) : (
                          m.label
                        )}
                      </th>
                    ))}
                    <th className="num">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.slice(0, TABLE_LIMIT).map((r, i) => (
                    <tr key={i}>
                      <td>{time ? formatBucket(r.g1 ?? "") : r.g1}</td>
                      {splitBy && <td>{r.g2}</td>}
                      {METRICS.map((m) => (
                        <td key={m.id} className="num">
                          {formatValue(r[m.id], m.id, currency)}
                        </td>
                      ))}
                      <td className="num muted">{percent(r[metric], total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sorted.length > TABLE_LIMIT && <p className="hint">Showing {TABLE_LIMIT} of {sorted.length.toLocaleString()} rows. Export the CSV for all of them.</p>}
              {!sorted.length && <div className="empty">No matching sales for these filters.</div>}
            </div>
          )}
        </div>
        {metric === "wheels" && (
          <p className="hint">A wheelset counts as 2 wheels and a single front or rear wheel as 1. Other products and wheel services count as 0.</p>
        )}
        {metric === "orders" && (splitBy || !time) && (
          <p className="hint">An order with several different values is counted once under each, so order counts can add up to more than the total.</p>
        )}
      </section>
    </div>
  );
}
