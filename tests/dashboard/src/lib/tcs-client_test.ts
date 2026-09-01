import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchTcsServerInfo,
  fetchTcsListing,
  fetchTcsListingsPage,
  mergeTcsListingRepoMetadata,
  parseTcsRepoMetadata,
  TcsNotSupportedError,
  type TcsListing,
} from "../../../../dashboard/src/lib/tcs-client.ts";

const originalFetch = globalThis.fetch;
const text = (value: string) => ({ ja: value, en: value });

function listing(extra: Partial<TcsListing> = {}): TcsListing {
  return {
    id: "tako/example",
    source: {
      url: "https://github.com/tako0614/example",
      path: ".",
    },
    kind: "worker",
    surface: "service",
    provider: "cloudflare",
    category: "general",
    suggestedName: "example",
    name: text("Example"),
    description: text("Example"),
    badge: text("Installable"),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

function wireListing(extra: Record<string, unknown> = {}): unknown {
  const local = listing();
  return {
    ...local,
    source: { git: local.source.url, path: local.source.path },
    ...extra,
  };
}

function pageResponse(items: readonly unknown[] = [wireListing()]): Response {
  return new Response(JSON.stringify({ items }), {
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("TCS repo metadata", () => {
  test("prefers v2 server-info and falls back to the legacy well-known route only on 404", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/tcs/v2/server-info")) {
        return new Response(
          JSON.stringify({
            spec: { version: "2.0", capabilities: ["search"] },
            server: {
              name: "Store",
              software: { name: "store", version: "1" },
              baseUrl: "https://store.example.test",
            },
            listings: { count: 1 },
            categories: [],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const info = await fetchTcsServerInfo("https://store.example.test");

    expect(info.spec.version).toBe("2.0");
    expect(requested).toEqual([
      "https://store.example.test/tcs/v2/server-info",
    ]);
  });

  test("falls back to the legacy well-known server-info on a missing v2 route", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/tcs/v2/server-info")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          spec: { version: "1.0", capabilities: [] },
          server: {
            name: "Legacy Store",
            software: { name: "store", version: "1" },
            baseUrl: "https://store.example.test",
          },
          listings: { count: 1 },
          categories: [],
          kinds: [],
          providers: [],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const info = await fetchTcsServerInfo("https://store.example.test");

    expect(info.spec.version).toBe("1.0");
    expect(requested).toEqual([
      "https://store.example.test/tcs/v2/server-info",
      "https://store.example.test/.well-known/tcs",
    ]);
  });

  test("prefers v2 and falls back to a legacy v1 read only when v2 is absent", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/tcs/v2/")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({ items: [wireListing()] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const page = await fetchTcsListingsPage("https://store.example.test");

    expect(page.items).toHaveLength(1);
    expect(requested[0]).toContain("/tcs/v2/listings");
    expect(requested[1]).toContain("/tcs/v1/listings");
  });

  test("does not hide a live v2 405 behind the legacy read path", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response("method not allowed", { status: 405 });
    }) as typeof fetch;

    await expect(
      fetchTcsListingsPage("https://store.example.test"),
    ).rejects.toThrow("listings 405");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain("/tcs/v2/listings");
  });

  test("emits only the TCS v2 updated/created sort values", async () => {
    const requested: URL[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(new URL(String(input)));
      return new Response(JSON.stringify({ items: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await fetchTcsListingsPage("https://store.example.test", {
      sort: "updated",
    });
    await fetchTcsListingsPage("https://store.example.test", {
      sort: "created",
    });
    // Simulate a stale v1 caller at the runtime boundary. The v2 request must
    // omit the retired value rather than sending `sort=name`.
    await fetchTcsListingsPage("https://store.example.test", {
      sort: "name" as never,
    });

    expect(requested.map((url) => url.searchParams.get("sort"))).toEqual([
      "updated",
      "created",
      null,
    ]);
  });

  test("coalesces identical in-flight listing page requests and detaches results", async () => {
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async () => {
      calls += 1;
      await pending;
      return new Response(JSON.stringify({ items: [wireListing()] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const firstPromise = fetchTcsListingsPage("https://store.example.test");
    const secondPromise = fetchTcsListingsPage("https://store.example.test");
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(calls).toBe(1);
    expect(first).not.toBe(second);
    expect(first.items).not.toBe(second.items);
    const mutableFirst = first as unknown as {
      items: Array<{ name: { ja: string; en: string } }>;
    };
    mutableFirst.items[0]!.name.ja = "Changed";
    expect(second.items[0]?.name.ja).toBe("Example");
  });

  test("coalesces absolute URLs that differ only by host case and default port", async () => {
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async () => {
      calls += 1;
      await pending;
      return pageResponse();
    }) as typeof fetch;

    const first = fetchTcsListingsPage("HTTPS://STORE.EXAMPLE.TEST:443");
    const second = fetchTcsListingsPage("https://store.example.test");
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
  });

  test("keeps a shared settlement successful when a later subscriber aborts", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return pageResponse();
    }) as typeof fetch;

    const originalStructuredClone = globalThis.structuredClone;
    const secondController = new AbortController();
    const secondReason = new Error("late subscriber cancellation");
    let cloneCalls = 0;
    globalThis.structuredClone = ((value: unknown) => {
      cloneCalls += 1;
      if (cloneCalls === 1) secondController.abort(secondReason);
      return originalStructuredClone(value);
    }) as typeof structuredClone;

    try {
      const results = await Promise.allSettled([
        fetchTcsListingsPage("https://store.example.test"),
        fetchTcsListingsPage("https://store.example.test", {
          signal: secondController.signal,
        }),
      ]);
      expect(calls).toBe(1);
      expect(cloneCalls).toBe(2);
      expect(secondController.signal.aborted).toBe(true);
      expect(results[0]?.status).toBe("fulfilled");
      expect(results[1]?.status).toBe("fulfilled");
    } finally {
      globalThis.structuredClone = originalStructuredClone;
    }
  });

  test("shares one v2 404 to v1 fallback sequence for identical requests", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/tcs/v2/")) return new Response("not found", { status: 404 });
      return pageResponse();
    }) as typeof fetch;

    const [first, second] = await Promise.all([
      fetchTcsListingsPage("https://store.example.test"),
      fetchTcsListingsPage("https://store.example.test"),
    ]);

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(requested).toEqual([
      "https://store.example.test/tcs/v2/listings",
      "https://store.example.test/tcs/v1/listings",
    ]);
  });

  test("aborting one subscriber leaves the shared upstream request live", async () => {
    let calls = 0;
    let release!: () => void;
    let upstreamSignal: AbortSignal | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      upstreamSignal = init?.signal;
      await pending;
      return pageResponse();
    }) as typeof fetch;

    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = fetchTcsListingsPage("https://store.example.test", {
      signal: firstController.signal,
    });
    const second = fetchTcsListingsPage("https://store.example.test", {
      signal: secondController.signal,
    });
    const reason = new Error("first caller cancelled");
    firstController.abort(reason);

    await expect(first).rejects.toBe(reason);
    expect(calls).toBe(1);
    expect(upstreamSignal?.aborted).toBe(false);
    release();
    await expect(second).resolves.toMatchObject({ items: [{ id: "tako/example" }] });
  });

  test("aborting the last subscriber aborts upstream and allows a late fresh request", async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let firstSignal: AbortSignal | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondPending = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        firstSignal = init?.signal;
        await firstPending;
      } else {
        await secondPending;
      }
      return pageResponse();
    }) as typeof fetch;

    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = fetchTcsListingsPage("https://store.example.test", {
      signal: firstController.signal,
    });
    const second = fetchTcsListingsPage("https://store.example.test", {
      signal: secondController.signal,
    });
    const firstReason = new Error("first caller cancelled");
    const secondReason = new Error("second caller cancelled");
    firstController.abort(firstReason);
    secondController.abort(secondReason);

    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    expect(firstResult).toEqual({ status: "rejected", reason: firstReason });
    expect(secondResult).toEqual({ status: "rejected", reason: secondReason });
    expect(firstSignal?.aborted).toBe(true);

    const late = fetchTcsListingsPage("https://store.example.test");
    const third = fetchTcsListingsPage("https://store.example.test");
    expect(calls).toBe(2);
    releaseFirst();
    // Let the old request settle while the replacement remains pending. A
    // stale settle must not evict the replacement from the in-flight map.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const fourth = fetchTcsListingsPage("https://store.example.test");
    expect(calls).toBe(2);
    releaseSecond();
    await Promise.all([late, third, fourth]);
  });

  test("rejects an already-aborted caller without joining an active request", async () => {
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async () => {
      calls += 1;
      await pending;
      return pageResponse();
    }) as typeof fetch;

    const active = fetchTcsListingsPage("https://store.example.test");
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    const aborted = fetchTcsListingsPage("https://store.example.test", {
      signal: controller.signal,
    });

    await expect(aborted).rejects.toBe(reason);
    expect(calls).toBe(1);
    release();
    await expect(active).resolves.toMatchObject({ items: [{ id: "tako/example" }] });
  });

  test("refetches after a settled listing page request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return pageResponse();
    }) as typeof fetch;

    await fetchTcsListingsPage("https://store.example.test");
    await fetchTcsListingsPage("https://store.example.test");

    expect(calls).toBe(2);
  });

  test("does not coalesce different listing page queries", async () => {
    let calls = 0;
    const requested: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1;
      requested.push(String(input));
      await pending;
      return pageResponse();
    }) as typeof fetch;

    const requests = [
      fetchTcsListingsPage("https://store.example.test", { q: "alpha" }),
      fetchTcsListingsPage("https://store.example.test", { cursor: "cursor" }),
      fetchTcsListingsPage("https://store.example.test", { sort: "created" }),
      fetchTcsListingsPage("https://store.example.test", { limit: 5 }),
    ];
    expect(calls).toBe(4);
    expect(new Set(requested).size).toBe(4);
    release();
    await Promise.all(requests);
  });

  test("preserves 501 and ordinary listing errors for concurrent subscribers", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("unsupported", { status: 501 });
    }) as typeof fetch;

    const unsupportedResults = await Promise.allSettled([
      fetchTcsListingsPage("https://store.example.test", { q: "alpha" }),
      fetchTcsListingsPage("https://store.example.test", { q: "alpha" }),
    ]);
    const unsupportedReasons = unsupportedResults.map((result) =>
      result.status === "rejected" ? result.reason : undefined,
    );
    expect(calls).toBe(1);
    expect(unsupportedReasons[0]).toBeInstanceOf(TcsNotSupportedError);
    expect(unsupportedReasons[1]).toBe(unsupportedReasons[0]);

    calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const errorResults = await Promise.allSettled([
      fetchTcsListingsPage("https://store.example.test"),
      fetchTcsListingsPage("https://store.example.test"),
    ]);
    const errorReasons = errorResults.map((result) =>
      result.status === "rejected" ? result.reason : undefined,
    );
    expect(calls).toBe(1);
    expect(errorReasons[0]).toEqual(new Error("listings 503"));
    expect(errorReasons[1]).toBe(errorReasons[0]);
  });

  test("uses the canonical v2 scope/slug detail path before the legacy id path", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/tcs/v2/")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(wireListing()), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await fetchTcsListing(
      "https://store.example.test",
      "tako/example",
    );

    expect(result?.source).toEqual({
      url: "https://github.com/tako0614/example",
    });
    expect(requested).toEqual([
      "https://store.example.test/tcs/v2/listings/tako/example",
      "https://store.example.test/tcs/v1/listings/tako%2Fexample",
    ]);
  });

  test("rejects malformed listing ids before issuing a detail request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    await expect(
      fetchTcsListing("https://store.example.test", "tako/example/extra"),
    ).rejects.toThrow("scope/slug");
    expect(calls).toBe(0);
  });

  test("accepts a v2 source without provider facets and keeps it URL-only", async () => {
    const v2 = wireListing({
      kind: undefined,
      surface: undefined,
      provider: undefined,
      category: undefined,
      source: { git: "https://github.com/tako0614/example.git" },
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ items: [v2] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const page = await fetchTcsListingsPage("https://store.example.test");
    expect(page.items[0]?.source).toEqual({
      url: "https://github.com/tako0614/example",
    });
    expect(page.items[0]?.kind).toBeUndefined();
    expect(page.items[0]?.surface).toBeUndefined();
    expect(page.items[0]?.provider).toBeUndefined();
  });

  test("accepts display metadata but ignores repo-owned setup authority", () => {
    const metadata = parseTcsRepoMetadata({
      schemaVersion: "tcs.repo/v1",
      id: "tako/example",
      modulePath: "deploy/opentofu",
      suggestedName: "example",
      inputs: [
        {
          name: "public_subdomain",
          format: "subdomain",
          required: true,
          label: text("Public slug"),
        },
      ],
    });
    expect(metadata).toBeDefined();

    expect(metadata).not.toHaveProperty("modulePath");
    expect(metadata).not.toHaveProperty("id");
    expect(metadata).not.toHaveProperty("suggestedName");
    expect(metadata).not.toHaveProperty("inputs");
  });

  test("strips deprecated setup fields from listing reads", async () => {
    const staleListing = wireListing({
      inputs: [
        {
          name: "worker_bundle_url",
          label: text("Worker bundle"),
        },
      ],
      installExperience: {
        projections: [
          {
            kind: "artifact",
            variables: {
              url: "worker_bundle_url",
              sha256: "worker_bundle_sha256",
            },
          },
        ],
      },
      outputAllowlist: [{ key: "url", from: "url", type: "url" }],
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url.endsWith("/tcs/v2/listings/tako/example") ||
        url.endsWith("/tcs/v1/listings/tako%2Fexample")
      ) {
        return new Response(JSON.stringify(staleListing), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          items: [staleListing],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const page = await fetchTcsListingsPage("https://store.example.test");
    const single = await fetchTcsListing(
      "https://store.example.test",
      "tako/example",
    );

    expect(page.items[0]).not.toHaveProperty("inputs");
    expect(page.items[0]).not.toHaveProperty("installExperience");
    expect(page.items[0]).not.toHaveProperty("outputAllowlist");
    expect(single).not.toHaveProperty("inputs");
    expect(single).not.toHaveProperty("installExperience");
    expect(single).not.toHaveProperty("outputAllowlist");
  });

  test("rejects retired or execution-authoritative Store source fields", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            wireListing({
              source: {
                git: "https://github.com/tako0614/example.git",
                resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
                path: ".",
              },
            }),
          ],
        }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    await expect(
      fetchTcsListingsPage("https://store.example.test"),
    ).rejects.toThrow("canonical TCS");
  });

  test("accepts and locally adapts the canonical Store-owned source tuple", async () => {
    const unpinned = wireListing({
      source: {
        git: "https://github.com/tako0614/example.git",
        path: ".",
      },
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ items: [unpinned] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const page = await fetchTcsListingsPage("https://store.example.test");
    expect(page.items[0]?.source).toEqual({
      url: "https://github.com/tako0614/example",
    });
  });

  test("keeps only credential-free HTTPS icons and drops wire aggregation hints", async () => {
    const unsafePresentation = wireListing({
      iconUrl: "https://user:secret@assets.example.test/icon.svg?token=x",
      primaryServer: "https://attacker.example.test",
      primaryDefault: true,
      seenOn: ["https://attacker.example.test"],
    });
    const safePresentation = wireListing({
      id: "tako/safe-icon",
      iconUrl: "https://assets.example.test/icon.svg",
    });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ items: [unsafePresentation, safePresentation] }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const page = await fetchTcsListingsPage("https://store.example.test");
    expect(page.items[0]).not.toHaveProperty("iconUrl");
    expect(page.items[0]).not.toHaveProperty("primaryServer");
    expect(page.items[0]).not.toHaveProperty("primaryDefault");
    expect(page.items[0]).not.toHaveProperty("seenOn");
    expect(page.items[1]?.iconUrl).toBe("https://assets.example.test/icon.svg");
  });

  test("adapts the TCS git field without re-emitting it locally", async () => {
    const legacy = wireListing({
      source: {
        git: "https://github.com/tako0614/example.git",
        path: "./deploy/opentofu",
      },
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ items: [legacy] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const page = await fetchTcsListingsPage("https://store.example.test");
    expect(page.items[0]?.source).toEqual({
      url: "https://github.com/tako0614/example",
    });
    expect(page.items[0]?.source).not.toHaveProperty("git");
  });

  test("rejects dashboard-local url aliases on the TCS wire", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            wireListing({
              source: {
                url: "https://github.com/tako0614/example.git",
                git: "https://github.com/tako0614/example.git",
                path: ".",
              },
            }),
          ],
        }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    await expect(
      fetchTcsListingsPage("https://store.example.test"),
    ).rejects.toThrow("canonical TCS");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            wireListing({
              source: {
                url: "",
                git: "https://github.com/tako0614/example.git",
                path: ".",
              },
            }),
          ],
        }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    await expect(
      fetchTcsListingsPage("https://store.example.test"),
    ).rejects.toThrow("canonical TCS");
  });

  test("rejects unsafe Store source URLs, paths, and extra authority", async () => {
    const unsafeSources = [
      { git: "http://example.test/app.git", path: "." },
      { git: "https://user:secret@example.test/app.git", path: "." },
      { git: "https://example.test/app.git?token=secret", path: "." },
      { git: "https://example.test/app.git#main", path: "." },
      {
        git: "https://example.test/app.git",
        ref: "main",
        path: ".",
      },
    ];

    for (const source of unsafeSources) {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            items: [wireListing({ source })],
          }),
          { headers: { "content-type": "application/json" } },
        )) as typeof fetch;
      await expect(
        fetchTcsListingsPage("https://store.example.test"),
      ).rejects.toThrow(/listing source/u);
    }
  });

  test("ignores every legacy path spelling instead of treating it as install authority", async () => {
    for (const path of [".", "deploy/opentofu", "../secret", "/absolute"]) {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            items: [wireListing({ source: { git: "https://example.test/app.git", path } })],
          }),
          { headers: { "content-type": "application/json" } },
        )) as typeof fetch;
      const page = await fetchTcsListingsPage("https://store.example.test");
      expect(page.items[0]?.source).toEqual({
        url: "https://example.test/app",
      });
    }
  });

  test("merges only display presentation observed by Source sync", () => {
    globalThis.fetch = (() => {
      throw new Error("metadata merge must not call a forge API");
    }) as typeof fetch;
    const metadata = parseTcsRepoMetadata({
      schemaVersion: "tcs.repo/v1",
      modulePath: "deploy/opentofu",
      suggestedName: "repo-example",
      iconUrl: "https://assets.example.test/icon.svg",
      name: text("Repo Example"),
      inputs: [
        {
          name: "public_subdomain",
          format: "subdomain",
          required: true,
          label: text("Public slug"),
        },
      ],
      installExperience: {
        projections: [
          {
            kind: "public_endpoint",
            variables: { subdomain: "public_subdomain" },
            baseDomain: "apps.operator.example",
          },
        ],
      },
    });
    const hydrated = mergeTcsListingRepoMetadata(listing(), metadata ?? null);

    expect(hydrated.source.path).toBe(".");
    expect(hydrated.suggestedName).toBe("example");
    expect(hydrated.name.en).toBe("Repo Example");
    expect(hydrated).not.toHaveProperty("inputs");
    expect(hydrated).not.toHaveProperty("installExperience");
    expect(hydrated).not.toHaveProperty("outputAllowlist");
    expect(hydrated.iconUrl).toBe("https://assets.example.test/icon.svg");
  });

  test("keeps the store listing usable when a snapshot has no optional metadata", () => {
    const base = listing();
    expect(mergeTcsListingRepoMetadata(base, null)).toBe(base);
  });

  test("does not synthesize forge-specific URLs for relative metadata assets", () => {
    const metadata = parseTcsRepoMetadata({
      schemaVersion: "tcs.repo/v1",
      iconUrl: "public/icon.svg",
    });
    const hydrated = mergeTcsListingRepoMetadata(listing(), metadata ?? null);
    expect(hydrated.iconUrl).toBeUndefined();
  });

  test("drops repo presentation icons with credentials, query, or fragment", () => {
    for (const iconUrl of [
      "https://user:secret@assets.example.test/icon.svg",
      "https://assets.example.test/icon.svg?token=secret",
      "https://assets.example.test/icon.svg#private",
    ]) {
      const metadata = parseTcsRepoMetadata({
        schemaVersion: "tcs.repo/v1",
        iconUrl,
      });
      expect(metadata).not.toHaveProperty("iconUrl");
      const hydrated = mergeTcsListingRepoMetadata(listing(), metadata ?? null);
      expect(hydrated).not.toHaveProperty("iconUrl");
    }
  });
});
