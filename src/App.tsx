import { useCallback, useEffect, useState } from "react";
import { type Meta, api, setUnauthorisedHandler } from "./api";
import { clearOptionCache } from "./components/FilterBar";
import { DEFAULT_FILTERS, type FilterState, useStored } from "./lib";
import { Attributes } from "./pages/Attributes";
import { Explore } from "./pages/Explore";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { Stores } from "./pages/Stores";

const PAGES = [
  { id: "overview", label: "Overview" },
  { id: "explore", label: "Explore" },
  { id: "attributes", label: "Attributes" },
  { id: "stores", label: "Stores" },
] as const;
export type PageId = (typeof PAGES)[number]["id"];

function currentPage(): PageId {
  const id = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return (PAGES.find((p) => p.id === id)?.id ?? "overview") as PageId;
}

export interface AppContext {
  meta: Meta;
  reloadMeta: () => void;
  filters: FilterState;
  setFilters: (f: FilterState) => void;
  go: (page: PageId) => void;
}

export function App() {
  const [session, setSession] = useState<"loading" | "in" | "out">("loading");
  const [configError, setConfigError] = useState<string | null>(null);
  const [page, setPage] = useState<PageId>(currentPage);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [filters, setFilters] = useStored<FilterState>("wi.filters", DEFAULT_FILTERS);

  useEffect(() => {
    setUnauthorisedHandler(() => setSession("out"));
    api<{ signedIn: boolean; configError?: string }>("/session")
      .then((s) => {
        setConfigError(s.configError ?? null);
        setSession(s.signedIn ? "in" : "out");
      })
      .catch(() => setSession("out"));
    const onHash = () => setPage(currentPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const reloadMeta = useCallback(() => {
    clearOptionCache();
    api<Meta>("/meta").then(setMeta, (e) => setMetaError(e.message));
  }, []);
  useEffect(() => {
    if (session === "in") reloadMeta();
  }, [session, reloadMeta]);

  const go = useCallback((p: PageId) => {
    window.location.hash = `/${p}`;
  }, []);

  if (session === "loading") return <div className="center muted">Loading…</div>;
  if (session === "out") return <Login configError={configError} onSignedIn={() => setSession("in")} />;

  const ctx: AppContext | null = meta && { meta, reloadMeta, filters, setFilters, go };
  return (
    <div className="shell">
      <aside className="nav">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 48 48" fill="none" aria-hidden>
            <path d="M9.8 38.5A18 18 0 1 1 38.2 38.5" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
            <path d="M21.39 25.65 30.12 17.13A1 1 0 0 1 31.76 18.29L26.61 29.35A3.2 3.2 0 1 1 21.39 25.65Z" fill="currentColor" />
          </svg>
          FlightDeck
        </div>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={page === p.id ? "current" : ""} aria-current={page === p.id ? "page" : undefined}>
              {p.label}
            </a>
          ))}
        </nav>
        <button
          className="link signout"
          onClick={() => api("/logout", { method: "POST" }).finally(() => setSession("out"))}
        >
          Sign out
        </button>
      </aside>
      <main className="viz-root">
        {metaError && <div className="banner error">{metaError}</div>}
        {!ctx && !metaError && <div className="center muted">Loading…</div>}
        {ctx && page === "overview" && <Overview {...ctx} />}
        {ctx && page === "explore" && <Explore {...ctx} />}
        {ctx && page === "attributes" && <Attributes {...ctx} />}
        {ctx && page === "stores" && <Stores {...ctx} />}
      </main>
    </div>
  );
}
