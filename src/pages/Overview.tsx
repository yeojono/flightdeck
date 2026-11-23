import type { AppContext } from "../App";
import { ReportChart } from "../components/Charts";
import { FilterBar } from "../components/FilterBar";
import { type Metric, formatCompact, timeGrain, toRequest, useReport, useTheme } from "../lib";

function Card({ ctx, title, dim, metric, time, onOpen }: { ctx: AppContext; title: string; dim: string; metric: Metric; time?: boolean; onOpen: () => void }) {
  const theme = useTheme();
  const { data, loading, error } = useReport(toRequest(ctx.filters, { groupBy: [dim], limit: time ? 2000 : 500 }));
  return (
    <section className={`card${time ? " wide" : ""}`}>
      <header className="card-head">
        <h2>{title}</h2>
        <button className="link" onClick={onOpen}>
          Explore
        </button>
      </header>
      {error && <div className="banner error">{error}</div>}
      <div className={loading ? "stale" : ""}>
        {data && (
          <ReportChart
            rows={data.rows}
            metric={metric}
            currency={ctx.meta.reportingCurrency}
            scope={dim}
            time={!!time}
            split={false}
            topN={8}
            theme={theme}
            seriesLabel={metric === "units" ? "Units" : metric === "orders" ? "Orders" : "Revenue"}
            height={time ? 260 : undefined}
          />
        )}
        {!data && !error && <div className="empty">Loading…</div>}
      </div>
    </section>
  );
}

export function Overview(ctx: AppContext) {
  const { meta, filters, setFilters, go } = ctx;
  const totals = useReport(toRequest(filters, { groupBy: [] }));
  const grain = timeGrain(filters);
  const attrs = meta.dimensions.filter((d) => d.group === "Attributes" && d.mapped);
  const unmapped = meta.dimensions.filter((d) => d.group === "Attributes" && !d.mapped);

  const open = (groupBy: string) => {
    // The Explore page reads its starting state from here when it opens.
    try {
      const saved = JSON.parse(localStorage.getItem("wi.explore") ?? "{}");
      localStorage.setItem("wi.explore", JSON.stringify({ ...saved, groupBy, splitBy: "", view: "chart" }));
    } catch {
      /* storage unavailable: Explore opens with its defaults */
    }
    go("explore");
  };

  if (!meta.stores.length) {
    return (
      <div className="page">
        <h1>Overview</h1>
        <div className="card empty-state">
          <h2>Connect your first store</h2>
          <p>Add a Shopify store and its orders, line item properties and shipping regions will be imported automatically.</p>
          <button className="primary" onClick={() => go("stores")}>
            Go to Stores
          </button>
        </div>
      </div>
    );
  }

  const t = totals.data?.totals;
  const tiles: Array<{ label: string; value: string }> = [
    { label: "Units sold", value: t ? formatCompact(t.units ?? 0, "units", meta.reportingCurrency) : "-" },
    { label: "Orders", value: t ? formatCompact(t.orders ?? 0, "orders", meta.reportingCurrency) : "-" },
    { label: `Revenue (${meta.reportingCurrency})`, value: t ? formatCompact(t.revenue ?? 0, "revenue", meta.reportingCurrency) : "-" },
  ];

  return (
    <div className="page">
      <h1>Overview</h1>
      <FilterBar meta={meta} state={filters} onChange={setFilters} />
      {!meta.range.orders && <div className="banner">No orders imported yet. Check sync progress on the Stores page.</div>}
      {attrs.length === 0 && meta.range.orders > 0 && (
        <div className="banner">
          Tell the app which line item properties mean rim, hub, colour and size on the{" "}
          <a href="#/attributes">Attributes</a> page to see them here.
        </div>
      )}
      <div className={`tiles${totals.loading ? " stale" : ""}`}>
        {tiles.map((x) => (
          <div className="tile" key={x.label}>
            <div className="tile-label">{x.label}</div>
            <div className="tile-value">{x.value}</div>
          </div>
        ))}
      </div>
      <div className="grid">
        <Card ctx={ctx} title={`Units sold by ${grain}`} dim={grain} metric="units" time onOpen={() => open(grain)} />
        {attrs.map((d) => (
          <Card key={d.id} ctx={ctx} title={`Units by ${d.label.toLowerCase()}`} dim={d.id} metric="units" onOpen={() => open(d.id)} />
        ))}
        <Card ctx={ctx} title="Units by country" dim="country" metric="units" onOpen={() => open("country")} />
        <Card ctx={ctx} title="Units by state / province" dim="province" metric="units" onOpen={() => open("province")} />
      </div>
      {unmapped.length > 0 && attrs.length > 0 && (
        <p className="hint">
          Not shown because no property is mapped yet: {unmapped.map((d) => d.label).join(", ")}. Map them on the <a href="#/attributes">Attributes</a> page.
        </p>
      )}
      <p className="hint">
        Charts for rim, hub and other attributes count only line items that carry that property. Test orders are always excluded. Revenue is the line total after line-level
        discounts, before tax and shipping, converted with each store’s conversion rate.
      </p>
    </div>
  );
}
