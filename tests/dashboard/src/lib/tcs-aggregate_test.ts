/**
 * Client-side TCS aggregation: merge across servers, de-dup by (git,ref,path)
 * with seenOn, isolate failures, skip search-unsupported nodes, paginate per
 * server. fetch is stubbed so these run without network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  initTcsState,
  loadMoreTcs,
  sortTcsItems,
  type AggregatedTcsListing,
} from "../../../../dashboard/src/lib/tcs-aggregate.ts";
import type { TcsListing } from "../../../../dashboard/src/lib/tcs-client.ts";
import type { TcsServer } from "../../../../dashboard/src/lib/tcs-servers.ts";

const text = (s: string) => ({ ja: s, en: s });
function L(
  id: string,
  source?: Partial<TcsListing["source"]>,
  updatedAt = "2026-01-01T00:00:00.000Z",
): TcsListing {
  return {
    id,
    source: {
      git: `https://github.com/o/${id}.git`,
      ref: "c1",
      path: "",
      ...source,
    },
    kind: "worker",
    surface: "service",
    provider: "cloudflare",
    category: "x",
    suggestedName: id,
    name: text(id),
    description: text(id),
    badge: text("b"),
    inputs: [],
    outputAllowlist: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

const SERVERS: TcsServer[] = [
  { base: "https://a.test", isDefault: true },
  { base: "https://b.test", isDefault: false },
];

type Handler = (url: URL) => Response;
const origFetch = globalThis.fetch;
function stub(handler: Handler): void {
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(handler(new URL(String(input))))) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = origFetch;
});
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const SHARED = { git: "https://github.com/o/shared.git", ref: "deadbeef" };

describe("tcs aggregate", () => {
  test("merges + de-dups shared Capsules with seenOn", async () => {
    stub((url) =>
      url.host === "a.test"
        ? json({ items: [L("x"), L("shared", SHARED)] })
        : json({ items: [L("y"), L("shared", SHARED)] }),
    );
    const s = await loadMoreTcs(
      initTcsState(SERVERS, { sort: "updated", locale: "en" }),
    );
    expect(s.items.map((i) => i.id).sort()).toEqual(["shared", "x", "y"]);
    expect(s.items.find((i) => i.id === "shared")!.seenOn.sort()).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
    expect(s.done).toBe(true);
  });

  test("a failing server is isolated; others render", async () => {
    stub((url) => {
      if (url.host === "a.test") return json({ items: [L("x")] });
      throw new Error("down");
    });
    const s = await loadMoreTcs(
      initTcsState(SERVERS, { sort: "updated", locale: "en" }),
    );
    expect(s.items.map((i) => i.id)).toEqual(["x"]);
    expect(s.status.find((st) => st.base === "https://b.test")!.ok).toBe(false);
  });

  test("search-unsupported (501) server is marked, not fatal", async () => {
    stub((url) =>
      url.host === "a.test"
        ? json({ items: [L("x")] })
        : json({ error: { code: "not_implemented" } }, 501),
    );
    const s = await loadMoreTcs(
      initTcsState(SERVERS, { sort: "updated", locale: "en", q: "foo" }),
    );
    expect(s.items.map((i) => i.id)).toEqual(["x"]);
    expect(s.status.find((st) => st.base === "https://b.test")!.supported).toBe(
      false,
    );
  });

  test("paginates per-server until cursors exhaust", async () => {
    stub((url) => {
      const cursor = url.searchParams.get("cursor");
      if (url.host === "a.test") {
        return cursor
          ? json({ items: [L("a2")] })
          : json({ items: [L("a1")], nextCursor: "A2" });
      }
      return json({ items: [L("b1")] });
    });
    let s = await loadMoreTcs(
      initTcsState(SERVERS, { sort: "updated", locale: "en" }),
    );
    expect(s.done).toBe(false);
    s = await loadMoreTcs(s);
    expect(s.done).toBe(true);
    expect(s.items.map((i) => i.id).sort()).toEqual(["a1", "a2", "b1"]);
  });

  test("sortTcsItems orders updated desc and name asc", () => {
    const items: AggregatedTcsListing[] = [
      {
        ...L("old", undefined, "2026-01-01T00:00:00.000Z"),
        seenOn: [],
        primaryServer: "",
        primaryDefault: false,
      },
      {
        ...L("new", undefined, "2026-02-01T00:00:00.000Z"),
        seenOn: [],
        primaryServer: "",
        primaryDefault: false,
      },
    ];
    expect(sortTcsItems(items, "updated", "en").map((i) => i.id)).toEqual([
      "new",
      "old",
    ]);
    expect(sortTcsItems(items, "name", "en").map((i) => i.id)).toEqual([
      "new",
      "old",
    ]);
  });
});
