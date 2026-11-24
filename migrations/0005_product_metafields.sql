-- New builds name their hub and rim in the product title, not in a line item property. The products'
-- ultimate_hub_set and ultimate_rim_set metafields are now imported with each line item (PRODUCT_METAFIELDS
-- in wrangler.jsonc) and feed these two attributes, so you can filter and group by them.
INSERT INTO dimensions (name, sort)
  WITH added(name, n) AS (VALUES ('Rim set', 1), ('Hub set', 2))
  SELECT added.name, (SELECT COALESCE(MAX(sort), 0) FROM dimensions) + added.n FROM added
  WHERE NOT EXISTS (SELECT 1 FROM dimensions d WHERE d.name = added.name COLLATE NOCASE);

-- Mapped before any value is imported, since the store's next sync is what brings them in.
-- A key you already mapped is left alone.
INSERT OR IGNORE INTO dimension_keys (key, dimension_id)
  WITH m(key, dim) AS (VALUES ('ultimate_rim_set', 'Rim set'), ('ultimate_hub_set', 'Hub set'))
  SELECT m.key, d.id FROM m JOIN dimensions d ON d.name = m.dim COLLATE NOCASE;
