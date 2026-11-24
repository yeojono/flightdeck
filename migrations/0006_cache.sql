-- Answers to reports and other questions that are expensive to work out, kept so that asking again
-- does not read the data again. Safe to empty at any time. See worker/cache.ts.
CREATE TABLE cache (
  key        TEXT PRIMARY KEY,
  version    TEXT NOT NULL,                        -- only served while this still matches (data, mappings and deploy)
  value      TEXT NOT NULL,                        -- JSON
  created_at INTEGER NOT NULL                      -- epoch ms
) WITHOUT ROWID;
