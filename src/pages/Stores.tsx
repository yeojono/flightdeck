import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type Run, type Store, api } from "../api";
import type { AppContext } from "../App";

const ACTIVE = new Set(["queued", "exporting", "importing"]);
const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  exporting: "Shopify is preparing the export",
  importing: "Importing",
  complete: "Complete",
  failed: "Failed",
  running: "Syncing",
};

function when(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="badge">Not synced</span>;
  const kind = status === "complete" ? "good" : status === "failed" ? "bad" : "busy";
  const icon = kind === "good" ? "✓" : kind === "bad" ? "✕" : "↻";
  return (
    <span className={`badge ${kind}`}>
      <span aria-hidden>{icon}</span> {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function Stores({ meta, reloadMeta }: AppContext) {
  const [stores, setStores] = useState<Store[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ shop: "", label: "", clientId: "", clientSecret: "" });
  const [busy, setBusy] = useState(false);
  const [currency, setCurrency] = useState(meta.reportingCurrency);

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api<{ stores: Store[] }>("/stores"), api<{ runs: Run[] }>("/runs")]);
      setStores(s.stores);
      setRuns(r.runs);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Poll while anything is syncing, then refresh the report metadata once it settles.
  const syncing = runs.some((r) => ACTIVE.has(r.status));
  useEffect(() => {
    if (!syncing) {
      reloadMeta();
      return;
    }
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [syncing, load, reloadMeta]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await act(async () => {
      const r = await api<{ warnings: string[] }>("/stores", { body: form });
      setForm({ shop: "", label: "", clientId: "", clientSecret: "" });
      setNotice(["Store connected. The first import has started and can take a while for large stores.", ...r.warnings].join(" "));
    });
    setBusy(false);
  }

  const multiCurrency = new Set((stores ?? []).map((s) => s.currency).filter(Boolean)).size > 1;

  return (
    <div className="page">
      <h1>Stores</h1>
      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner good">{notice}</div>}

      <section className="card">
        <header className="card-head">
          <h2>Connected stores</h2>
          <label className="inline">
            Reporting currency
            <input className="control short" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            {currency !== meta.reportingCurrency && (
              <button className="secondary" onClick={() => act(() => api("/settings", { method: "PUT", body: { reportingCurrency: currency } }).then(reloadMeta), "Reporting currency updated.")}>
                Save
              </button>
            )}
          </label>
        </header>
        {stores === null && <div className="empty">Loading…</div>}
        {stores?.length === 0 && <div className="empty">No stores connected yet. Add one below.</div>}
        {stores && stores.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Status</th>
                  <th>Last sync</th>
                  <th className="num">Orders</th>
                  <th>Currency</th>
                  <th title={`Multiply this store’s revenue by this to get ${meta.reportingCurrency}`}>Rate to {meta.reportingCurrency}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {stores.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.label}</strong>
                      <div className="muted small nowrap">{s.shop}.myshopify.com</div>
                    </td>
                    <td>
                      <StatusBadge status={s.last_sync_status} />
                      {s.last_sync_error && <div className="small error-text">{s.last_sync_error}</div>}
                    </td>
                    <td>{when(s.last_sync_at)}</td>
                    <td className="num">
                      {s.order_count.toLocaleString()}
                      {s.first_day && <div className="muted small">since {s.first_day}</div>}
                    </td>
                    <td>{s.currency ?? "-"}</td>
                    <td>
                      <input
                        className="control short"
                        type="number"
                        step="0.0001"
                        min="0"
                        defaultValue={s.fx_rate}
                        aria-label={`Conversion rate for ${s.label}`}
                        onBlur={(e) => Number(e.target.value) !== s.fx_rate && act(() => api(`/stores/${s.id}`, { method: "PATCH", body: { fxRate: Number(e.target.value) } }), "Conversion rate saved.")}
                      />
                    </td>
                    <td className="actions">
                      <button className="link" onClick={() => act(() => api(`/stores/${s.id}/sync`, { body: { full: false } }))}>
                        Sync now
                      </button>
                      <button
                        className="link"
                        onClick={() => window.confirm(`Re-import every order for ${s.label}? Existing data for this store is replaced.`) && act(() => api(`/stores/${s.id}/sync`, { body: { full: true } }))}
                      >
                        Full resync
                      </button>
                      <button
                        className="link"
                        onClick={() => {
                          const label = window.prompt("Store name shown in reports", s.label)?.trim();
                          if (label && label !== s.label) act(() => api(`/stores/${s.id}`, { method: "PATCH", body: { label } }).then(reloadMeta));
                        }}
                      >
                        Rename
                      </button>
                      <button
                        className="link danger"
                        onClick={() => window.confirm(`Disconnect ${s.label} and delete all of its imported data from this app? Nothing changes in Shopify.`) && act(() => api(`/stores/${s.id}`, { method: "DELETE" }).then(reloadMeta))}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {multiCurrency && (
          <p className="hint">
            Your stores use different currencies. Set each store’s rate so revenue adds up in {meta.reportingCurrency} (for example 1.52 for a USD store reporting in AUD). Rates are fixed numbers you
            maintain, not live exchange rates, so treat combined revenue as approximate.
          </p>
        )}
        <p className="hint">Stores sync automatically every 6 hours.</p>
      </section>

      <section className="card">
        <header className="card-head">
          <h2>Connect a store</h2>
        </header>
        <ol className="steps">
          <li>
            In the <a href="https://dev.shopify.com/dashboard" target="_blank" rel="noreferrer">Shopify Dev Dashboard</a>, in the same organisation that owns the store, create an app.
          </li>
          <li>
            In the app’s version, add the scopes <code>read_orders</code> and <code>read_products</code>, then release the version.
          </li>
          <li>Under Settings &gt; Access requests, enable <strong>Bulk queries</strong>.</li>
          <li>Install the app on the store, then copy the Client ID and Client secret from the app’s Settings page into the form below.</li>
        </ol>
        <form className="form" onSubmit={connect}>
          <label>
            Store domain
            <input className="control" placeholder="my-store.myshopify.com" value={form.shop} onChange={(e) => setForm({ ...form, shop: e.target.value })} required />
          </label>
          <label>
            <span>
              Name in reports <span className="muted">(optional)</span>
            </span>
            <input className="control" placeholder="AU store" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </label>
          <label>
            Client ID
            <input className="control" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} autoComplete="off" required />
          </label>
          <label>
            Client secret
            <input className="control" type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} autoComplete="new-password" required />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Checking with Shopify…" : "Connect and import"}
          </button>
        </form>
        <p className="hint">The client secret is encrypted before it is stored. Only order dates, totals, line items, their properties and the shipping state and country are imported. No customer names, emails or street addresses.</p>
      </section>

      {runs.length > 0 && (
        <section className="card">
          <header className="card-head">
            <h2>Recent syncs</h2>
          </header>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th className="num">Orders</th>
                  <th className="num">Line items</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{r.store_label}</td>
                    <td>{r.kind === "full" ? "Full" : "Changes only"}</td>
                    <td>
                      <StatusBadge status={r.status} />
                      {r.status === "importing" && r.bytes_total > 0 && <span className="muted small"> {Math.round((r.bytes_done / r.bytes_total) * 100)}%</span>}
                    </td>
                    <td>{when(r.started_at)}</td>
                    <td className="num">{r.orders.toLocaleString()}</td>
                    <td className="num">{r.line_items.toLocaleString()}</td>
                    <td className={`small${r.status === "failed" ? " error-text" : ""}`}>{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
