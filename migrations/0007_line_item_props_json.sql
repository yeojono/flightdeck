-- Each line item's properties, cleaned, as one JSON object on the line item itself:
-- {"rim": "Origin", "size": "29 Set"}. Reports read them from here along with the line item,
-- instead of reading a row per property. '{}' is a line item with no properties. NULL means the
-- copy was never written, and reports then read line_item_props for that line item instead.
-- line_item_props stays as it is: it is what finds line items by a property's value.
ALTER TABLE line_items ADD COLUMN props TEXT;
UPDATE line_items SET props = (
  SELECT json_group_object(p.key, COALESCE(p.norm, p.value)) FROM line_item_props p
  WHERE p.store_id = line_items.store_id AND p.line_item_id = line_items.id
);

-- Finds the line items that have a given cleaned value for a property, ignoring case, and carries
-- the order id needed to go straight to each one. A report filtered by an attribute starts here.
-- It replaces the index on (key, value), which could only match values as they were typed.
DROP INDEX line_item_props_key;
CREATE INDEX line_item_props_shown ON line_item_props (key, COALESCE(norm, value) COLLATE NOCASE, order_id);
