# FlightDeck

Sales analytics across several Shopify stores, broken down by line item properties (rim, hub, colour, wheel size and anything else your product builder records) and by country and state/province.

It runs entirely on Cloudflare: one Worker serves the React dashboard and the API, a D1 database holds the imported data, and a Workflow imports orders from each store using Shopify’s bulk export.

Only orders tagged `wheels` in Shopify are imported (see [Which orders are imported](#which-orders-are-imported)).

## What you get

- **Overview** - headline numbers, wheels sold over time, and a top-values chart for each attribute, country and state.
- **Explore** - pick a metric (wheels, orders, revenue, units), group by any attribute or field, optionally split by a second one, and view it as a chart, a heatmap (for example rim x hub) or a table. Filter by date, store, wheel type, country, state and any attribute. Export to CSV.
- **Wheels sold** counts a wheelset as 2 wheels and a single front or rear wheel as 1, read from the product name ("Wheelset" or "Front + Rear" for a set, "Front"/"Rear" for a single). Other products, and wheel services such as rebuilds, wheel shells, per-wheel upgrades, deposits and shipping, count as 0. Units counts every product once per unit.
- **Wheel type** - every line item is marked as a wheelset, a single wheel, a rebuild or none of these, using the same reading of the product name as wheels sold, so sets and single wheels can be filtered apart or compared (see [Wheelsets and single wheels](#wheelsets-and-single-wheels)).
- **Attributes** - map each store’s property keys ("Rim", "Rim Choice", "Select your rim") to one shared attribute so stores line up.
  Values that differ only in case, spacing, quote marks or inch marks (27.5", 27.5″, 27.5 in, 27.5) are combined automatically, as are known spellings of the same option (6 Bolt and 6-Bolt), and you can combine others yourself (for example show "157x12 Super Boost" as "157x12"). The app suggests these when several values differ by the same word.
- **Stores** - connect stores, see sync status, set currency conversion rates.

## Requirements

- Node.js 22 or newer, and pnpm (run `corepack enable` once to get the version this project pins).
- A Cloudflare account. **Use the Workers Paid plan** (about US$5/month). The free plan allows only 10 ms of CPU per request, and importing order files needs more than that. I have not tested on the free plan and expect imports to fail there.
- For each Shopify store: access to the Dev Dashboard of the organisation that owns the store.

## 1. Deploy to Cloudflare

```sh
pnpm install
pnpm exec wrangler login

# Create the database, then paste the database_id it prints into wrangler.jsonc
pnpm exec wrangler d1 create flightdeck
pnpm run db:migrate

pnpm run deploy

# Set the secret (you are prompted for the value)
pnpm exec wrangler secret put APP_SECRET       # long random string, e.g. from: openssl rand -base64 32
```

`pnpm run deploy` prints your URL (`https://flightdeck.<your-subdomain>.workers.dev`).

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

Run `pnpm run db:migrate` (it drops the old sign-in rate-limit table), set up Access as above, deploy, then remove the old secret with `pnpm exec wrangler secret delete ADMIN_PASSWORD`. Keep `APP_SECRET` exactly as it is.

### Upgrading to value grouping

Run `pnpm run db:migrate` before deploying. It adds the column for cleaned values, the table for values you combine, and a **Freehub** attribute that the `freehub` and `driver` keys both feed (unless you had already mapped them). Values imported earlier are cleaned when the store is next re-imported, which the upgrade below does by itself.

### Upgrading to tagged orders and wheel types

Run `pnpm run db:migrate` before deploying. It adds the columns this needs, creates the attributes Brake mount, Hole count, Spokes, Front hub size, Rear hub size and Valve colour, renames Colour to Hub colour if you had not mapped anything to it, maps the property keys found in your orders to their attributes (keys you mapped yourself are left alone), and saves a few combined values you can undo on the Attributes page.

After the deploy each store shows "Import settings changed". Its next sync, whether you press **Sync now** or wait for the scheduled one, runs as a full resync: it imports the orders tagged `wheels`, reads their values with the new rules, and when it finishes removes the orders that are not tagged. Until then the reports show the data as it was. If a store has no orders with the tag, that sync fails with a message and its data is left as it is.

## 2. Create the Shopify app (Dev Dashboard)

The app authenticates with the **client credentials grant**: it exchanges the app’s Client ID and Client secret for a 24-hour Admin API token and renews it automatically. Shopify only allows this when **the app and the store are in the same organisation**.

For each organisation that owns one or more of your stores:

1. Open the [Dev Dashboard](https://dev.shopify.com/dashboard) and create an app.
2. In the app’s version, add the scopes `read_orders`, `read_all_orders` and `read_products`, then release the version. Without `read_all_orders`, Shopify only returns the last 60 days of orders.
3. Under **Settings > Access requests**, enable **Bulk queries**.
4. Install the app on each store in that organisation.
5. Copy the **Client ID** and **Client secret** from the app’s Settings page.

If all your stores are in one organisation, one app covers them all: use the same Client ID and secret for each store. If they are in different organisations, create one app per organisation.

## 3. Connect stores

In the dashboard go to **Stores**, enter the store’s `myshopify.com` domain plus the Client ID and secret, and choose **Connect and import**. The app checks the credentials with Shopify, then imports the full order history. After that it imports changes every 6 hours (edit `triggers.crons` in `wrangler.jsonc` to change this), or on demand with **Sync now**.

Then go to **Attributes** and map the property keys it found to Rim, Hub, Colour and Wheel size (or your own attributes).

## Things to check on your real stores

These depend on your Shopify setup and could not be tested without a real store:

- **Order history.** With only `read_orders`, Shopify returns the last 60 days of orders, even for an app in the store’s own organisation. Add `read_all_orders` to the app version, release it, approve the update in the store admin if asked, then run a **Full resync** for each store (an ordinary sync only fetches orders changed since the last one, so it will not fill in the older history).
- **State and country.** These come from the shipping address (billing address as a fallback), which Shopify treats as protected customer data. Shopify’s docs say this is available to custom apps, but if a sync finishes with a note that no address data was returned, the app needs protected customer data access for addresses enabled in the Dev Dashboard.
- **Error `shop_not_permitted`** when connecting means the app and store are not in the same organisation, or the app is not installed on the store.
- **Export failed with ACCESS_DENIED** means a scope is missing or Bulk queries is not enabled. The message includes Shopify’s own wording, which usually names what is missing.

## Which orders are imported

Only orders carrying the Shopify **order** tag in `ORDER_TAG` (`wheels` in `wrangler.jsonc`) are imported, with all of their line items. The tag is matched whole and ignoring case, so `Wheels` counts and `wheels-deposit` does not. Product tags are not looked at.

- An order that gains the tag is imported at the next sync, and one that loses it is removed at the next sync.
- Set `ORDER_TAG` to `""` to import every order. Changing the tag makes each store run a full resync at its next sync.
- A full resync asks Shopify only for tagged orders. A changes-only sync asks for every order changed since the last one, with its tags, which is how it notices a tag being removed.

## Wheelsets and single wheels

**Wheel type** is worked out from the product name and variant when an order is imported, by the same rule that counts wheels sold. A Wheelset is always 2 wheels and a Single wheel always 1:

| Wheel type | Wheels | Names that have | Examples |
|---|---|---|---|
| Wheelset | 2 | "wheel" with "Wheelset", or with both "Front" and "Rear" | `Wingman Origin Alloy Wheelset \| Clockwork Hubs \| Origin Black Rim Set`, `Yama Hubs + Wingman Origin Custom Alloy Wheels (Front + Rear)` |
| Single wheel | 1 | "wheel" with "Front" or "Rear" | `Wingman Origin Alloy Rear Wheel \| Clockwork Hub \| Origin Black Rim`, `Yama Hub + Wingman Origin Custom Alloy Wheel (Rear Only)` |
| Rebuild | 0 | "Rebuild" | `Rebuild on Origin 29" 32H` |

Everything else (tape, valves, shells, upgrades, deposits, shipping, hubs, rims) has no wheel type and counts as 0 wheels. It is left out when you group by wheel type, unless you tick the box to include it, and it is hidden when you filter by wheel type. A product typed in by hand with a title that says none of these has no wheel type either.

The wheel type also decides how a size is read. On a wheelset, a size of `29`, `29"` or `29" Set` is always shown as **29 Set** (likewise Mullet Set, 27.5 Set, 700c Set). On a single wheel, rebuild or shell, `29"` is shown as **29**: one wheel. The two are never combined, and the app will not suggest combining them.

Other values cleaned by rule, whatever the product: hole counts (`32 / 28 (Recommended)` and `32 / 28` become 32/28, always rear/front; `32H` becomes 32), brake mounts (6-Bolt, Centerlock), freehubs (`HG` becomes Shimano HG, `Micro Spline` becomes Microspline) and hub sizes (`110x20 Boost (2021+) (Black & Silver Only)` becomes 110x20 Boost; `148x12 (Boost)` becomes 148x12). The rules are in `worker/wheels.ts`; when they change, bump `RULES_VERSION` there and each store re-imports at its next sync.

## How the numbers are defined

- **Units** - line item quantity after refunds and removals.
- **Orders** - distinct orders containing matching line items.
- **Revenue** - line total after line-level discounts, before tax and shipping, scaled down for refunded units, multiplied by the store’s conversion rate. Order-level discount codes are not subtracted. Conversion rates are fixed numbers you enter, so combined revenue across currencies is approximate.
- Test orders are always excluded. Cancelled orders are excluded unless you tick **Include cancelled**.
- Dates use each store’s own timezone.
- Attribute values are grouped ignoring upper/lower case ("Black" and "black" are one value). Differently worded values ("Matte Black" vs "Black Matte") are not merged unless you combine them on the Attributes page.
- Units counts each product once per unit, so a wheelset is 1 unit and 2 wheels.

## What is stored

Order id, name, date, status, currency, sales channel, shipping state and country, and for each line item the title, variant, SKU, vendor, product type, quantities, prices and properties. No customer names, emails, phone numbers or street addresses are requested or stored. Shopify client secrets and tokens are encrypted with AES-GCM using `APP_SECRET`.

Line item properties can contain whatever customers type (engraving text, notes). Hidden properties (keys starting with `_`) are imported too and hidden by default on the Attributes page.

## Local development

```sh
cp .dev.vars.example .dev.vars     # set APP_SECRET
pnpm run db:migrate:local
pnpm run dev
```

To try it without a real store, uncomment `SHOPIFY_ORIGIN_OVERRIDE` in `.dev.vars`, run `pnpm run mock:shopify` in a second terminal, and connect a store with any domain, Client ID `mock-au` or `mock-us`, and Client secret `mock-secret`. Never set `SHOPIFY_ORIGIN_OVERRIDE` in production.

Local dev skips Cloudflare Access: the `access.dev` block in `wrangler.jsonc` makes every request count as signed in as `dev@localhost`.

`pnpm test` runs the import and report SQL against SQLite with generated data. `pnpm run typecheck` checks types.

## Project layout

```
worker/index.ts     API routes and the cron handler
worker/shopify.ts   client credentials grant, GraphQL client, bulk export query
worker/sync.ts      the import Workflow (start export, wait, import in chunks, remove what a full resync did not see)
worker/ingest.ts    parses the export, keeps tagged orders, and writes rows to D1
worker/values.ts    cleaning that applies to every property value (case, spacing, quote and inch marks)
worker/wheels.ts    wheelset or single wheel from the product title, and the value rules that depend on it
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
| `wrangler.jsonc` vars | `ORDER_TAG` | Only orders with this Shopify order tag are imported (`wheels`). Empty imports every order. |
| `wrangler.jsonc` vars | `INGEST_CHUNK_BYTES` | Bytes of the export processed per Workflow step. |
| `wrangler.jsonc` triggers | `crons` | Automatic sync schedule. |
| `wrangler.jsonc` vars | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Optional. Only for an Access application set up by hostname in Zero Trust. |
| `wrangler.jsonc` access | `dev` | The identity used in local dev. Ignored when deployed. |
| secret | `APP_SECRET` | Encrypts the stored Shopify credentials. |

## Limits worth knowing

- D1 databases hold up to 10 GB on the paid plan. As a rough guide, 100,000 orders with properties is in the low hundreds of MB.
- Deleted orders in Shopify are not removed by incremental syncs. A **Full resync** re-imports everything and then removes whatever Shopify no longer returned. The store’s existing data stays visible while it runs.
- Reports return at most 20,000 group combinations.
