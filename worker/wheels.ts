/**
 * What a line item is (a wheelset, a single wheel, a rebuild) and how its property values
 * should be read because of that.
 *
 * The same text means different things on different products. A wheelset whose size reads
 * 29 is a 29 set (two wheels); a rear wheel whose size reads 29 is one 29 wheel. So values
 * are cleaned with the line item in view, and a set's size always ends in "Set".
 *
 * These rules were written against the property values actually in use (November 2026).
 * They only fix spelling and layout. Anything that is a judgement about two options being
 * the same thing lives in value_groups instead, where the Attributes page can undo it.
 */

import { normaliseValue } from "./values";

/** Bump when wheelKind or cleanValue changes: stores are then re-imported with the new rules at their next sync. */
export const RULES_VERSION = "2";

export type WheelKind = "set" | "single" | "rebuild";

export const WHEEL_KIND_LABEL: Record<WheelKind, string> = { set: "Wheelset", single: "Single wheel", rebuild: "Rebuild" };

type Family = "size" | "holes" | "brake" | "freehub" | "hubsize";

/** Which kind of value a property key holds, from the (lower-cased) key. */
export function keyFamily(key: string): Family | null {
  if (/^(wheel )?(size|sizing|diameter)$/.test(key)) return "size";
  if (/^hole count\b/.test(key)) return "holes";
  if (/\bbrake\b/.test(key)) return "brake";
  if (/\b(freehub|driver)\b/.test(key)) return "freehub";
  if (/^((front|rear) )?hub size$/.test(key) || /^(front|rear) hub$/.test(key)) return "hubsize";
  return null;
}

/**
 * The words that decide what a product is. The wheels sold count in report.ts (WHEELS_PER_UNIT) is
 * built from the same lists, so a wheelset is always 2 wheels and a single wheel always 1.
 */
export const SET_WORDS = ["wheelset", "wheel set"];
/** Things that mention a wheel without being one. */
export const NOT_A_WHEEL = ["rebuild", "shell", "per wheel", "upgrade", "deposit", "shipping"];

/**
 * Works out what a line item is from its product title and variant, e.g.
 *   "Wingman Origin Alloy Wheelset | Clockwork Hubs | Origin Black Rim Set"        set
 *   "Yama Hubs + Wingman Origin Custom Alloy Wheels (Front + Rear)"                set
 *   "Wingman Origin Alloy Rear Wheel | Clockwork Hub | Origin Black Rim"           single
 *   "Yama Hub + Wingman Origin Custom Alloy Wheel (Rear Only)"                     single
 *   "Rebuild on Origin 29" 32H"                                                    rebuild
 * Add-ons and parts (tape, valves, shells, hubs, rims) are none of these and return null.
 *
 * This is WHEELS_PER_UNIT in report.ts, in the same order: a set is what counts as 2 wheels and a
 * single is what counts as 1. Rebuilds count as 0 there and are named here. Change the two together.
 */
export function wheelKind(title: string | null | undefined, variant?: string | null): WheelKind | null {
  const text = `${title ?? ""} ${variant ?? ""}`.toLowerCase();
  const has = (...words: string[]) => words.some((w) => text.includes(w));
  if (has("rebuild")) return "rebuild";
  if (!has("wheel") || has(...NOT_A_WHEEL)) return null;
  if (has(...SET_WORDS) || (has("front") && has("rear") && !has("only"))) return "set";
  if (has("front", "rear")) return "single";
  return null;
}

/** Front axle sizes that only exist as Boost, so the word adds nothing. 110x20 comes both ways and keeps it. */
const BOOST_IMPLIED = new Set(["110x15", "148x12"]);

/**
 * Cleans one property value for grouping, knowing which key it is under and what the line item is.
 *
 *   size, wheel sizing, diameter   27_5" -> 27.5            and on a wheelset   29, 29" -> 29 Set   Mullet -> Mullet Set
 *   hole count                     32 / 28 (Recommended) -> 32/28      32H -> 32
 *   hole count ( front / rear )    28 / 32 -> 32/28   (always shown rear/front, like the other hole count keys)
 *   brake mount                    6 Bolt -> 6-Bolt      Center Lock -> Centerlock
 *   freehub, driver                Shimano Micro Spline -> Shimano Microspline      HG -> Shimano HG
 *   front / rear hub size          110x20 Boost (2021+) (Black & Silver Only) -> 110x20 Boost      148x12 (Boost) -> 148x12
 */
export function cleanValue(key: string, raw: string, kind: WheelKind | null = null): string {
  let v = normaliseValue(raw);
  switch (keyFamily(key)) {
    case "size":
      v = v.replace(/(\d)_(\d)/g, "$1.$2");
      // A bare size on a wheelset is the set of that size, not one wheel of it.
      if (kind === "set" && /^(?:\d+(?:\.\d+)?c?|mullet)$/i.test(v)) v += " Set";
      break;
    case "holes": {
      v = v.replace(/\s*\(recommended\)/gi, "").replace(/\b(\d+)\s*h\b/gi, "$1").trim();
      const pair = v.match(/^(\d+)\/(\d+)$/);
      if (pair && /front\s*\/\s*rear/.test(key)) v = `${pair[2]}/${pair[1]}`;
      break;
    }
    case "brake":
      v = v.replace(/\b6[\s-]*bolt\b/gi, "6-Bolt").replace(/\bcent(?:er|re)[\s-]*lock\b/gi, "Centerlock");
      break;
    case "freehub":
      v = v.replace(/\bmicro[\s-]*spline\b/gi, "Microspline");
      if (/^hg\b/i.test(v)) v = `Shimano ${v}`;
      break;
    case "hubsize": {
      // Keep the axle size and drop sales notes such as "(2021+)" or "(Black & Silver Only)".
      const m = v.match(/^(\d{2,3})\s*x\s*(\d{1,2})\b(.*)$/i);
      if (m) {
        const size = `${m[1]}x${m[2]}`;
        const boost = /super\s*boost/i.test(m[3]) ? " Super Boost" : /boost/i.test(m[3]) && !BOOST_IMPLIED.has(size) ? " Boost" : "";
        v = size + boost;
      }
      break;
    }
  }
  return v || String(raw).trim();
}

/** The value to store in line_item_props.norm: the cleaned value, or null when it is unchanged. */
export function normColumn(key: string, value: string, kind: WheelKind | null = null): string | null {
  const n = cleanValue(key, value, kind);
  return n === value ? null : n;
}
