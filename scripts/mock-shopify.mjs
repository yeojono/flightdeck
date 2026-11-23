// A tiny stand-in for Shopify so the whole sync can be exercised locally.
//
//   1. npm run mock:shopify
//   2. add SHOPIFY_ORIGIN_OVERRIDE=http://127.0.0.1:8799 to .dev.vars
//   3. npm run dev, then connect a store with any domain and
//      client ID "mock-au" or "mock-us", client secret "mock-secret"
//
// Never set SHOPIFY_ORIGIN_OVERRIDE in production.

import http from "node:http";
import { SHOPS, generateJsonl } from "./mock-data.mjs";

const PORT = Number(process.env.PORT || 8799);
const ORDERS = Number(process.env.MOCK_ORDERS || 1500);
const ops = new Map(); // id -> { polls, body: Buffer }
let nextOp = 1;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "POST" && url.pathname === "/admin/oauth/access_token") {
    const form = new URLSearchParams(await readBody(req));
    const id = form.get("client_id");
    if (form.get("grant_type") !== "client_credentials" || !SHOPS[id] || form.get("client_secret") !== "mock-secret") {
      return json(res, 400, { error: "invalid_client", error_description: "Unknown client ID or secret" });
    }
    return json(res, 200, { access_token: `token:${id}`, scope: "read_orders,read_products", expires_in: 86399 });
  }

  if (req.method === "POST" && /^\/admin\/api\/[\w-]+\/graphql\.json$/.test(url.pathname)) {
    const shopKey = String(req.headers["x-shopify-access-token"] || "").replace("token:", "");
    const shop = SHOPS[shopKey];
    if (!shop) return json(res, 401, { errors: "Invalid API key or access token" });
    const { query, variables } = JSON.parse(await readBody(req));

    if (query.includes("bulkOperationRunQuery")) {
      const since = variables.q.match(/updated_at:>='([^']+)'/)?.[1] ?? null;
      const id = `gid://shopify/BulkOperation/${nextOp++}`;
      ops.set(id, { polls: 0, body: Buffer.from(generateJsonl(shopKey, { orders: ORDERS, since })) });
      return json(res, 200, { data: { bulkOperationRunQuery: { bulkOperation: { id, status: "CREATED" }, userErrors: [] } } });
    }
    if (query.includes("bulkOperation(")) {
      const op = ops.get(variables.id);
      if (!op) return json(res, 200, { data: { bulkOperation: null } });
      op.polls++;
      const done = op.polls >= 2;
      const n = variables.id.split("/").pop();
      return json(res, 200, {
        data: {
          bulkOperation: {
            id: variables.id,
            status: done ? "COMPLETED" : "RUNNING",
            errorCode: null,
            objectCount: "0",
            fileSize: done ? String(op.body.length) : null,
            url: done && op.body.length > 1 ? `http://127.0.0.1:${PORT}/bulk/${n}.jsonl` : null,
            partialDataUrl: null,
          },
        },
      });
    }
    if (query.includes("shop")) {
      return json(res, 200, { data: { shop: { name: shop.name, currencyCode: shop.currency, ianaTimezone: shop.timezone } } });
    }
    return json(res, 200, { errors: [{ message: "Mock does not understand this query" }] });
  }

  const file = url.pathname.match(/^\/bulk\/(\d+)\.jsonl$/);
  if (req.method === "GET" && file) {
    const op = ops.get(`gid://shopify/BulkOperation/${file[1]}`);
    if (!op) return json(res, 404, { error: "not found" });
    const range = String(req.headers.range || "").match(/^bytes=(\d+)-(\d+)$/);
    if (range && !process.env.MOCK_NO_RANGE) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), op.body.length - 1);
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${op.body.length}`, "Content-Length": end - start + 1 });
      return res.end(op.body.subarray(start, end + 1));
    }
    res.writeHead(200, { "Content-Length": op.body.length });
    return res.end(op.body);
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`Mock Shopify listening on http://127.0.0.1:${PORT} (${ORDERS} orders per store)`));
