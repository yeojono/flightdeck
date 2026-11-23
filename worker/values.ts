/**
 * Cleans up line item property values so spellings of the same thing group together.
 *
 * Grouping already ignores upper and lower case. On top of that, these are treated as the same:
 *   - curly and straight quotes, primes and doubled single quotes:  27.5″  27.5”  27.5''  27.5"
 *   - an inch mark or word after a number, which is dropped:        27.5"  27.5 in  27.5-inch  27.5
 *   - spacing around slashes:                                       29 / 27.5  29/27.5
 *   - quotes wrapped around the whole value:                        "Black"  Black
 *
 * These rules apply to every property. Rules that depend on which property it is, or on
 * whether the line item is a wheelset or a single wheel, are in wheels.ts.
 *
 * The original value is kept in line_item_props.value. The cleaned one is stored in
 * line_item_props.norm only when it differs, so most rows store nothing extra.
 */

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
