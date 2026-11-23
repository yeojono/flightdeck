import { useEffect, useMemo, useState } from "react";
import { type AttributeKey, type Dimension, api } from "../api";
import { type DimValue, suggestWordGroups } from "../grouping";

const DISMISSED = "wi.dismissedWordGroups";

function loadDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED) ?? "[]");
  } catch {
    return [];
  }
}

/** Lets you show several values of an attribute as one, e.g. "Mullet Set" as "Mullet". */
export function CombineValues({ dims, keys }: { dims: Dimension[]; keys: AttributeKey[] }) {
  const mapped = dims.filter((d) => keys.some((k) => k.dimension_id === d.id));
  const [dimId, setDimId] = useState<number | null>(null);
  const current = mapped.find((d) => d.id === dimId) ?? mapped[0];
  const [data, setData] = useState<{ values: DimValue[]; more: boolean } | null>(null);
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>(loadDismissed);

  useEffect(() => {
    if (!current) return;
    let live = true;
    setError(null);
    api<{ values: DimValue[]; more: boolean }>(`/dimensions/${current.id}/values`).then(
      (r) => live && setData(r),
      (e) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [current?.id, version]);

  const values = data?.values ?? [];
  const suggestions = useMemo(
    () => (current ? suggestWordGroups(values).filter((s) => !dismissed.includes(`${current.id}:${s.word.toLowerCase()}`)) : []),
    [values, dismissed, current?.id],
  );

  if (!current) return null;

  const pick = (id: number) => {
    setDimId(id);
    setData(null);
    setSelected([]);
    setLabel("");
  };
  const isSelected = (v: string) => selected.includes(v);
  const toggle = (v: string) => setSelected(isSelected(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  // The most common selected value is the natural name for the combined group.
  const defaultLabel = values.find((v) => isSelected(v.value))?.value ?? "";

  const save = async (groups: Array<{ values: string[]; label: string | null }>) => {
    setBusy(true);
    setError(null);
    try {
      for (const g of groups) await api(`/dimensions/${current.id}/groups`, { method: "PUT", body: g });
      setSelected([]);
      setLabel("");
      setVersion((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applySuggestion = (pairs: Array<{ from: string; to: string }>) => {
    const byLabel = new Map<string, string[]>();
    for (const p of pairs) byLabel.set(p.to, [...(byLabel.get(p.to) ?? []), p.from]);
    return save([...byLabel].map(([to, from]) => ({ values: from, label: to })));
  };
  const dismiss = (word: string) => {
    const next = [...dismissed, `${current.id}:${word.toLowerCase()}`];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISSED, JSON.stringify(next));
    } catch {
      /* storage unavailable: it reappears next visit */
    }
  };

  return (
    <section className="card">
      <header className="card-head">
        <h2>Combine values</h2>
        <select className="control" value={current.id} onChange={(e) => pick(Number(e.target.value))} aria-label="Attribute">
          {mapped.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </header>
      <p className="hint top">
        Values that differ only in upper and lower case, spacing, quote marks or inch marks (27.5", 27.5″, 27.5 in and 27.5) are combined automatically. Tick others that mean the
        same thing to show them as one value in reports.
      </p>
      {error && <div className="banner error">{error}</div>}

      {suggestions.map((s) => (
        <div className="banner suggestion" key={s.word}>
          <div>
            {s.pairs.length} values differ from another only by “{s.word}”:{" "}
            {s.pairs.map((p, i) => (
              <span key={p.from}>
                {i > 0 && ", "}
                <strong>{p.from}</strong> → {p.to}
              </span>
            ))}
          </div>
          <div className="actions">
            <button className="secondary" disabled={busy} onClick={() => applySuggestion(s.pairs)}>
              Combine these
            </button>
            <button className="link" onClick={() => dismiss(s.word)}>
              Keep separate
            </button>
          </div>
        </div>
      ))}

      {data === null && !error && <div className="empty">Loading…</div>}
      {data && values.length === 0 && <div className="empty">No values for {current.name} yet.</div>}
      {values.length > 0 && (
        <>
          <form
            className="inline combine-bar"
            onSubmit={(e) => {
              e.preventDefault();
              if (selected.length) save([{ values: selected, label: label.trim() || defaultLabel }]);
            }}
          >
            <span>{selected.length ? `Show ${selected.length} selected as` : "Tick values to combine them"}</span>
            {selected.length > 0 && (
              <>
                <input className="control" value={label} placeholder={defaultLabel} onChange={(e) => setLabel(e.target.value)} aria-label="Show as" />
                <button className="primary" disabled={busy}>
                  Combine
                </button>
                <button type="button" className="link" onClick={() => setSelected([])}>
                  Clear
                </button>
              </>
            )}
          </form>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th aria-label="Select" />
                  <th>Value</th>
                  <th className="num">Line items</th>
                  <th>Shown as</th>
                </tr>
              </thead>
              <tbody>
                {values.map((v) => (
                  <tr key={v.value}>
                    <td className="tick">
                      <input type="checkbox" checked={isSelected(v.value)} onChange={() => toggle(v.value)} aria-label={`Select ${v.value}`} />
                    </td>
                    <td>{v.value}</td>
                    <td className="num">{v.line_items.toLocaleString()}</td>
                    <td>
                      {v.label && (
                        <>
                          {v.label}{" "}
                          <button className="link" disabled={busy} onClick={() => save([{ values: [v.value], label: null }])}>
                            Separate
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.more && <p className="hint">Showing the 300 most common values.</p>}
        </>
      )}
    </section>
  );
}
