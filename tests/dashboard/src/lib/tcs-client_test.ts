import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchTcsListing,
  fetchTcsListingsPage,
  mergeTcsListingRepoMetadata,
  parseTcsRepoMetadata,
  type TcsListing,
} from "../../../../dashboard/src/lib/tcs-client.ts";

const originalFetch = globalThis.fetch;
const text = (value: string) => ({ ja: value, en: value });

function listing(extra: Partial<TcsListing> = {}): TcsListing {
  return {
    id: "tako/example",
    source: {
      url: "https://github.com/tako0614/example.git",
      ref: "main",
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

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("TCS repo metadata", () => {
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
    const staleListing = listing({
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
    } as unknown as Partial<TcsListing>);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/tcs/v1/listings/tako%2Fexample")) {
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
            listing({
              source: {
                git: "https://github.com/tako0614/example.git",
                resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
                path: ".",
              },
            } as unknown as Partial<TcsListing>),
          ],
        }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    await expect(
      fetchTcsListingsPage("https://store.example.test"),
    ).rejects.toThrow("unsupported fields");
  });

  test("accepts a canonical source without an optional ref hint", async () => {
    const unpinned = listing({
      source: {
        url: "https://github.com/tako0614/example.git",
        path: ".",
      },
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ items: [unpinned] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const page = await fetchTcsListingsPage("https://store.example.test");
    expect(page.items[0]?.source).toEqual(unpinned.source);
  });

  test("keeps only credential-free HTTPS icons and drops wire aggregation hints", async () => {
    const unsafePresentation = listing({
      iconUrl: "https://user:secret@assets.example.test/icon.svg?token=x",
      primaryServer: "https://attacker.example.test",
      primaryDefault: true,
      seenOn: ["https://attacker.example.test"],
    } as unknown as Partial<TcsListing>);
    const safePresentation = listing({
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

  test("input-normalizes a legacy git-only source without re-emitting git", async () => {
    const legacy = listing({
      source: {
        git: "https://github.com/tako0614/example.git",
        path: "./deploy/opentofu",
      },
    } as unknown as Partial<TcsListing>);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ items: [legacy] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const page = await fetchTcsListingsPage("https://store.example.test");
    expect(page.items[0]?.source).toEqual({
      url: "https://github.com/tako0614/example.git",
      path: "deploy/opentofu",
    });
    expect(page.items[0]?.source).not.toHaveProperty("git");
  });

  test("rejects a source that declares canonical url and legacy git together", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            listing({
              source: {
                url: "https://github.com/tako0614/example.git",
                git: "https://github.com/tako0614/example.git",
                path: ".",
              },
            } as unknown as Partial<TcsListing>),
          ],
        }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    await expect(
      fetchTcsListingsPage("https://store.example.test"),
    ).rejects.toThrow("both url and legacy git");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          items: [
            listing({
              source: {
                url: "",
                git: "https://github.com/tako0614/example.git",
                path: ".",
              },
            } as unknown as Partial<TcsListing>),
          ],
        }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    await expect(
      fetchTcsListingsPage("https://store.example.test"),
    ).rejects.toThrow("both url and legacy git");
  });

  test("rejects unsafe Store source URLs, paths, and ref hints", async () => {
    const unsafeSources = [
      { url: "http://example.test/app.git", path: "." },
      { url: "https://user:secret@example.test/app.git", path: "." },
      { url: "https://example.test/app.git?token=secret", path: "." },
      { url: "https://example.test/app.git", path: "/deploy/opentofu" },
      { url: "https://example.test/app.git", path: "../opentofu" },
      {
        url: "https://example.test/app.git",
        ref: "--upload-pack=bad",
        path: ".",
      },
      { url: "https://example.test/app.git", ref: "main\nnext", path: "." },
    ];

    for (const source of unsafeSources) {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            items: [listing({ source } as unknown as Partial<TcsListing>)],
          }),
          { headers: { "content-type": "application/json" } },
        )) as typeof fetch;
      await expect(
        fetchTcsListingsPage("https://store.example.test"),
      ).rejects.toThrow(/listing source/u);
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
