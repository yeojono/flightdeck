import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env, StoreRow, SyncParams } from "./env";
import { type Carry, SWEEP_UNSEEN, completeLineBytes, importScope, makeDayFormatter, parseJsonl, writeParsed } from "./ingest";
import { BULK_START, BULK_STATUS, SHOP_INFO, ShopifyError, buildBulkQuery, getAccessToken, gql, hasScope, orderTag } from "./shopify";

const ACTIVE = ["queued", "exporting", "importing"];
const MAX_POLLS = 600;

async function loadStore(env: Env, id: number): Promise<StoreRow> {
  const store = await env.DB.prepare("SELECT * FROM stores WHERE id = ?").bind(id).first<StoreRow>();
  if (!store) throw new NonRetryableError("Store no longer exists");
  return store;
}

/** Queues a sync for a store unless one is already running. Returns the run id. */
export async function startSync(env: Env, storeId: number, requested: "full" | "incremental"): Promise<{ runId: number; started: boolean }> {
  const store = await env.DB.prepare("SELECT id, sync_cursor, sync_scope FROM stores WHERE id = ?")
    .bind(storeId)
    .first<{ id: number; sync_cursor: string | null; sync_scope: string | null }>();
  if (!store) throw new Error("Store not found");
  const active = await env.DB.prepare(
    `SELECT id FROM sync_runs WHERE store_id = ? AND status IN ('queued','exporting','importing')
     AND started_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-12 hours') ORDER BY id DESC LIMIT 1`,
  )
    .bind(storeId)
    .first<{ id: number }>();
  if (active) return { runId: active.id, started: false };

  const kind = store.sync_cursor && store.sync_scope === importScope(env) ? requested : "full";
  const run = await env.DB.prepare("INSERT INTO sync_runs (store_id, kind, status) VALUES (?, ?, 'queued') RETURNING id").bind(storeId, kind).first<{ id: number }>();
  const runId = run!.id;
  try {
    await env.SYNC.create({ id: `store-${storeId}-run-${runId}`, params: { storeId, runId, kind } });
  } catch (err) {
    await markRun(env, storeId, runId, "failed", `Could not start the sync workflow: ${(err as Error).message}`);
    throw err;
  }
  await env.DB.prepare("UPDATE stores SET last_sync_status = 'running', last_sync_error = NULL WHERE id = ?").bind(storeId).run();
  return { runId, started: true };
}

async function markRun(env: Env, storeId: number, runId: number, status: string, message: string | null) {
  const finished = ACTIVE.includes(status) ? null : new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE sync_runs SET status = ?, message = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?").bind(status, message, finished, runId),
    ...(finished
      ? [env.DB.prepare("UPDATE stores SET last_sync_status = ?, last_sync_error = ?, last_sync_at = ? WHERE id = ?").bind(status, status === "failed" ? message : null, finished, storeId)]
      : []),
  ]);
}

interface ChunkResult {
  next: number;
  total: number;
  orders: number;
  lineItems: number;
  withAddress: number;
  carry: Carry | null;
}

interface ChunkInput {
  storeId: number;
  runId: number;
  url: string;
  start: number;
  total: number;
  timezone: string | null;
  tag: string | null;
  carry: Carry | null;
}

/** Downloads one byte range of the export, cut at a line boundary, and writes it to D1. */
async function importChunk(env: Env, { storeId, runId, url, start, total, timezone, tag, carry }: ChunkInput): Promise<ChunkResult> {
  let size = Math.max(64_000, Number(env.INGEST_CHUNK_BYTES) || 4_000_000);
  for (;;) {
    const end = Math.min(start + size, total) - 1;
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!res.ok) throw new Error(`Downloading the Shopify export failed: HTTP ${res.status}`);
    let buf = new Uint8Array(await res.arrayBuffer());
    if (res.status === 200) {
      // Server ignored the Range header and sent the whole file.
      total = buf.length;
      buf = buf.subarray(start, Math.min(start + size, total));
    } else {
      const m = res.headers.get("Content-Range")?.match(/\/(\d+)$/);
      if (m) total = Number(m[1]);
    }
    const isLast = start + buf.length >= total;
    const usable = completeLineBytes(buf, isLast);
    if (usable === -1) {
      // A single line is longer than the chunk: read a bigger range.
      if (size > 64_000_000) throw new NonRetryableError("Export contains a line larger than 64 MB");
      size *= 4;
      continue;
    }
    const parsed = parseJsonl(new TextDecoder().decode(buf.subarray(0, usable)), makeDayFormatter(timezone), { tag, carry });
    await writeParsed(env.DB, storeId, runId, parsed);
    return { next: start + usable, total, orders: parsed.orders.length, lineItems: parsed.lineItems.length, withAddress: parsed.withAddress, carry: parsed.carry };
  }
}

function explainBulkFailure(code: string | null, detail?: string): string {
  if (code === "ACCESS_DENIED") {
    return (detail ? `Shopify denied the export: ${detail} ` : "Shopify denied the export (ACCESS_DENIED). ") + "Check the app version includes the read_orders and read_products scopes, and that Bulk queries is enabled under Settings > Access requests for the app in the Dev Dashboard.";
  }
  return `Shopify could not complete the export (${code ?? "unknown error"}). Try again; if it keeps failing, run a full resync.`;
}

export class SyncWorkflow extends WorkflowEntrypoint<Env, SyncParams> {
  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep) {
    const { storeId, runId, kind } = event.payload;
    const env = this.env;
    const retry = { retries: { limit: 4, delay: "10 seconds" as const, backoff: "exponential" as const }, timeout: "10 minutes" as const };

    try {
      // 1. Refresh the token, read shop settings, and work out what to export.
      const prep = await step.do("prepare", retry, async () => {
        const store = await loadStore(env, storeId);
        let token: string;
        try {
          token = await getAccessToken(env, store);
        } catch (err) {
          if (err instanceof ShopifyError) throw new NonRetryableError(err.message);
          throw err;
        }
        if (!hasScope(store.scopes, "orders")) {
          throw new NonRetryableError("The app does not have the read_orders scope on this store. Add it to the app version in the Dev Dashboard, release it, and approve the update in the store admin.");
        }
        const info = await gql<{ shop: { name: string; currencyCode: string; ianaTimezone: string } }>(env, store.shop, token, SHOP_INFO);
        await env.DB.prepare("UPDATE stores SET shop_name = ?, currency = ?, timezone = ? WHERE id = ?")
          .bind(info.shop.name, info.shop.currencyCode, info.shop.ianaTimezone, storeId)
          .run();
        return {
          // Overlap by five minutes so nothing updated mid-export is missed next time.
          nextCursor: new Date(Date.now() - 5 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
          since: kind === "full" ? null : store.sync_cursor,
          timezone: info.shop.ianaTimezone as string | null,
          withProducts: hasScope(store.scopes, "products"),
          allOrders: hasScope(store.scopes, "all_orders"),
          tag: orderTag(env) || null,
          scope: importScope(env),
        };
      });

      // 2. Ask Shopify to export the orders as a bulk operation.
      const bulkId = await step.do("start export", retry, async () => {
        const store = await loadStore(env, storeId);
        const token = await getAccessToken(env, store);
        let data: any;
        try {
          // A full resync asks Shopify for tagged orders only. A changes-only sync asks for every changed order
          // with its tags, so an order that has lost the tag is noticed and removed.
          const tag = prep.tag ?? null;
          const q = buildBulkQuery({ since: prep.since, withProducts: prep.withProducts, tag: kind === "full" ? tag : null, withTags: !!tag });
          data = await gql(env, store.shop, token, BULK_START, { q });
        } catch (err) {
          if (err instanceof ShopifyError && err.code === "ACCESS_DENIED") throw new NonRetryableError(explainBulkFailure("ACCESS_DENIED", err.message));
          // Other GraphQL errors (they carry a code) will not change on retry; HTTP and network errors might.
          if (err instanceof ShopifyError && err.code && err.code !== "INTERNAL_SERVER_ERROR") {
            throw new NonRetryableError(`Shopify rejected the export: ${err.message} (${err.code})`);
          }
          throw err;
        }
        const result = data?.bulkOperationRunQuery;
        if (!result) throw new Error("Shopify returned no result for the export request");
        if (result.userErrors?.length) {
          throw new NonRetryableError("Shopify rejected the export: " + result.userErrors.map((e: { message: string }) => e.message).join("; "));
        }
        const id: string = result.bulkOperation.id;
        await env.DB.prepare("UPDATE sync_runs SET status = 'exporting', bulk_id = ? WHERE id = ?").bind(id, runId).run();
        return id;
      });

      // 3. Wait for the export to finish.
      let op: { status: string; errorCode: string | null; url: string | null; fileSize: number };
      for (let i = 0; ; i++) {
        op = await step.do(`check export ${i}`, retry, async () => {
          const store = await loadStore(env, storeId);
          const token = await getAccessToken(env, store);
          const data = await gql<{ bulkOperation: any }>(env, store.shop, token, BULK_STATUS, { id: bulkId });
          const b = data.bulkOperation;
          if (!b) throw new NonRetryableError("Shopify no longer knows about this export");
          return { status: b.status as string, errorCode: (b.errorCode ?? null) as string | null, url: (b.url ?? null) as string | null, fileSize: Number(b.fileSize) || 0 };
        });
        if (op.status === "COMPLETED") break;
        if (["FAILED", "CANCELED", "CANCELING", "EXPIRED"].includes(op.status)) throw new NonRetryableError(explainBulkFailure(op.errorCode ?? op.status));
        if (i >= MAX_POLLS) throw new NonRetryableError("Timed out waiting for Shopify to finish the export");
        await step.sleep(`wait ${i}`, Math.min(5 + i * 5, 90) * 1000);
      }

      // 4. Import the file in line-aligned byte ranges, one workflow step per range.
      let orders = 0;
      let lineItems = 0;
      let withAddress = 0;
      if (op.url) {
        const url = op.url;
        if (!env.SHOPIFY_ORIGIN_OVERRIDE && !url.startsWith("https://")) throw new NonRetryableError("Unexpected export URL");
        let offset = 0;
        let total = op.fileSize || Number.MAX_SAFE_INTEGER;
        let carry: Carry | null = null;
        for (let n = 0; offset < total; n++) {
          const from = offset;
          const sums = { orders, lineItems };
          const input: ChunkInput = { storeId, runId, url, start: from, total, timezone: prep.timezone, tag: prep.tag ?? null, carry };
          const r = await step.do(`import ${n}`, retry, async () => {
            await loadStore(env, storeId);
            const res = await importChunk(env, input);
            await env.DB.prepare("UPDATE sync_runs SET status = 'importing', orders = ?, line_items = ?, bytes_done = ?, bytes_total = ? WHERE id = ?")
              .bind(sums.orders + res.orders, sums.lineItems + res.lineItems, res.next, res.total, runId)
              .run();
            return res;
          });
          if (r.next <= from) throw new NonRetryableError("Import made no progress");
          offset = r.next;
          total = r.total;
          orders += r.orders;
          lineItems += r.lineItems;
          withAddress += r.withAddress;
          carry = r.carry ?? null;
        }
      }

      // 5. Record success and move the cursor forward.
      await step.do("finish", retry, async () => {
        const warnings: string[] = [];
        if (orders > 0 && withAddress === 0) {
          warnings.push("Imported, but Shopify returned no address data, so state and country reports will be empty. The app may need protected customer data access for addresses.");
        }
        // `allOrders` is undefined for runs that prepared before this check existed.
        if (kind === "full" && prep.allOrders === false) {
          warnings.push("Only the last 60 days of orders were available: add the read_all_orders scope to the app, then run a full resync.");
        }
        // `scope` is undefined for runs that prepared before full resyncs stopped emptying the store first.
        if (kind === "full" && prep.scope) {
          if (prep.tag && orders === 0) {
            const had = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE store_id = ?").bind(storeId).first<{ n: number }>();
            if (had?.n) {
              throw new NonRetryableError(
                `Shopify returned no orders tagged “${prep.tag}” for this store, so its ${had.n.toLocaleString("en-AU")} imported orders were left as they are. ` +
                  "Check the tag is on the orders in Shopify, or change ORDER_TAG in wrangler.jsonc and deploy again.",
              );
            }
            warnings.push(`No orders tagged “${prep.tag}” were found in this store.`);
          }
          // Everything this run did not write is gone from Shopify or no longer tagged.
          await env.DB.batch(SWEEP_UNSEEN.map((sql) => env.DB.prepare(sql).bind(storeId, runId)));
          await env.DB.prepare("UPDATE stores SET sync_scope = ? WHERE id = ?").bind(prep.scope, storeId).run();
        }
        const warning = warnings.length ? warnings.join(" ") : null;
        await env.DB.prepare("UPDATE stores SET sync_cursor = ? WHERE id = ?").bind(prep.nextCursor, storeId).run();
        await env.DB.prepare("UPDATE sync_runs SET orders = ?, line_items = ? WHERE id = ?").bind(orders, lineItems, runId).run();
        await markRun(env, storeId, runId, "complete", warning);
        // Refresh the query planner's statistics now that the data has changed.
        await env.DB.prepare("PRAGMA optimize").run().catch(() => {});
      });
      return { orders, lineItems };
    } catch (err) {
      // An error thrown inside a step comes back with its class name in front of the message.
      const message = ((err as Error)?.message ?? String(err)).replace(/^(?:NonRetryable)?Error:\s*/, "");
      await step.do("record failure", async () => {
        await markRun(env, storeId, runId, "failed", message.slice(0, 1000));
      });
      throw err;
    }
  }
}
