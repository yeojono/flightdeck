import type { AppContext } from "../App";
import { ReportChart } from "../components/Charts";
import { FilterBar } from "../components/FilterBar";
import { type Metric, formatCompact, metricLabel, timeGrain, toRequest, useReport, useTheme } from "../lib";

interface CardProps {
  ctx: AppContext;
  /** Either a full title, or `by`: what the chart is broken down by, titled "Wheels by ..." */
  title?: string;
  by?: string;
  dim: string;
  metric: Metric;
  time?: boolean;
  onOpen: (shown: Metric) => void;
}

function Card({ ctx, title, by, dim, metric: wanted, time, onOpen }: CardProps) {
  const theme = useTheme();
  const { data, loading, error } = useReport(toRequest(ctx.filters, { groupBy: [dim], limit: time ? 2000 : 500 }));
  // Valve colours and rebuild rims are on products that count as 0 wheels: chart those in units rather than as a row of zeros.
  const noWheels = wanted === "wheels" && !!data?.rows.length && data.rows.every((r) => !r.wheels) && data.rows.some((r) => r.units > 0);
  const metric: Metric = noWheels ? "units" : wanted;
  title ??= `${metricLabel(metric)} by ${by}`;
  return (
    <section className={`card${time ? " wide" : ""}`}>
      <header className="card-head">
        <h2>{title}</h2>
        <button className="link" onClick={() => onOpen(metric)}>
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
  const stale = meta.stores.filter((s) => s.needs_resync);

  const open = (groupBy: string, metric: Metric = "wheels") => {
    // The Explore page reads its starting state from here when it opens.
    try {
      const saved = JSON.parse(localStorage.getItem("wi.explore") ?? "{}");
      localStorage.setItem("wi.explore", JSON.stringify({ ...saved, metric, groupBy, splitBy: "", view: "chart" }));
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
      {stale.length > 0 && (
        <div className="banner">
          {stale.map((s) => s.label).join(", ")} {stale.length === 1 ? "was" : "were"} imported before the current import settings
          {meta.orderTag ? ` (only orders tagged “${meta.orderTag}”, the latest value clean-up and product metafields)` : ""}. The next sync re-imports {stale.length === 1 ? "it" : "them"}; until then these
          reports show the older data. Start it now with Sync now on the <a href="#/stores">Stores</a> page.
        </div>
      )}
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
        <Card ctx={ctx} by="wheel type" dim="wheel_type" metric="wheels" onOpen={(m) => open("wheel_type", m)} />
        {attrs.map((d) => (
          <Card key={d.id} ctx={ctx} by={d.label.toLowerCase()} dim={d.id} metric="wheels" onOpen={(m) => open(d.id, m)} />
        ))}
        <Card ctx={ctx} by="country" dim="country" metric="wheels" onOpen={(m) => open("country", m)} />
        <Card ctx={ctx} by="state / province" dim="province" metric="wheels" onOpen={(m) => open("province", m)} />
      </div>
      {unmapped.length > 0 && attrs.length > 0 && (
        <p className="hint">
          Not shown because no property is mapped yet: {unmapped.map((d) => d.label).join(", ")}. Map them on the <a href="#/attributes">Attributes</a> page.
        </p>
      )}
      <p className="hint">
        Wheels count a wheelset (“Wheelset” or “Front + Rear” in the product name) as 2 and a single front or rear wheel as 1. Other products, and wheel services such as
        rebuilds, wheel shells and per-wheel upgrades, count as 0. Wheel type uses the same reading of the product name: use its filter to look at sets or single wheels on their
        own. Charts for rim, hub and other attributes count only line items that carry that property; an attribute found only on products that are not wheels, such as valve
        colour, is charted in units. Test orders are always excluded. Revenue is the line total after line-level
        discounts, before tax and shipping, converted with each store’s conversion rate.
      </p>
    </div>
  );
}
