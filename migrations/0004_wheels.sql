-- What the line item is, worked out from its product title when it is imported:
-- set (a wheelset), single (one wheel), rebuild, or NULL for add-ons and parts.
ALTER TABLE line_items ADD COLUMN wheel_kind TEXT;

-- The sync run that last wrote the order. A full resync removes the orders it did not write
-- when it finishes, instead of emptying the store before it starts.
ALTER TABLE orders ADD COLUMN run_id INTEGER;

-- The tag and cleaning rules the store's data was last fully imported with. When they change,
-- the store's next sync is a full resync.
ALTER TABLE stores ADD COLUMN sync_scope TEXT;

-- The Colour attribute was meant for the hub colour. Name it that now there is a valve colour too
-- (only if nothing was mapped to it yet, so an attribute you set up yourself is left alone).
UPDATE dimensions SET name = 'Hub colour'
  WHERE name = 'Colour'
    AND NOT EXISTS (SELECT 1 FROM dimension_keys k WHERE k.dimension_id = dimensions.id)
    AND NOT EXISTS (SELECT 1 FROM dimensions d WHERE d.name = 'Hub colour' COLLATE NOCASE);

INSERT INTO dimensions (name, sort)
  WITH added(name, n) AS (VALUES ('Brake mount', 1), ('Hole count', 2), ('Spokes', 3), ('Front hub size', 4), ('Rear hub size', 5), ('Valve colour', 6))
  SELECT added.name, (SELECT COALESCE(MAX(sort), 0) FROM dimensions) + added.n FROM added
  WHERE NOT EXISTS (SELECT 1 FROM dimensions d WHERE d.name = added.name COLLATE NOCASE);

-- Property keys that mean the same thing feed one attribute. Only keys found in your orders are
-- mapped, and a key you already mapped is left alone. The plain hub size key is only on single
-- rear wheels so far, which is why it feeds Rear hub size.
INSERT OR IGNORE INTO dimension_keys (key, dimension_id)
  WITH m(key, dim) AS (VALUES
    ('size', 'Wheel size'), ('wheel sizing', 'Wheel size'), ('wheel size', 'Wheel size'), ('diameter', 'Wheel size'),
    ('driver', 'Freehub'), ('freehub', 'Freehub'), ('freehub / driver', 'Freehub'), ('driver type', 'Freehub'),
    ('hub colour', 'Hub colour'), ('hub color', 'Hub colour'),
    ('brake mount', 'Brake mount'), ('brake rotor mount', 'Brake mount'),
    ('hole count', 'Hole count'), ('hole count ( rear / front )', 'Hole count'), ('hole count ( front / rear )', 'Hole count'),
    ('spokes', 'Spokes'), ('spoke', 'Spokes'),
    ('front hub size', 'Front hub size'), ('front hub', 'Front hub size'),
    ('rear hub size', 'Rear hub size'), ('rear hub', 'Rear hub size'), ('hub size', 'Rear hub size'),
    ('valve colour', 'Valve colour'), ('valve color', 'Valve colour'),
    ('rim', 'Rim'), ('rim model', 'Rim'))
  SELECT m.key, d.id FROM m JOIN dimensions d ON d.name = m.dim COLLATE NOCASE
  WHERE EXISTS (SELECT 1 FROM line_item_props p WHERE p.key = m.key);

-- Values that are very likely the same option under another name. Unlike the spelling fixes done
-- at import, each of these can be undone with Separate on the Attributes page. Rebuilds name the
-- spoke together with how the hub takes it (J Bend, Straight Pull), where new builds name only the spoke.
INSERT OR IGNORE INTO value_groups (dimension_id, value, label)
  WITH g(dim, value, label) AS (VALUES
    ('Rear hub size', '157x12 Super Boost', '157x12'),
    ('Rim', 'Wingman Origin', 'Origin'),
    ('Rim', 'Origin Alloy (Black)', 'Origin'),
    ('Spokes', 'Alpina Lite Black J Bend', 'Alpina Lite Black'),
    ('Spokes', 'Alpina Lite Black Straight Pull', 'Alpina Lite Black'),
    ('Spokes', 'Alpina Lite Black Unsure', 'Alpina Lite Black'),
    ('Spokes', 'Alpina Lite Silver J Bend', 'Alpina Lite Silver'),
    ('Spokes', 'Alpina Lite Silver Straight Pull', 'Alpina Lite Silver'),
    ('Spokes', 'Alpina Lite Silver Unsure', 'Alpina Lite Silver'),
    ('Spokes', 'Sandvik T302+ Black J Bend', 'Pillar Sandvik T302+ Black'),
    ('Spokes', 'Sandvik T302+ Black Straight Pull', 'Pillar Sandvik T302+ Black'),
    ('Spokes', 'Sandvik T302+ Black Unsure', 'Pillar Sandvik T302+ Black'),
    ('Spokes', 'Alpina UltraLite Bladed J Bend', 'Alpina UltraLite Aero Bladed'),
    ('Spokes', 'Alpina UltraLite Bladed Straight Pull', 'Alpina UltraLite Aero Bladed'),
    ('Spokes', 'Alpina UltraLite Bladed Unsure', 'Alpina UltraLite Aero Bladed'))
  SELECT d.id, g.value, g.label FROM g JOIN dimensions d ON d.name = g.dim COLLATE NOCASE;
