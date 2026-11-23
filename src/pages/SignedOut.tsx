export function SignedOut({ configError }: { configError: string | null }) {
  return (
    <div className="center">
      <div className="card login">
        <h1>FlightDeck</h1>
        {configError ? (
          <div className="banner error">
            Setup is not finished: {configError} Set it with <code>wrangler secret put</code> and reload.
          </div>
        ) : (
          <>
            <p className="muted">
              You are not signed in. Sign-in is handled by Cloudflare Access, so reloading the page should take you to the sign-in screen.
            </p>
            <p className="muted">
              If it does not, Cloudflare Access is not set up for this Worker yet. See “Protect it with Cloudflare Access” in the README.
            </p>
            <button className="primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </>
        )}
      </div>
    </div>
  );
}
