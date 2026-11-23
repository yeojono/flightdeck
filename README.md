# FlightDeck

Sales analytics across several Shopify stores, broken down by line item properties (rim, hub, colour, wheel size and anything else your product builder records) and by country and state/province.

It runs entirely on Cloudflare: one Worker serves the React dashboard and the API, a D1 database holds the imported data, and a Workflow imports orders from each store using Shopify’s bulk export.

## What you get

- **Overview** - headline numbers, sales over time, and a top-values chart for each attribute, country and state.
- **Explore** - pick a metric (units, orders, revenue), group by any attribute or field, optionally split by a second one, and view it as a chart, a heatmap (for example rim x hub) or a table. Filter by date, store, country, state and any attribute. Export to CSV.
- **Attributes** - map each store’s property keys ("Rim", "Rim Choice", "Select your rim") to one shared attribute so stores line up.
- **Stores** - connect stores, see sync status, set currency conversion rates.

## Requirements

- Node.js 22 or newer.
- A Cloudflare account. **Use the Workers Paid plan** (about US$5/month). The free plan allows only 10 ms of CPU per request, and importing order files needs more than that. I have not tested on the free plan and expect imports to fail there.
- For each Shopify store: access to the Dev Dashboard of the organisation that owns the store.

## 1. Deploy to Cloudflare

```sh
npm install
npx wrangler login

# Create the database, then paste the database_id it prints into wrangler.jsonc
npx wrangler d1 create flightdeck
npm run db:migrate

npm run deploy

# Set the secret (you are prompted for the value)
npx wrangler secret put APP_SECRET       # long random string, e.g. from: openssl rand -base64 32
```

`npm run deploy` prints your URL (`https://flightdeck.<your-subdomain>.workers.dev`).

Keep `APP_SECRET` safe and do not change it later: it encrypts the stored Shopify credentials, so changing it means reconnecting every store.

### Protect it with Cloudflare Access

The app has no password of its own. Sign-in is done by [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) in front of the Worker, and the API refuses every request that did not come through Access, so **the dashboard shows "You are not signed in" until you do this:**

1. In the Cloudflare dashboard open **Workers & Pages**, select **flightdeck**, and open its **Access** tab.
2. Choose **Protect this Worker behind Access**, then **All traffic** (this covers the `workers.dev` URL, preview URLs and any custom domain).
3. Under the authentication policy, pick **Cloudflare account** to let members of your Cloudflare account in, and/or **Email domain** to let in anyone with a verified email at your domain. Then **Apply Access**.
4. Open the app’s URL and sign in. Because this Worker serves static assets, Cloudflare does not hand the sign-in to the Worker directly, so the Worker checks the signed token Access adds to each request instead. It needs two values for that, and until they are set the page shows them to you: copy them into `vars` in `wrangler.jsonc` and deploy again.

   ```jsonc
   "ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
   "ACCESS_AUD": "the Access application’s AUD tag"
   ```

   Check the team domain is yours (**Zero Trust > Settings**). You can also find the AUD tag on the Access application in **Zero Trust > Access > Applications**, under its additional settings, as **Application Audience (AUD) Tag**. Neither value is secret.

To let in specific people outside those groups, edit the Access application’s policy in **Zero Trust > Access** (for example, an "Emails" rule listing their addresses). Anyone who can sign in can see and change everything in the app; there are no separate roles.

Access is free for up to 50 users. "Sign out" in the app goes to Access’s sign-out page.

If you would rather create the Access application yourself in Zero Trust (by hostname, for example on a custom domain), skip steps 1 to 3 and set the same two values from that application.

### Upgrading from the password version

Run `npm run db:migrate` (it drops the old sign-in rate-limit table), set up Access as above, deploy, then remove the old secret with `npx wrangler secret delete ADMIN_PASSWORD`. Keep `APP_SECRET` exactly as it is.

## 2. Create the Shopify app (Dev Dashboard)

The app authenticates with the **client credentials grant**: it exchanges the app’s Client ID and Client secret for a 24-hour Admin API token and renews it automatically. Shopify only allows this when **the app and the store are in the same organisation**.

For each organisation that owns one or more of your stores:

1. Open the [Dev Dashboard](https://dev.shopify.com/dashboard) and create an app.
2. In the app’s version, add the scopes `read_orders` and `read_products`, then release the version.
3. Under **Settings > Access requests**, enable **Bulk queries**.
4. Install the app on each store in that organisation.
5. Copy the **Client ID** and **Client secret** from the app’s Settings page.

If all your stores are in one organisation, one app covers them all: use the same Client ID and secret for each store. If they are in different organisations, create one app per organisation.

## 3. Connect stores

In the dashboard go to **Stores**, enter the store’s `myshopify.com` domain plus the Client ID and secret, and choose **Connect and import**. The app checks the credentials with Shopify, then imports the full order history. After that it imports changes every 6 hours (edit `triggers.crons` in `wrangler.jsonc` to change this), or on demand with **Sync now**.

Then go to **Attributes** and map the property keys it found to Rim, Hub, Colour and Wheel size (or your own attributes).

## Things to check on your real stores

These depend on your Shopify setup and could not be tested without a real store:

- **Order history.** Shopify staff have said apps created by the merchant’s own organisation get full order history with `read_orders`. If you only see the last 60 days, the app also needs the `read_all_orders` scope.
- **State and country.** These come from the shipping address (billing address as a fallback), which Shopify treats as protected customer data. Shopify’s docs say this is available to custom apps, but if a sync finishes with a note that no address data was returned, the app needs protected customer data access for addresses enabled in the Dev Dashboard.
- **Error `shop_not_permitted`** when connecting means the app and store are not in the same organisation, or the app is not installed on the store.
- **Export failed with ACCESS_DENIED** means a scope is missing or Bulk queries is not enabled.

## How the numbers are defined

- **Units** - line item quantity after refunds and removals.
- **Orders** - distinct orders containing matching line items.
- **Revenue** - line total after line-level discounts, before tax and shipping, scaled down for refunded units, multiplied by the store’s conversion rate. Order-level discount codes are not subtracted. Conversion rates are fixed numbers you enter, so combined revenue across currencies is approximate.
- Test orders are always excluded. Cancelled orders are excluded unless you tick **Include cancelled**.
- Dates use each store’s own timezone.
- Attribute values are grouped ignoring upper/lower case ("Black" and "black" are one value). Differently worded values ("Matte Black" vs "Black Matte") are not merged.

## What is stored

Order id, name, date, status, currency, sales channel, shipping state and country, and for each line item the title, variant, SKU, vendor, product type, quantities, prices and properties. No customer names, emails, phone numbers or street addresses are requested or stored. Shopify client secrets and tokens are encrypted with AES-GCM using `APP_SECRET`.

Line item properties can contain whatever customers type (engraving text, notes). Hidden properties (keys starting with `_`) are imported too and hidden by default on the Attributes page.

## Local development

```sh
cp .dev.vars.example .dev.vars     # set APP_SECRET
npm run db:migrate:local
npm run dev
```

To try it without a real store, uncomment `SHOPIFY_ORIGIN_OVERRIDE` in `.dev.vars`, run `npm run mock:shopify` in a second terminal, and connect a store with any domain, Client ID `mock-au` or `mock-us`, and Client secret `mock-secret`. Never set `SHOPIFY_ORIGIN_OVERRIDE` in production.

Local dev skips Cloudflare Access: the `access.dev` block in `wrangler.jsonc` makes every request count as signed in as `dev@localhost`.

`npm test` runs the import and report SQL against SQLite with generated data. `npm run typecheck` checks types.

## Project layout

```
worker/index.ts     API routes and the cron handler
worker/shopify.ts   client credentials grant, GraphQL client, bulk export query
worker/sync.ts      the import Workflow (start export, wait, import in chunks)
worker/ingest.ts    parses the export and writes rows to D1
worker/report.ts    builds the aggregate SQL behind every chart
worker/auth.ts      Cloudflare Access check on every API request
worker/access.ts    Access JWT verification (only for a hostname-based Access application)
migrations/         D1 schema
src/                React dashboard
public/             app icon and favicons (icon.svg is the source)
scripts/            mock Shopify server for local testing
```

## Settings

| Where | Name | Purpose |
|---|---|---|
| `wrangler.jsonc` vars | `SHOPIFY_API_VERSION` | Admin API version (currently `2026-10`). Shopify retires versions after about a year, so bump this occasionally. |
| `wrangler.jsonc` vars | `INGEST_CHUNK_BYTES` | Bytes of the export processed per Workflow step. |
| `wrangler.jsonc` triggers | `crons` | Automatic sync schedule. |
| `wrangler.jsonc` vars | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Optional. Only for an Access application set up by hostname in Zero Trust. |
| `wrangler.jsonc` access | `dev` | The identity used in local dev. Ignored when deployed. |
| secret | `APP_SECRET` | Encrypts the stored Shopify credentials. |

## Limits worth knowing

- D1 databases hold up to 10 GB on the paid plan. As a rough guide, 100,000 orders with properties is in the low hundreds of MB.
- Deleted orders in Shopify are not removed by incremental syncs. A **Full resync** rebuilds a store’s data from scratch.
- Reports return at most 20,000 group combinations.
