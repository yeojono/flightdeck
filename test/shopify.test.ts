import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../worker/env";
import { ShopifyError, gql } from "../worker/shopify";

const env = { SHOPIFY_API_VERSION: "2026-10" } as Env;

function respond(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })));
}

afterEach(() => vi.unstubAllGlobals());

describe("gql", () => {
  it("throws Shopify's error when a top-level field comes back null", async () => {
    respond({
      data: { bulkOperationRunQuery: null },
      errors: [{ message: "Access denied for bulkOperationRunQuery field.", extensions: { code: "ACCESS_DENIED" } }],
    });
    const err = await gql(env, "shop", "token", "mutation {}").catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyError);
    expect(err.message).toBe("Access denied for bulkOperationRunQuery field.");
    expect(err.code).toBe("ACCESS_DENIED");
  });

  it("still returns data when only a nested field has an error", async () => {
    respond({ data: { shop: { name: "x", extra: null } }, errors: [{ message: "nested problem" }] });
    await expect(gql(env, "shop", "token", "{}")).resolves.toEqual({ shop: { name: "x", extra: null } });
  });
});
