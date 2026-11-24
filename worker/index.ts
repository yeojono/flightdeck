import { type Context, Hono } from "hono";
import { requireAccess, sessionStatus } from "./auth";
import { BUMP_DATA, BUMP_VIEW, cached, digest } from "./cache";
import { encrypt } from "./crypto";
import type { Env, StoreRow } from "./env";
import { importScope, normaliseKey } from "./ingest";
import { normaliseValue } from "./values";
import { BUILTIN_DIMS, type ReportBase, ReportError, type ReportSpec, finishReports, planReports } from "./report";
import { SHOP_INFO, ShopifyError, gql, hasScope, normaliseShop, orderTag, requestToken } from "./shopify";
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

// Anything saved through the API can change what reports show (a mapping, a label, a conversion
// rate), so reports cached before it are no longer served. Imports do the same for the data.
const CHANGES_NOTHING = /^\/api\/(reports|stores\/\d+\/sync)$/;
app.use("/api/*", async (c, next) => {
  await next();
  if (!["GET", "HEAD"].includes(c.req.method) && c.res.ok && !CHANGES_NOTHING.test(c.req.path)) await c.env.DB.prepare(BUMP_VIEW).run();
});

type Ctx = Context<{ Bindings: Env }>;

// ---------- Counts that only change when orders are imported ----------
// Each is one pass over a table, so it is worked out once per import and kept (see cache.ts).

interface OrderStats {
  store_id: number;
  orders: number;
  first_day: string | null;
  last_day: string | null;
}
async function orderStats(c: Ctx): Promise<OrderStats[]> {
  const json = await cached(c.env, c.executionCtx, "stats:orders", "data", async () => {
    const { results } = await c.env.DB.prepare("SELECT store_id, COUNT(*) AS orders, MIN(day) AS first_day, MAX(day) AS last_day FROM orders GROUP BY store_id").all();
    return results;
  });
  return JSON.parse(json);
}

interface PropStats {
  key: string;
  line_items: number;
  stores: number;
  distinct_values: number;
}
/** Every line item property key in use, most used first. */
async function propStats(c: Ctx): Promise<PropStats[]> {
  const json = await cached(c.env, c.executionCtx, "stats:props", "data", async () => {
    const { results } = await c.env.DB.prepare(
      `SELECT key, COUNT(*) AS line_items, COUNT(DISTINCT store_id) AS stores, COUNT(DISTINCT lower(COALESCE(norm, value))) AS distinct_values
       FROM line_item_props GROUP BY key`,
    ).all<PropStats>();
    return results.sort((a, b) => b.line_items - a.line_items);
  });
  return JSON.parse(json);
}

// ---------- Stores ----------

const STORE_COLUMNS = `s.id, s.shop, s.label, s.client_id, s.scopes, s.shop_name, s.currency, s.timezone, s.fx_rate,
  s.sync_cursor, s.last_sync_at, s.last_sync_status, s.last_sync_error, s.created_at`;

app.get("/api/stores", async (c) => {
  // needs_resync: imported before the current tag or cleaning rules, so the next sync re-imports everything.
  const [{ results }, stats] = await Promise.all([
    c.env.DB.prepare(`SELECT ${STORE_COLUMNS}, (s.sync_cursor IS NOT NULL AND s.sync_scope IS NOT ?1) AS needs_resync FROM stores s ORDER BY s.label`)
      .bind(importScope(c.env))
      .all<{ id: number }>(),
    orderStats(c),
  ]);
  const byStore = new Map(stats.map((s) => [s.store_id, s]));
  return c.json({ stores: results.map((s) => ({ ...s, order_count: byStore.get(s.id)?.orders ?? 0, first_day: byStore.get(s.id)?.first_day ?? null })) });
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
    c.env.DB.prepare(BUMP_DATA),
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
  const [[dims, mapped], props] = await Promise.all([
    c.env.DB.batch<{ key: string; dimension_id: number }>([
      c.env.DB.prepare("SELECT id, name, sort FROM dimensions ORDER BY sort, name"),
      c.env.DB.prepare("SELECT key, dimension_id FROM dimension_keys ORDER BY key"),
    ]),
    propStats(c),
  ]);
  const dimensionOf = new Map(mapped.results.map((k) => [k.key, k.dimension_id]));
  const inUse = new Set(props.map((p) => p.key));
  const keys = [
    ...props.slice(0, 500).map((p) => ({ ...p, dimension_id: dimensionOf.get(p.key) ?? null })),
    // Mapped keys that no longer appear in any order are still listed so they can be unmapped.
    ...mapped.results.filter((k) => !inUse.has(k.key)).map((k) => ({ key: k.key, line_items: 0, stores: 0, distinct_values: 0, dimension_id: k.dimension_id })),
  ];
  return c.json({ dimensions: dims.results, keys });
});

app.get("/api/attributes/values", async (c) => {
  const key = normaliseKey(c.req.query("key"));
  const { results } = await c.env.DB.prepare(
    `SELECT MIN(COALESCE(norm, value)) AS value, COUNT(*) AS line_items FROM line_item_props WHERE key = ?
     GROUP BY COALESCE(norm, value) COLLATE NOCASE ORDER BY line_items DESC LIMIT 12`,
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
    c.env.DB.prepare("DELETE FROM value_groups WHERE dimension_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM dimension_keys WHERE dimension_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM dimensions WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

const MAX_VALUES = 300;

/** Every value of an attribute (after cleaning), with what it is shown as if it was combined with others. */
app.get("/api/dimensions/:id/values", async (c) => {
  const id = Number(c.req.param("id"));
  const { results } = await c.env.DB.prepare(
    `SELECT MIN(COALESCE(p.norm, p.value)) AS value, COUNT(*) AS line_items, MIN(g.label) AS label
     FROM line_item_props p JOIN dimension_keys k ON k.key = p.key AND k.dimension_id = ?1
     LEFT JOIN value_groups g ON g.dimension_id = ?1 AND g.value = COALESCE(p.norm, p.value)
     GROUP BY COALESCE(p.norm, p.value) COLLATE NOCASE ORDER BY line_items DESC LIMIT ${MAX_VALUES + 1}`,
  )
    .bind(id)
    .all();
  return c.json({ values: results.slice(0, MAX_VALUES), more: results.length > MAX_VALUES });
});

/** Shows the given values of an attribute as one label in reports, or (label null) shows them as themselves again. */
app.put("/api/dimensions/:id/groups", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ values?: unknown[]; label?: string | null }>();
  const values = [...new Set((body.values ?? []).map((v) => normaliseValue(String(v ?? ""))).filter(Boolean))].slice(0, 1000);
  if (!values.length) return c.json({ error: "Pick at least one value" }, 400);
  const label = body.label == null ? null : String(body.label).replace(/\s+/g, " ").trim().slice(0, 500);
  if (label === "") return c.json({ error: "Enter a name to show them as" }, 400);
  if (!(await c.env.DB.prepare("SELECT 1 FROM dimensions WHERE id = ?").bind(id).first())) return c.json({ error: "Attribute not found" }, 404);
  const json = JSON.stringify(values);
  if (label === null) {
    await c.env.DB.prepare("DELETE FROM value_groups WHERE dimension_id = ?1 AND value IN (SELECT value FROM json_each(?2))").bind(id, json).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO value_groups (dimension_id, value, label) SELECT ?1, value, ?3 FROM json_each(?2) WHERE true
       ON CONFLICT (dimension_id, value) DO UPDATE SET label = excluded.label`,
    )
      .bind(id, json, label)
      .run();
  }
  return c.json({ ok: true });
});

// ---------- Reporting ----------

app.get("/api/meta", async (c) => {
  const [[dims, mapped, settings, stores], props, orders] = await Promise.all([
    c.env.DB.batch([
      c.env.DB.prepare("SELECT id, name FROM dimensions ORDER BY sort, name"),
      c.env.DB.prepare("SELECT key, dimension_id FROM dimension_keys"),
      c.env.DB.prepare("SELECT key, value FROM settings"),
      c.env.DB.prepare("SELECT id, label, currency, fx_rate, (sync_cursor IS NOT NULL AND sync_scope IS NOT ?1) AS needs_resync FROM stores ORDER BY label").bind(importScope(c.env)),
    ]),
    propStats(c),
    orderStats(c),
  ]);
  const settingMap = Object.fromEntries((settings.results as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
  const keys = mapped.results as Array<{ key: string; dimension_id: number }>;
  const mappedKeys = new Set(keys.map((k) => k.key));
  const fed = new Set(keys.map((k) => k.dimension_id));
  const dimensions = [
    ...(dims.results as Array<{ id: number; name: string }>).map((d) => ({ id: `dim:${d.id}`, label: d.name, group: "Attributes", mapped: fed.has(d.id), optional: true })),
    ...BUILTIN_DIMS.map(({ id, label, group, optional }) => ({ id, label, group, mapped: true, optional: !!optional })),
    ...props
      .filter((p) => !mappedKeys.has(p.key))
      .slice(0, 100)
      .map((p) => ({ id: `prop:${p.key}`, label: p.key, group: "Unmapped properties", mapped: true, optional: true })),
  ];
  const days = (pick: (s: OrderStats) => string | null) => orders.map(pick).filter((d): d is string => !!d).sort();
  return c.json({
    dimensions,
    stores: stores.results,
    range: { first_day: days((s) => s.first_day)[0] ?? null, last_day: days((s) => s.last_day).pop() ?? null, orders: orders.reduce((n, s) => n + s.orders, 0) },
    reportingCurrency: settingMap.reporting_currency ?? "AUD",
    orderTag: orderTag(c.env) || null,
  });
});

app.put("/api/settings", async (c) => {
  const body = await c.req.json<{ reportingCurrency?: string }>();
  const cur = (body.reportingCurrency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) return c.json({ error: "Use a three-letter currency code such as AUD" }, 400);
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('reporting_currency', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(cur).run();
  return c.json({ ok: true });
});

/**
 * Any number of reports over the same filters, from one read of the matching line items. The
 * Overview page asks for all of its charts at once, so it costs one read rather than one per chart.
 */
app.post("/api/reports", async (c) => {
  const body = await c.req.json<ReportBase & { reports?: ReportSpec[] }>();
  // Spelled out field by field so the same question always has the same cache key.
  const base: ReportBase = {
    from: body.from || null,
    to: body.to || null,
    search: body.search?.trim() || null,
    includeCancelled: !!body.includeCancelled,
    filters: (Array.isArray(body.filters) ? body.filters : []).filter((f) => f?.values?.length).map((f) => ({ dim: String(f.dim), values: f.values.map(String) })),
  };
  const specs: ReportSpec[] = (Array.isArray(body.reports) ? body.reports : []).map((r) => ({
    groupBy: (Array.isArray(r?.groupBy) ? r.groupBy : []).map(String),
    includeMissing: !!r?.includeMissing,
    limit: Number(r?.limit) || 0,
  }));
  // A bad request is turned away here, before anything is read.
  const plan = planReports(base, specs);
  const json = await cached(c.env, c.executionCtx, `report:${await digest([base, specs])}`, "view", async () => {
    const results = await c.env.DB.batch(plan.statements.map((s) => c.env.DB.prepare(s.sql).bind(...s.params)));
    return finishReports(
      plan,
      results.map((r) => r.results),
    );
  });
  return c.body(`{"reports":${json}}`, 200, { "Content-Type": "application/json" });
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
