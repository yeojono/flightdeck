export interface SyncParams {
  storeId: number;
  runId: number;
  kind: "full" | "incremental";
}

export interface Env {
  DB: D1Database;
  SYNC: Workflow<SyncParams>;
  ASSETS: Fetcher;
  /** Encrypts stored Shopify credentials. Never change it once stores are connected. */
  APP_SECRET: string;
  /** Optional, only for an Access application set up by hostname in Zero Trust (see README). */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  SHOPIFY_API_VERSION: string;
  INGEST_CHUNK_BYTES?: string;
  /** Local testing only: send all Shopify calls to this origin (see scripts/mock-shopify.mjs). */
  SHOPIFY_ORIGIN_OVERRIDE?: string;
}

export interface StoreRow {
  id: number;
  shop: string;
  label: string;
  client_id: string;
  client_secret_enc: string;
  access_token_enc: string | null;
  token_expires_at: number | null;
  scopes: string | null;
  shop_name: string | null;
  currency: string | null;
  timezone: string | null;
  fx_rate: number;
  sync_cursor: string | null;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  created_at: string;
}
