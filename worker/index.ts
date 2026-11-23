import { Hono } from "hono";
import { requireAccess, sessionStatus } from "./auth";
import { encrypt } from "./crypto";
import type { Env, StoreRow } from "./env";
import { normaliseKey } from "./ingest";
import { BUILTIN_DIMS, ReportError, type ReportRequest, buildReport } from "./report";
import { SHOP_INFO, ShopifyError, gql, hasScope, normaliseShop, requestToken } from "./shopify";
import { SyncWorkflow, startSync } from "./sync";

export { SyncWorkflow };

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof ReportError || err instanceof ShopifyError) return c.json({ error: err.message }, 400);
  console.error(err);
  return c.json({ error: (err as Error).message || "Something went wrong" }, 500);
});

// State-changing requests must be JSON, which a cross-site form or link cannot send without a CORS preflight.
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method) && !(c.req.header("Content-Type") ?? "").startsWith("application/json")) {
    return c.json({ error: "Expected application/json" }, 415);
  }
  await next();
});

app.get("/api/session", sessionStatus);
app.use("/api/*", requireAccess);

// ---------- Stores ----------

const STORE_COLUMNS = `s.id, s.shop, s.label, s.client_id, s.scopes, s.shop_name, s.currency, s.timezone, s.fx_rate,
  s.sync_cursor, s.last_sync_at, s.last_sync_status, s.last_sync_error, s.created_at`;

app.get("/api/stores", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${STORE_COLUMNS},
       (SELECT COUNT(*) FROM orders o WHERE o.store_id = s.id) AS order_count,
       (SELECT MIN(day) FROM orders o WHERE o.store_id = s.id) AS first_day
     FROM stores s ORDER BY s.label`,
  ).all();
  return c.json({ stores: results });
});

/** Proves the credentials work and returns what Shopify says about the shop. */
async function verifyCredentials(env: Env, shop: string, clientId: string, clientSecret: string) {
  const tok = await requestToken(env, shop, clientId, clientSecret);
  if (!hasScope(tok.scope, "orders")) {
    throw new ShopifyError(
      `Connected, but the app has no read_orders scope on this store (granted: ${tok.scope || "none"}). Add read_orders and read_products to the app version in the Dev Dashboard, release it, then approve the update in the store admin.`,
    );
  }
  const info = await gql<{ shop: { name: string; currencyCode: string; ianaTimezone: string } }>(env, shop, tok.access_token, SHOP_INFO);
  return { tok, info: info.shop };
}

app.post("/api/stores", async (c) => {
  const body = await c.req.json<{ shop?: string; label?: string; clientId?: string; clientSecret?: string }>();
  const shop = normaliseShop(body.shop ?? "");
  const clientId = (body.clientId ?? "").trim();
  const clientSecret = (body.clientSecret ?? "").trim();
  if (!shop) return c.json({ error: "Enter the store’s myshopify.com domain, for example my-store.myshopify.com" }, 400);
  if (!clientId || !clientSecret) return c.json({ error: "Client ID and client secret are required" }, 400);
  if (await c.env.DB.prepare("SELECT 1 FROM stores WHERE shop = ?").bind(shop).first()) return c.json({ error: "That store is already connected" }, 409);

  const { tok, info } = await verifyCredentials(c.env, shop, clientId, clientSecret);
  const row = await c.env.DB.prepare(
    `INSERT INTO stores (shop, label, client_id, client_secret_enc, access_token_enc, token_expires_at, scopes, shop_name, currency, timezone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      shop,
      (body.label ?? "").trim() || info.name || shop,
      clientId,
      await encrypt(c.env.APP_SECRET, clientSecret),
      await encrypt(c.env.APP_SECRET, tok.access_token),
      Date.now() + tok.expires_in * 1000,
      tok.scope ?? "",
      info.name,
      info.currencyCode,
      info.ianaTimezone,
    )
    .first<{ id: number }>();
  const sync = await startSync(c.env, row!.id, "full");
  const warnings: string[] = [];
  if (!hasScope(tok.scope, "all_orders")) warnings.push("The app has no read_all_orders scope, so only the last 60 days of orders will be imported.");
  if (!hasScope(tok.scope, "products")) warnings.push("The app has no read_products scope, so product type will be blank.");
  return c.json({ id: row!.id, runId: sync.runId, warnings });
});

app.patch("/api/stores/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const store = await c.env.DB.prepare("SELECT * FROM stores WHERE id = ?").bind(id).first<StoreRow>();
  if (!store) return c.json({ error: "Store not found" }, 404);
  const body = await c.req.json<{ label?: string; fxRate?: number; clientId?: string; clientSecret?: string }>();

  if (body.clientId || body.clientSecret) {
    const clientId = (body.clientId ?? "").trim();
    const clientSecret = (body.clientSecret ?? "").trim();
    if (!clientId || !clientSecret) return c.json({ error: "Enter both the client ID and the client secret" }, 400);
    const { tok } = await verifyCredentials(c.env, store.shop, clientId, clientSecret);
    await c.env.DB.prepare("UPDATE stores SET client_id = ?, client_secret_enc = ?, access_token_enc = ?, token_expires_at = ?, scopes = ? WHERE id = ?")
      .bind(clientId, await encrypt(c.env.APP_SECRET, clientSecret), await encrypt(c.env.APP_SECRET, tok.access_token), Date.now() + tok.expires_in * 1000, tok.scope ?? "", id)
      .run();
  }
  if (typeof body.label === "string" && body.label.trim()) {
    await c.env.DB.prepare("UPDATE stores SET label = ? WHERE id = ?").bind(body.label.trim(), id).run();
  }
  if (body.fxRate !== undefined) {
    const fx = Number(body.fxRate);
    if (!Number.isFinite(fx) || fx <= 0) return c.json({ error: "Conversion rate must be a positive number" }, 400);
    await c.env.DB.prepare("UPDATE stores SET fx_rate = ? WHERE id = ?").bind(fx, id).run();
  }
  return c.json({ ok: true });
});

app.delete("/api/stores/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM line_item_props WHERE store_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM line_items WHERE store_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM orders WHERE store_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM sync_runs WHERE store_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM stores WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

app.post("/api/stores/:id/sync", async (c) => {
  const body = await c.req.json<{ full?: boolean }>().catch(() => ({ full: false }));
  const result = await startSync(c.env, Number(c.req.param("id")), body.full ? "full" : "incremental");
  return c.json(result);
});

app.get("/api/runs", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, s.label AS store_label FROM sync_runs r JOIN stores s ON s.id = r.store_id ORDER BY r.id DESC LIMIT 30`,
  ).all();
  return c.json({ runs: results });
});

// ---------- Attributes (line item properties) ----------

app.get("/api/attributes", async (c) => {
  const [dims, keys] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT id, name, sort FROM dimensions ORDER BY sort, name"),
    c.env.DB.prepare(
      `SELECT p.key, COUNT(*) AS line_items, COUNT(DISTINCT p.store_id) AS stores, COUNT(DISTINCT p.value) AS distinct_values,
              k.dimension_id
       FROM line_item_props p LEFT JOIN dimension_keys k ON k.key = p.key
       GROUP BY p.key ORDER BY line_items DESC LIMIT 500`,
    ),
  ]);
  // Mapped keys that no longer appear in any order are still listed so they can be unmapped.
  const orphan = await c.env.DB.prepare(
    `SELECT k.key, 0 AS line_items, 0 AS stores, 0 AS distinct_values, k.dimension_id FROM dimension_keys k
     WHERE NOT EXISTS (SELECT 1 FROM line_item_props p WHERE p.key = k.key)`,
  ).all();
  return c.json({ dimensions: dims.results, keys: [...keys.results, ...orphan.results] });
});

app.get("/api/attributes/values", async (c) => {
  const key = normaliseKey(c.req.query("key"));
  const { results } = await c.env.DB.prepare(
    `SELECT MIN(value) AS value, COUNT(*) AS line_items FROM line_item_props WHERE key = ? GROUP BY value COLLATE NOCASE ORDER BY line_items DESC LIMIT 12`,
  )
    .bind(key)
    .all();
  return c.json({ values: results });
});

app.put("/api/attributes/map", async (c) => {
  const body = await c.req.json<{ key?: string; dimensionId?: number | null }>();
  const key = normaliseKey(body.key);
  if (!key) return c.json({ error: "Missing key" }, 400);
  if (body.dimensionId == null) {
    await c.env.DB.prepare("DELETE FROM dimension_keys WHERE key = ?").bind(key).run();
  } else {
    await c.env.DB.prepare("INSERT INTO dimension_keys (key, dimension_id) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET dimension_id = excluded.dimension_id")
      .bind(key, Number(body.dimensionId))
      .run();
  }
  return c.json({ ok: true });
});

app.post("/api/dimensions", async (c) => {
  const name = ((await c.req.json<{ name?: string }>()).name ?? "").trim();
  if (!name) return c.json({ error: "Name is required" }, 400);
  if (await c.env.DB.prepare("SELECT 1 FROM dimensions WHERE name = ? COLLATE NOCASE").bind(name).first()) return c.json({ error: "An attribute with that name already exists" }, 409);
  const row = await c.env.DB.prepare("INSERT INTO dimensions (name, sort) VALUES (?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM dimensions)) RETURNING id").bind(name).first<{ id: number }>();
  return c.json({ id: row!.id });
});

app.patch("/api/dimensions/:id", async (c) => {
  const name = ((await c.req.json<{ name?: string }>()).name ?? "").trim();
  if (!name) return c.json({ error: "Name is required" }, 400);
  await c.env.DB.prepare("UPDATE dimensions SET name = ? WHERE id = ?").bind(name, Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

app.delete("/api/dimensions/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM dimension_keys WHERE dimension_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM dimensions WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

// ---------- Reporting ----------

app.get("/api/meta", async (c) => {
  const [dims, props, range, settings, stores] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT d.id, d.name, (SELECT COUNT(*) FROM dimension_keys k WHERE k.dimension_id = d.id) AS keys FROM dimensions d ORDER BY d.sort, d.name`,
    ),
    c.env.DB.prepare(
      `SELECT p.key, COUNT(*) AS n FROM line_item_props p
       WHERE NOT EXISTS (SELECT 1 FROM dimension_keys k WHERE k.key = p.key)
       GROUP BY p.key ORDER BY n DESC LIMIT 100`,
    ),
    c.env.DB.prepare("SELECT MIN(day) AS first_day, MAX(day) AS last_day, COUNT(*) AS orders FROM orders"),
    c.env.DB.prepare("SELECT key, value FROM settings"),
    c.env.DB.prepare("SELECT id, label, currency, fx_rate FROM stores ORDER BY label"),
  ]);
  const settingMap = Object.fromEntries((settings.results as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
  const dimensions = [
    ...(dims.results as Array<{ id: number; name: string; keys: number }>).map((d) => ({ id: `dim:${d.id}`, label: d.name, group: "Attributes", mapped: d.keys > 0 })),
    ...BUILTIN_DIMS.map(({ id, label, group }) => ({ id, label, group, mapped: true })),
    ...(props.results as Array<{ key: string }>).map((p) => ({ id: `prop:${p.key}`, label: p.key, group: "Unmapped properties", mapped: true })),
  ];
  return c.json({
    dimensions,
    stores: stores.results,
    range: range.results[0],
    reportingCurrency: settingMap.reporting_currency ?? "AUD",
  });
});

app.put("/api/settings", async (c) => {
  const body = await c.req.json<{ reportingCurrency?: string }>();
  const cur = (body.reportingCurrency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) return c.json({ error: "Use a three-letter currency code such as AUD" }, 400);
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('reporting_currency', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(cur).run();
  return c.json({ ok: true });
});

app.post("/api/report", async (c) => {
  const req = await c.req.json<ReportRequest>();
  const q = buildReport(req);
  const [rows, totals] = await c.env.DB.batch([c.env.DB.prepare(q.sql).bind(...q.params), c.env.DB.prepare(q.totalsSql).bind(...q.totalsParams)]);
  return c.json({ rows: rows.results, totals: totals.results[0] ?? null });
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export default {
  fetch: app.fetch,

  /** Cron trigger: incremental sync for every connected store. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const { results } = await env.DB.prepare("SELECT id FROM stores").all<{ id: number }>();
    for (const s of results) {
      ctx.waitUntil(startSync(env, s.id, "incremental").catch((err) => console.error(`Sync for store ${s.id} did not start`, err)));
    }
  },
} satisfies ExportedHandler<Env>;
