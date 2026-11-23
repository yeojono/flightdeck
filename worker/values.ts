/**
 * Cleans up line item property values so spellings of the same thing group together.
 *
 * Grouping already ignores upper and lower case. On top of that, these are treated as the same:
 *   - curly and straight quotes, primes and doubled single quotes:  27.5″  27.5”  27.5''  27.5"
 *   - an inch mark or word after a number, which is dropped:        27.5"  27.5 in  27.5-inch  27.5
 *   - spacing around slashes:                                       29 / 27.5  29/27.5
 *   - quotes wrapped around the whole value:                        "Black"  Black
 *
 * The original value is kept in line_item_props.value. The cleaned one is stored in
 * line_item_props.norm only when it differs, so most rows store nothing extra.
 */

/** Bump when normaliseValue changes, so existing rows are cleaned again with the new rules. */
export const NORM_VERSION = "1";

const DOUBLE_QUOTES = /[“”„‟″ʺ˝〃＂]|′′|’’|''/g;
const SINGLE_QUOTES = /[‘’‚‛′＇]/g;

export function normaliseValue(raw: string): string {
  let v = String(raw).replace(/\s+/g, " ").trim();
  v = v.replace(DOUBLE_QUOTES, '"').replace(SINGLE_QUOTES, "'");
  // "Black" -> Black, but leave values that only start or end with a quote.
  const wrapped = v.match(/^"([^"]+)"$/);
  if (wrapped) v = wrapped[1].trim();
  v = v
    .replace(/(\d)\s*-?\s*inch(?:es)?\b\.?/gi, "$1") // 29 inch, 29-inch, 29 inches
    .replace(/(\d)in\b\.?/gi, "$1") // 29in
    .replace(/(\d) in\.?(?=$|\s*[/,;)\]])/gi, "$1") // "29 in" at the end, but not "29 in black"
    .replace(/(\d)\s*"/g, "$1") // 27.5"
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
  return v || String(raw).trim();
}

/** The value to store in line_item_props.norm: the cleaned value, or null when it is unchanged. */
export function normColumn(value: string): string | null {
  const n = normaliseValue(value);
  return n === value ? null : n;
}

/**
 * Cleans values imported before the current rules existed. Runs once per NORM_VERSION.
 * Only values that contain something the rules can change are read, and only rows whose
 * cleaned value differs are written.
 */
export async function ensureNormalised(db: D1Database): Promise<void> {
  const done = await db.prepare("SELECT value FROM settings WHERE key = 'value_norm_version'").first<{ value: string }>();
  if (done?.value === NORM_VERSION) return;

  const { results } = await db
    .prepare(`SELECT DISTINCT key, value FROM line_item_props WHERE value GLOB '*[0-9/"'']*' OR value GLOB '*[^ -~]*'`)
    .all<{ key: string; value: string }>();
  const stmts: D1PreparedStatement[] = [db.prepare("UPDATE line_item_props SET norm = NULL WHERE norm IS NOT NULL")];
  for (const r of results) {
    const norm = normColumn(r.value);
    if (norm !== null) stmts.push(db.prepare("UPDATE line_item_props SET norm = ?3 WHERE key = ?1 AND value = ?2").bind(r.key, r.value, norm));
  }
  // Run the reset first on its own, then the updates in modest batches.
  await stmts[0].run();
  for (let i = 1; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
  await db
    .prepare("INSERT INTO settings (key, value) VALUES ('value_norm_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(NORM_VERSION)
    .run();
}
