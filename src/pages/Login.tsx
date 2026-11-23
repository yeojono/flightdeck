import { type FormEvent, useState } from "react";
import { api } from "../api";

export function Login({ configError, onSignedIn }: { configError: string | null; onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/login", { body: { password } });
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>Wheel Insights</h1>
        {configError ? (
          <div className="banner error">
            Setup is not finished: {configError} Set it with <code>wrangler secret put</code> and reload.
          </div>
        ) : (
          <>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
            </label>
            {error && <div className="banner error">{error}</div>}
            <button className="primary" disabled={busy || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
