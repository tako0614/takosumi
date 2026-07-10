import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchTcsListing,
  fetchTcsListingsPage,
  hydrateRequiredTcsListingWithRepoMetadata,
  hydrateTcsListingWithRepoMetadata,
  type TcsListing,
} from "../../../../dashboard/src/lib/tcs-client.ts";

const originalFetch = globalThis.fetch;
const text = (value: string) => ({ ja: value, en: value });

function listing(extra: Partial<TcsListing> = {}): TcsListing {
  return {
    id: "tako/example",
    source: {
      git: "https://github.com/tako0614/example.git",
      ref: "main",
      resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
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
    });
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

    expect(page.items[0]?.inputs).toBeUndefined();
    expect(page.items[0]?.installExperience).toBeUndefined();
    expect(page.items[0]?.outputAllowlist).toBeUndefined();
    expect(single?.inputs).toBeUndefined();
    expect(single?.installExperience).toBeUndefined();
    expect(single?.outputAllowlist).toBeUndefined();
  });

  test("hydrates optional install UX metadata from the repository", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "https://api.github.com/repos/tako0614/example/contents/.well-known%2Ftcs.json?ref=0123456789abcdef0123456789abcdef01234567",
      );
      return new Response(
        JSON.stringify({
          content: btoa(
            JSON.stringify({
              schemaVersion: "tcs.repo/v1",
              modulePath: "deploy/opentofu",
              suggestedName: "repo-example",
              iconUrl: "public/icon.svg",
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
                    baseDomain: "app.takos.jp",
                  },
                ],
              },
            }),
          ),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const hydrated = await hydrateTcsListingWithRepoMetadata(listing());

    expect(hydrated.source.path).toBe("deploy/opentofu");
    expect(hydrated.suggestedName).toBe("repo-example");
    expect(hydrated.name.en).toBe("Repo Example");
    expect(hydrated.inputs?.[0]?.name).toBe("public_subdomain");
    expect(hydrated.installExperience?.projections?.[0]).toEqual({
      kind: "public_endpoint",
      variables: { subdomain: "public_subdomain" },
      baseDomain: "app.takos.jp",
    });
    expect(hydrated.outputAllowlist).toBeUndefined();
    expect(hydrated.iconUrl).toBe(
      "https://raw.githubusercontent.com/tako0614/example/0123456789abcdef0123456789abcdef01234567/public/icon.svg",
    );
  });

  test("keeps the store listing usable when a repository has no optional metadata", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 404 })) as typeof fetch;

    const base = listing();
    await expect(hydrateTcsListingWithRepoMetadata(base)).resolves.toBe(base);
  });

  test("fails closed when a Store install cannot load repo metadata", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 404 })) as typeof fetch;

    await expect(
      hydrateRequiredTcsListingWithRepoMetadata(listing()),
    ).rejects.toThrow("repository install metadata is unavailable");
  });

  test("falls back to raw metadata when the GitHub Contents API is rate limited", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return new Response("rate limited", { status: 429 });
      }
      expect(String(input)).toBe(
        "https://raw.githubusercontent.com/tako0614/example/0123456789abcdef0123456789abcdef01234567/.well-known/tcs.json",
      );
      return new Response(
        JSON.stringify({
          schemaVersion: "tcs.repo/v1",
          modulePath: "infra",
          description: text("Repo description"),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const hydrated = await hydrateTcsListingWithRepoMetadata(listing());

    expect(calls[0]).toBe(
      "https://api.github.com/repos/tako0614/example/contents/.well-known%2Ftcs.json?ref=0123456789abcdef0123456789abcdef01234567",
    );
    expect(hydrated.source.path).toBe("infra");
    expect(hydrated.description.en).toBe("Repo description");
    expect(hydrated.inputs).toBeUndefined();
    expect(hydrated.outputAllowlist).toBeUndefined();
  });
});
