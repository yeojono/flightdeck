// Deterministic fake Shopify bulk-export data for local testing. Not used in production.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted(rand, items) {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let x = rand() * total;
  for (const [v, w] of items) {
    x -= w;
    if (x <= 0) return v;
  }
  return items[0][0];
}

const RIMS = [["DT Swiss XM 481", 30], ["Stan's Flow EX3", 24], ["Race Face ARC 30", 18], ["WTB KOM Tough i30", 12], ["Reserve 30 HD", 9], ["Spank 359", 7]];
const HUBS = [["DT Swiss 350", 34], ["Hope Pro 5", 26], ["Industry Nine Hydra", 18], ["Chris King", 8], ["Onyx Vesper", 6], ["Shimano XT", 8]];
const COLOURS = [["Black", 46], ["Silver", 12], ["Red", 10], ["Blue", 9], ["Orange", 8], ["Purple", 7], ["Gold", 5], ["black", 3]];
// A wheelset's size is a set size, sometimes written without the word; a single wheel's is one wheel.
const SET_SIZES = [['29" Set', 40], ["Mullet Set", 30], ['27.5" Set', 10], ["29", 12], ["Mullet", 8]];
const SINGLE_SIZES = [['29"', 55], ['27.5"', 40], ['26"', 5]];
const OTHER_PRODUCTS = [
  ["Tubeless Valve Set", "Accessories", 29],
  ["Rim Tape 30mm", "Accessories", 15],
  ["Spare Spokes (5 pack)", "Spares", 22],
  ["Sealant 500ml", "Accessories", 35],
];

export const SHOPS = {
  "mock-au": {
    name: "Wheelworks AU",
    currency: "AUD",
    timezone: "Australia/Sydney",
    keys: { rim: "Rim", hub: "Hub", colour: "Hub Colour", size: "Wheel Size" },
    places: [
      [{ provinceCode: "NSW", province: "New South Wales", countryCodeV2: "AU", country: "Australia" }, 32],
      [{ provinceCode: "VIC", province: "Victoria", countryCodeV2: "AU", country: "Australia" }, 26],
      [{ provinceCode: "QLD", province: "Queensland", countryCodeV2: "AU", country: "Australia" }, 20],
      [{ provinceCode: "WA", province: "Western Australia", countryCodeV2: "AU", country: "Australia" }, 9],
      [{ provinceCode: "TAS", province: "Tasmania", countryCodeV2: "AU", country: "Australia" }, 5],
      [{ provinceCode: "AUK", province: "Auckland", countryCodeV2: "NZ", country: "New Zealand" }, 8],
    ],
    price: 1450,
    seed: 11,
  },
  "mock-us": {
    name: "Wheelworks US",
    currency: "USD",
    timezone: "America/Denver",
    keys: { rim: "Rim Choice", hub: "Hub Choice", colour: "Hub Color:", size: "Wheel size" },
    places: [
      [{ provinceCode: "CO", province: "Colorado", countryCodeV2: "US", country: "United States" }, 22],
      [{ provinceCode: "CA", province: "California", countryCodeV2: "US", country: "United States" }, 28],
      [{ provinceCode: "UT", province: "Utah", countryCodeV2: "US", country: "United States" }, 14],
      [{ provinceCode: "WA", province: "Washington", countryCodeV2: "US", country: "United States" }, 12],
      [{ provinceCode: "BC", province: "British Columbia", countryCodeV2: "CA", country: "Canada" }, 16],
      [{ provinceCode: "ON", province: "Ontario", countryCodeV2: "CA", country: "Canada" }, 8],
    ],
    price: 980,
    seed: 23,
  },
};

/**
 * @param {keyof SHOPS} shopKey
 * @param {{ orders?: number, since?: string | null, tag?: string | null, endDate?: string }} opts
 * @returns {string} JSONL in the shape of a Shopify bulk operation result
 */
export function generateJsonl(shopKey, opts = {}) {
  const shop = SHOPS[shopKey];
  const rand = rng(shop.seed);
  const count = opts.orders ?? 1500;
  const end = new Date(opts.endDate ?? "2026-11-20T00:00:00Z").getTime();
  const span = 540 * 86400 * 1000;
  const lines = [];
  let lineId = shop.seed * 1e9;

  for (let i = 0; i < count; i++) {
    const orderId = 5000000000000 + shop.seed * 1e9 + i;
    // More recent orders are more common, so the time series trends upward.
    const createdAt = new Date(end - Math.pow(rand(), 1.6) * span).toISOString().replace(/\.\d+Z$/, "Z");
    const place = weighted(rand, shop.places);
    const cancelled = rand() < 0.03;
    const order = {
      id: `gid://shopify/Order/${orderId}`,
      name: `#${1001 + i}`,
      createdAt,
      cancelledAt: cancelled ? createdAt : null,
      test: rand() < 0.01,
      currencyCode: shop.currency,
      displayFinancialStatus: "PAID",
      sourceName: rand() < 0.9 ? "web" : "pos",
      shippingAddress: rand() < 0.95 ? place : null,
      billingAddress: place,
    };
    const items = [];
    if (rand() < 0.8) {
      const set = rand() < 0.75; // a wheelset (front + rear), or a single wheel
      const rim = weighted(rand, RIMS);
      const hub = weighted(rand, HUBS);
      const colour = weighted(rand, COLOURS);
      const size = weighted(rand, set ? SET_SIZES : SINGLE_SIZES);
      const position = rand() < 0.3 ? "Front" : "Rear";
      const refunded = rand() < 0.02;
      const price = set ? shop.price : shop.price / 2;
      items.push({
        id: `gid://shopify/LineItem/${++lineId}`,
        title: set ? "Custom Alloy Wheels (Front + Rear)" : `Custom Alloy Wheel (${position} Only)`,
        variantTitle: null,
        sku: set ? "CWB-SET" : `CWB-${position[0]}`,
        vendor: "Wheelworks",
        quantity: 1,
        currentQuantity: refunded ? 0 : 1,
        originalUnitPriceSet: { shopMoney: { amount: String(price) } },
        discountedTotalSet: { shopMoney: { amount: String(price) } },
        // A wheelset product names its hub and rim in two product metafields, which the export returns as mf0 and
        // mf1 (PRODUCT_METAFIELDS in wrangler.jsonc lists ultimate_hub_set first). Single wheels have none.
        product: set
          ? {
              id: `gid://shopify/Product/${9000000000100 + RIMS.findIndex(([r]) => r === rim) * 10 + HUBS.findIndex(([h]) => h === hub)}`,
              productType: "Custom Wheels",
              mf0: { value: `${hub} Hubs` },
              mf1: { value: `${rim} Rim Set` },
            }
          : { id: "gid://shopify/Product/9000000000002", productType: "Custom Wheels", mf0: null, mf1: null },
        customAttributes: [
          { key: shop.keys.rim, value: rim },
          { key: shop.keys.hub, value: hub },
          { key: shop.keys.colour, value: colour },
          { key: shop.keys.size, value: size },
          { key: "_builder_id", value: `b${orderId}` },
        ],
        __parentId: order.id,
      });
    }
    // Orders with a wheel are tagged in Shopify (in any letter case, among other tags); the rest are not.
    order.tags = items.length ? (rand() < 0.15 ? ["VIP", "Wheels"] : ["wheels"]) : rand() < 0.2 ? ["vip"] : [];
    const extras = items.length ? (rand() < 0.4 ? 1 : 0) : 1 + Math.floor(rand() * 2);
    for (let e = 0; e < extras; e++) {
      const [title, type, price] = OTHER_PRODUCTS[Math.floor(rand() * OTHER_PRODUCTS.length)];
      const qty = 1 + Math.floor(rand() * 3);
      items.push({
        id: `gid://shopify/LineItem/${++lineId}`,
        title,
        variantTitle: null,
        sku: title.slice(0, 3).toUpperCase(),
        vendor: "Wheelworks",
        quantity: qty,
        currentQuantity: qty,
        originalUnitPriceSet: { shopMoney: { amount: String(price) } },
        discountedTotalSet: { shopMoney: { amount: String(price * qty) } },
        product: { id: `gid://shopify/Product/${9000000000010 + e}`, productType: type },
        customAttributes: [],
        __parentId: order.id,
      });
    }
    if (opts.since && createdAt < opts.since) continue;
    if (opts.tag && !order.tags.some((t) => t.toLowerCase() === opts.tag.toLowerCase())) continue;
    lines.push(JSON.stringify(order));
    for (const it of items) lines.push(JSON.stringify(it));
  }
  return lines.join("\n") + "\n";
}
