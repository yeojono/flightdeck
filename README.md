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

# Set the two secrets (you are prompted for each value)
npx wrangler secret put ADMIN_PASSWORD   # password for signing in to the dashboard
npx wrangler secret put APP_SECRET       # long random string, e.g. from: openssl rand -base64 32
```

`npm run deploy` prints your URL (`https://flightdeck.<your-subdomain>.workers.dev`). Open it and sign in with `ADMIN_PASSWORD`.

Keep `APP_SECRET` safe and do not change it later: it encrypts the stored Shopify credentials, so changing it means reconnecting every store.

**Recommended:** put the Worker behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) (Zero Trust) so only your team’s email addresses can reach it at all. The built-in password is a single shared password with basic rate limiting.

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
cp .dev.vars.example .dev.vars     # set a password and secret
npm run db:migrate:local
npm run dev
```

To try it without a real store, uncomment `SHOPIFY_ORIGIN_OVERRIDE` in `.dev.vars`, run `npm run mock:shopify` in a second terminal, and connect a store with any domain, Client ID `mock-au` or `mock-us`, and Client secret `mock-secret`. Never set `SHOPIFY_ORIGIN_OVERRIDE` in production.

`npm test` runs the import and report SQL against SQLite with generated data. `npm run typecheck` checks types.

## Project layout

```
worker/index.ts     API routes and the cron handler
worker/shopify.ts   client credentials grant, GraphQL client, bulk export query
worker/sync.ts      the import Workflow (start export, wait, import in chunks)
worker/ingest.ts    parses the export and writes rows to D1
worker/report.ts    builds the aggregate SQL behind every chart
worker/auth.ts      password sign-in and sessions
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
| secret | `ADMIN_PASSWORD` | Dashboard password. |
| secret | `APP_SECRET` | Encryption and session signing key. |

## Limits worth knowing

- D1 databases hold up to 10 GB on the paid plan. As a rough guide, 100,000 orders with properties is in the low hundreds of MB.
- Deleted orders in Shopify are not removed by incremental syncs. A **Full resync** rebuilds a store’s data from scratch.
- Reports return at most 20,000 group combinations.
