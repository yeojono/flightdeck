import { useCallback, useEffect, useState } from "react";
import { type AttributeKey, type Dimension, api } from "../api";
import type { AppContext } from "../App";

interface Sample {
  value: string;
  line_items: number;
}

/**
 * Suggests an attribute for a property key when an attribute name appears in it.
 * If several match ("hub colour"), the one named last wins, since that is usually what the value describes.
 */
function suggest(key: string, dims: Dimension[]): number | null {
  const k = key.replace(/color/g, "colour");
  let best: { id: number; at: number } | null = null;
  for (const d of dims) {
    const n = d.name.toLowerCase().replace(/color/g, "colour");
    let at = k.lastIndexOf(n);
    if (at === -1 && n === "wheel size") at = k.search(/\b(size|diameter)\b/);
    if (at !== -1 && (!best || at > best.at)) best = { id: d.id, at };
  }
  return best?.id ?? null;
}

export function Attributes({ reloadMeta }: AppContext) {
  const [dims, setDims] = useState<Dimension[]>([]);
  const [keys, setKeys] = useState<AttributeKey[] | null>(null);
  const [samples, setSamples] = useState<Record<string, Sample[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(() => {
    api<{ dimensions: Dimension[]; keys: AttributeKey[] }>("/attributes").then(
      (r) => {
        setDims(r.dimensions);
        setKeys(r.keys);
      },
      (e) => setError(e.message),
    );
  }, []);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
      reloadMeta();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const map = (key: string, dimensionId: number | null) => act(() => api("/attributes/map", { method: "PUT", body: { key, dimensionId } }));

  const toggle = (key: string) => {
    setExpanded(expanded === key ? null : key);
    if (!samples[key]) {
      api<{ values: Sample[] }>(`/attributes/values?key=${encodeURIComponent(key)}`).then((r) => setSamples((s) => ({ ...s, [key]: r.values })), () => {});
    }
  };

  const visible = (keys ?? []).filter((k) => showHidden || !k.key.startsWith("_") || k.dimension_id !== null);
  const hiddenCount = (keys ?? []).length - (keys ?? []).filter((k) => !k.key.startsWith("_") || k.dimension_id !== null).length;
  const suggestions = visible.filter((k) => k.dimension_id === null).map((k) => ({ key: k.key, dim: suggest(k.key, dims) })).filter((s) => s.dim !== null);

  return (
    <div className="page">
      <h1>Attributes</h1>
      <p className="lede">
        Each store labels its line item properties its own way. Map the property keys below to a shared attribute such as Rim or Hub so reports line up across stores.
        Keys are matched ignoring upper and lower case.
      </p>
      {error && <div className="banner error">{error}</div>}

      <section className="card">
        <header className="card-head">
          <h2>Your attributes</h2>
        </header>
        <div className="chips">
          {dims.map((d) => {
            const n = (keys ?? []).filter((k) => k.dimension_id === d.id).length;
            return (
              <span className="chip" key={d.id}>
                <strong>{d.name}</strong>
                <span className="muted">
                  {n} {n === 1 ? "key" : "keys"}
                </span>
                <button
                  className="link"
                  title={`Rename ${d.name}`}
                  onClick={() => {
                    const name = window.prompt("Rename attribute", d.name)?.trim();
                    if (name && name !== d.name) act(() => api(`/dimensions/${d.id}`, { method: "PATCH", body: { name } }));
                  }}
                >
                  Rename
                </button>
                <button
                  className="link danger"
                  title={`Delete ${d.name}`}
                  onClick={() => window.confirm(`Delete the attribute “${d.name}”? Its property keys become unmapped. No order data is deleted.`) && act(() => api(`/dimensions/${d.id}`, { method: "DELETE" }))}
                >
                  Delete
                </button>
              </span>
            );
          })}
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) act(() => api("/dimensions", { body: { name: newName.trim() } })).then(() => setNewName(""));
            }}
          >
            <input className="control" placeholder="New attribute, e.g. Spokes" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button className="secondary" disabled={!newName.trim()}>
              Add
            </button>
          </form>
        </div>
      </section>

      <section className="card">
        <header className="card-head">
          <h2>Line item properties found in your orders</h2>
          {suggestions.length > 0 && (
            <button className="secondary" onClick={() => act(() => Promise.all(suggestions.map((s) => api("/attributes/map", { method: "PUT", body: { key: s.key, dimensionId: s.dim } }))))}>
              Apply {suggestions.length} suggested {suggestions.length === 1 ? "mapping" : "mappings"}
            </button>
          )}
        </header>
        {keys === null && <div className="empty">Loading…</div>}
        {keys?.length === 0 && <div className="empty">No line item properties found yet. They appear here after the first store finishes importing.</div>}
        {visible.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Property key</th>
                  <th className="num">Line items</th>
                  <th className="num">Stores</th>
                  <th className="num">Different values</th>
                  <th>Attribute</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((k) => {
                  const hint = k.dimension_id === null ? suggest(k.key, dims) : null;
                  return (
                    <tr key={k.key}>
                      <td>
                        <button className="link key" onClick={() => toggle(k.key)} aria-expanded={expanded === k.key}>
                          {expanded === k.key ? "▾" : "▸"} {k.key}
                        </button>
                        {expanded === k.key && (
                          <div className="samples">
                            {!samples[k.key] && <span className="muted">Loading…</span>}
                            {samples[k.key]?.map((s) => (
                              <span className="sample" key={s.value}>
                                {s.value} <span className="muted">{s.line_items.toLocaleString()}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="num">{k.line_items.toLocaleString()}</td>
                      <td className="num">{k.stores}</td>
                      <td className="num">{k.distinct_values.toLocaleString()}</td>
                      <td>
                        <select className="control" value={k.dimension_id ?? ""} onChange={(e) => map(k.key, e.target.value ? Number(e.target.value) : null)} aria-label={`Attribute for ${k.key}`}>
                          <option value="">Not mapped</option>
                          {dims.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                        {hint !== null && (
                          <button className="link" onClick={() => map(k.key, hint)}>
                            Use {dims.find((d) => d.id === hint)?.name}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {hiddenCount > 0 && (
          <label className="check">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show {hiddenCount} hidden {hiddenCount === 1 ? "property" : "properties"} (keys starting with an underscore, usually internal app data)
          </label>
        )}
        <p className="hint">Unmapped properties can still be used in Explore under “Unmapped properties”. If a line item has two keys mapped to the same attribute, one of them is used.</p>
      </section>
    </div>
  );
}
