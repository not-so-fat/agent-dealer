import assert from "node:assert/strict";

/** Stubs global fetch for one call, asserts the request shape, and restores it —
 * exercises a CLI command's HTTP contract without a live server. */
export function stubFetch(expectedUrl: string | RegExp, expectedMethod: string, response: unknown, status = 200) {
  const original = globalThis.fetch;
  let captured: { url: string; method: string; body: unknown } | undefined;
  globalThis.fetch = (async (url: string, opts?: { method?: string; body?: string }) => {
    captured = { url: String(url), method: opts?.method ?? "GET", body: opts?.body ? JSON.parse(opts.body) : undefined };
    return {
      ok: status < 400,
      status,
      json: async () => response,
    } as Response;
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    assertCalled: () => {
      assert.ok(captured, "expected fetch to be called");
      if (typeof expectedUrl === "string") {
        assert.ok(captured!.url.endsWith(expectedUrl), `expected url to end with ${expectedUrl}, got ${captured!.url}`);
      } else {
        assert.match(captured!.url, expectedUrl);
      }
      assert.equal(captured!.method, expectedMethod);
      return captured!.body;
    },
  };
}
