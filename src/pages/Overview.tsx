import type { AppContext } from "../App";
import { ReportChart } from "../components/Charts";
import { FilterBar } from "../components/FilterBar";
import { type Metric, formatCompact, metricLabel, timeGrain, toRequest, useReport, useTheme } from "../lib";

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
            seriesLabel={metricLabel(metric)}
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
      localStorage.setItem("wi.explore", JSON.stringify({ ...saved, metric: "wheels", groupBy, splitBy: "", view: "chart" }));
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
    { label: "Wheels sold", value: t ? formatCompact(t.wheels ?? 0, "wheels", meta.reportingCurrency) : "-" },
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
        <Card ctx={ctx} title={`Wheels sold by ${grain}`} dim={grain} metric="wheels" time onOpen={() => open(grain)} />
        {attrs.map((d) => (
          <Card key={d.id} ctx={ctx} title={`Wheels by ${d.label.toLowerCase()}`} dim={d.id} metric="wheels" onOpen={() => open(d.id)} />
        ))}
        <Card ctx={ctx} title="Wheels by country" dim="country" metric="wheels" onOpen={() => open("country")} />
        <Card ctx={ctx} title="Wheels by state / province" dim="province" metric="wheels" onOpen={() => open("province")} />
      </div>
      {unmapped.length > 0 && attrs.length > 0 && (
        <p className="hint">
          Not shown because no property is mapped yet: {unmapped.map((d) => d.label).join(", ")}. Map them on the <a href="#/attributes">Attributes</a> page.
        </p>
      )}
      <p className="hint">
        Wheels count a wheelset (“Wheelset” or “Front + Rear” in the product name) as 2 and a single front or rear wheel as 1. Other products, and wheel services such as
        rebuilds, wheel shells and per-wheel upgrades, count as 0. Charts for rim, hub and other attributes count only line items that carry that property. Test orders are always excluded. Revenue is the line total after line-level
        discounts, before tax and shipping, converted with each store’s conversion rate.
      </p>
    </div>
  );
}
