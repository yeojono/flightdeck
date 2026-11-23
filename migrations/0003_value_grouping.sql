-- The value cleaned up for grouping (27.5″, 27.5" and 27.5 all become 27.5), or NULL when it is
-- the same as value. Filled in at import, and for existing rows by the app the first time it loads.
ALTER TABLE line_item_props ADD COLUMN norm TEXT;

-- Values you have combined by hand for an attribute, e.g. "Mullet Set" shown as "Mullet".
-- value is the cleaned value; label is what reports show instead.
CREATE TABLE value_groups (
  dimension_id INTEGER NOT NULL REFERENCES dimensions (id) ON DELETE CASCADE,
  value        TEXT NOT NULL COLLATE NOCASE,
  label        TEXT NOT NULL,
  PRIMARY KEY (dimension_id, value)
) WITHOUT ROWID;

-- Freehub, also called the driver. Both property keys feed it, unless you already mapped them.
INSERT INTO dimensions (name, sort) SELECT 'Freehub', (SELECT COALESCE(MAX(sort), 0) + 1 FROM dimensions)
  WHERE NOT EXISTS (SELECT 1 FROM dimensions WHERE name = 'Freehub' COLLATE NOCASE);
INSERT OR IGNORE INTO dimension_keys (key, dimension_id)
  SELECT k.key, d.id FROM (SELECT 'freehub' AS key UNION ALL SELECT 'driver') k, dimensions d
  WHERE d.name = 'Freehub' COLLATE NOCASE AND EXISTS (SELECT 1 FROM line_item_props p WHERE p.key = k.key);
