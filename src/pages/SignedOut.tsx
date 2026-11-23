export interface AccessSetup {
  teamDomain: string;
  aud: string;
}

export function SignedOut({ configError, accessSetup }: { configError: string | null; accessSetup: AccessSetup | null }) {
  return (
    <div className="center">
      <div className="card login">
        <h1>FlightDeck</h1>
        {configError ? (
          <div className="banner error">
            Setup is not finished: {configError} Set it with <code>wrangler secret put</code> and reload.
          </div>
        ) : accessSetup ? (
          <>
            <p className="muted">
              Cloudflare Access let you through, but the Worker cannot check your sign-in yet. Add these two values to <code>vars</code> in{" "}
              <code>wrangler.jsonc</code> and deploy again:
            </p>
            <pre>
              {`"ACCESS_TEAM_DOMAIN": "${accessSetup.teamDomain}",\n"ACCESS_AUD": "${accessSetup.aud}"`}
            </pre>
            <p className="muted">
              Check the team domain is yours (Zero Trust &gt; Settings). These values are not secret. See “Protect it with Cloudflare Access” in the README.
            </p>
            <button className="primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </>
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
