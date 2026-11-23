export interface DimValue {
  value: string;
  line_items: number;
  /** What reports show this value as, if it was combined with others. */
  label: string | null;
}

export interface WordSuggestion {
  /** The word that is the only difference, as written in the values. */
  word: string;
  /** Each value containing the word, and the value it would be combined into. */
  pairs: Array<{ from: string; to: string }>;
}

/**
 * Words that change what a value is, however often they are the only difference:
 * "29 Set" is a pair of wheels and "29" is one wheel.
 */
const MEANINGFUL = new Set(["set", "front", "rear", "boost"]);

/**
 * Finds words that several values differ by and nothing else, such as "Matte" in
 * "Black Matte" / "Black" and "Red Matte" / "Red". A word is suggested only when it
 * separates at least two pairs, so a one-off difference is not treated as noise.
 */
export function suggestWordGroups(values: DimValue[], minPairs = 2): WordSuggestion[] {
  const shown = new Map<string, string>();
  for (const v of values) shown.set(v.value.toLowerCase(), v.label ?? v.value);

  const byWord = new Map<string, WordSuggestion>();
  for (const v of values) {
    if (v.label) continue; // already combined by hand
    const words = v.value.split(" ");
    if (words.length < 2) continue;
    for (let i = 0; i < words.length; i++) {
      const rest = [...words.slice(0, i), ...words.slice(i + 1)].join(" ").toLowerCase();
      const to = shown.get(rest);
      if (to === undefined || to.toLowerCase() === v.value.toLowerCase()) continue;
      const key = words[i].toLowerCase();
      if (MEANINGFUL.has(key)) continue;
      const s = byWord.get(key) ?? { word: words[i], pairs: [] };
      s.pairs.push({ from: v.value, to });
      byWord.set(key, s);
      break;
    }
  }
  return [...byWord.values()].filter((s) => s.pairs.length >= minPairs).sort((a, b) => b.pairs.length - a.pairs.length);
}
