import { decrypt, encrypt } from "./crypto";
import type { Env, StoreRow } from "./env";

export class ShopifyError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

/** Accepts "my-store", "my-store.myshopify.com" or a full admin URL and returns "my-store". */
export function normaliseShop(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  const admin = s.match(/^admin\.shopify\.com\/store\/([a-z0-9-]+)/);
  if (admin) return admin[1];
  s = s.split("/")[0].replace(/\.myshopify\.com$/, "");
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(s) ? s : null;
}

function origin(env: Env, shop: string): string {
  return env.SHOPIFY_ORIGIN_OVERRIDE || `https://${shop}.myshopify.com`;
}

export interface TokenResponse {
  access_token: string;
  scope: string;
  expires_in: number;
}

/**
 * Dev Dashboard client credentials grant: exchanges the app's client ID and secret
 * for an Admin API token that lasts about 24 hours.
 */
export async function requestToken(env: Env, shop: string, clientId: string, clientSecret: string): Promise<TokenResponse> {
  const res = await fetch(`${origin(env, shop)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok || !body?.access_token) {
    const code: string | undefined = body?.error;
    const detail: string = body?.error_description || body?.error || `HTTP ${res.status}`;
    if (code === "shop_not_permitted") {
      throw new ShopifyError(
        "Shopify refused the client credentials grant for this store. The app and the store must belong to the same organisation in the Dev Dashboard, and the app must be installed on the store.",
        code,
      );
    }
    if (res.status === 404) throw new ShopifyError(`No Shopify store found at ${shop}.myshopify.com.`, "not_found");
    throw new ShopifyError(`Shopify rejected the credentials: ${detail}`, code);
  }
  return body as TokenResponse;
}

/** Returns a valid access token for the store, refreshing it when it is close to expiry. */
export async function getAccessToken(env: Env, store: StoreRow): Promise<string> {
  const now = Date.now();
  if (store.access_token_enc && store.token_expires_at && store.token_expires_at - now > 10 * 60 * 1000) {
    return decrypt(env.APP_SECRET, store.access_token_enc);
  }
  const secret = await decrypt(env.APP_SECRET, store.client_secret_enc);
  const tok = await requestToken(env, store.shop, store.client_id, secret);
  const expires = now + tok.expires_in * 1000;
  const enc = await encrypt(env.APP_SECRET, tok.access_token);
  await env.DB.prepare("UPDATE stores SET access_token_enc = ?, token_expires_at = ?, scopes = ? WHERE id = ?")
    .bind(enc, expires, tok.scope ?? "", store.id)
    .run();
  store.access_token_enc = enc;
  store.token_expires_at = expires;
  store.scopes = tok.scope ?? "";
  return tok.access_token;
}

export async function gql<T = any>(env: Env, shop: string, token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const url = `${origin(env, shop)}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new ShopifyError(`Shopify denied the request (HTTP ${res.status}). Check the app is still installed.`, "unauthorized");
    if (!res.ok) throw new ShopifyError(`Shopify API error: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }> };
    if (body.errors?.length) {
      const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      // Shopify can return errors alongside `data` whose top-level fields are null (for example an access error
      // on a mutation). Treat that as a failure so the caller sees Shopify's message instead of a null.
      const data = body.data as Record<string, unknown> | null | undefined;
      if (!data || Object.values(data).some((v) => v === null)) {
        throw new ShopifyError(body.errors.map((e) => e.message).join("; "), body.errors[0].extensions?.code);
      }
    }
    return body.data as T;
  }
}

export function hasScope(scopes: string | null, name: string): boolean {
  const list = (scopes ?? "").split(",").map((s) => s.trim());
  return list.includes(`read_${name}`) || list.includes(`write_${name}`);
}

/** The bulk export query. `since` limits it to orders updated after that time. */
export function buildBulkQuery(opts: { since: string | null; withProducts: boolean }): string {
  const filter = opts.since ? `(query: "updated_at:>='${opts.since}'")` : "";
  const address = "{ provinceCode province countryCodeV2 country }";
  return `{
  orders${filter} {
    edges { node {
      id name createdAt cancelledAt test currencyCode displayFinancialStatus sourceName
      shippingAddress ${address}
      billingAddress ${address}
      lineItems { edges { node {
        id title variantTitle sku vendor quantity currentQuantity
        originalUnitPriceSet { shopMoney { amount } }
        discountedTotalSet { shopMoney { amount } }
        ${opts.withProducts ? "product { id productType }" : ""}
        customAttributes { key value }
      } } }
    } }
  }
}`;
}

export const BULK_START = `mutation Start($q: String!) {
  bulkOperationRunQuery(query: $q) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

export const BULK_STATUS = `query Status($id: ID!) {
  bulkOperation(id: $id) { id status errorCode objectCount fileSize url partialDataUrl }
}`;

export const SHOP_INFO = `{ shop { name currencyCode ianaTimezone } }`;
