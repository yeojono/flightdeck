-- Connected Shopify stores. Credentials are AES-GCM encrypted with APP_SECRET.
CREATE TABLE stores (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  shop              TEXT NOT NULL UNIQUE,          -- "my-store" (the part before .myshopify.com)
  label             TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,
  access_token_enc  TEXT,
  token_expires_at  INTEGER,                       -- epoch ms
  scopes            TEXT,
  shop_name         TEXT,
  currency          TEXT,
  timezone          TEXT,
  fx_rate           REAL NOT NULL DEFAULT 1,       -- store currency -> reporting currency
  sync_cursor       TEXT,                          -- orders updated before this are already synced
  last_sync_at      TEXT,
  last_sync_status  TEXT,
  last_sync_error   TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Only the order fields needed for reporting. No names, emails, phones or street addresses.
CREATE TABLE orders (
  store_id         INTEGER NOT NULL,
  id               INTEGER NOT NULL,
  name             TEXT,
  created_at       TEXT NOT NULL,
  day              TEXT NOT NULL,                  -- order date in the store's timezone, YYYY-MM-DD
  cancelled        INTEGER NOT NULL DEFAULT 0,
  test             INTEGER NOT NULL DEFAULT 0,
  currency         TEXT,
  financial_status TEXT,
  source_name      TEXT,
  province_code    TEXT,
  province         TEXT,
  country_code     TEXT,
  country          TEXT,
  PRIMARY KEY (store_id, id)
) WITHOUT ROWID;
CREATE INDEX orders_day ON orders (day);
CREATE INDEX orders_geo ON orders (country_code, province_code);

CREATE TABLE line_items (
  store_id         INTEGER NOT NULL,
  id               INTEGER NOT NULL,
  order_id         INTEGER NOT NULL,
  title            TEXT,
  variant_title    TEXT,
  sku              TEXT,
  vendor           TEXT,
  product_id       INTEGER,
  product_type     TEXT,
  quantity         INTEGER NOT NULL DEFAULT 0,     -- as ordered
  current_quantity INTEGER NOT NULL DEFAULT 0,     -- after refunds and removals
  unit_price       REAL NOT NULL DEFAULT 0,        -- store currency
  total            REAL NOT NULL DEFAULT 0,        -- line total after line-level discounts, store currency
  -- Clustered by order so joining orders to their line items is a single range read.
  PRIMARY KEY (store_id, order_id, id)
) WITHOUT ROWID;

-- Line item properties (customAttributes). key is lower-cased and trimmed.
CREATE TABLE line_item_props (
  store_id     INTEGER NOT NULL,
  line_item_id INTEGER NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  order_id     INTEGER NOT NULL,
  PRIMARY KEY (store_id, line_item_id, key)
) WITHOUT ROWID;
CREATE INDEX line_item_props_key ON line_item_props (key, value);
CREATE INDEX line_item_props_order ON line_item_props (store_id, order_id);

-- A dimension is your own name for an attribute ("Rim"), fed by one or more property keys
-- ("rim", "rim choice", "select your rim") so stores that label things differently line up.
CREATE TABLE dimensions (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE dimension_keys (
  key          TEXT PRIMARY KEY,
  dimension_id INTEGER NOT NULL REFERENCES dimensions (id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX dimension_keys_dim ON dimension_keys (dimension_id);

INSERT INTO dimensions (name, sort) VALUES ('Rim', 1), ('Hub', 2), ('Colour', 3), ('Wheel size', 4);

CREATE TABLE sync_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL,
  kind         TEXT NOT NULL,                      -- full | incremental
  status       TEXT NOT NULL,                      -- queued | exporting | importing | complete | failed
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at  TEXT,
  bulk_id      TEXT,
  orders       INTEGER NOT NULL DEFAULT 0,
  line_items   INTEGER NOT NULL DEFAULT 0,
  bytes_done   INTEGER NOT NULL DEFAULT 0,
  bytes_total  INTEGER NOT NULL DEFAULT 0,
  message      TEXT
);
CREATE INDEX sync_runs_store ON sync_runs (store_id, id DESC);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
INSERT INTO settings (key, value) VALUES ('reporting_currency', 'AUD');

CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX login_attempts_ip ON login_attempts (ip, ts);
