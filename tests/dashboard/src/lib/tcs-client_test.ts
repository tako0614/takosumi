import { afterEach, describe, expect, test } from "bun:test";
import {
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
  test("hydrates setup metadata from the repository instead of requiring the store listing to carry it", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "https://raw.githubusercontent.com/tako0614/example/0123456789abcdef0123456789abcdef01234567/.well-known/tcs.json",
      );
      return new Response(
        JSON.stringify({
          schemaVersion: "tcs.repo/v1",
          modulePath: "deploy/opentofu",
          suggestedName: "repo-example",
          iconUrl: "public/icon.svg",
          inputs: [
            {
              name: "project_name",
              label: text("Service name"),
              defaultValue: "service-name-with-space",
            },
          ],
          installExperience: {
            projections: [{ kind: "service_name", variable: "project_name" }],
          },
          outputAllowlist: [{ key: "url", from: "url", type: "url" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const hydrated = await hydrateTcsListingWithRepoMetadata(listing());

    expect(hydrated.source.path).toBe("deploy/opentofu");
    expect(hydrated.suggestedName).toBe("repo-example");
    expect(hydrated.inputs.map((input) => input.name)).toEqual([
      "project_name",
    ]);
    expect(hydrated.installExperience?.projections?.[0]).toEqual({
      kind: "service_name",
      variable: "project_name",
    });
    expect(hydrated.outputAllowlist).toEqual([
      { key: "url", from: "url", type: "url" },
    ]);
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

  test("falls back to the GitHub Contents API when raw metadata is rate limited", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return new Response("rate limited", { status: 429 });
      }
      expect(String(input)).toBe(
        "https://api.github.com/repos/tako0614/example/contents/.well-known%2Ftcs.json?ref=0123456789abcdef0123456789abcdef01234567",
      );
      return new Response(
        JSON.stringify({
          content: btoa(
            JSON.stringify({
              schemaVersion: "tcs.repo/v1",
              inputs: [
                {
                  name: "project_name",
                  label: text("Service name"),
                  defaultValue: "service-name-with-space",
                },
              ],
              outputAllowlist: [{ key: "api_url", from: "api_url", type: "url" }],
            }),
          ),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const hydrated = await hydrateTcsListingWithRepoMetadata(listing());

    expect(calls[0]).toBe(
      "https://raw.githubusercontent.com/tako0614/example/0123456789abcdef0123456789abcdef01234567/.well-known/tcs.json",
    );
    expect(hydrated.inputs.map((input) => input.name)).toEqual([
      "project_name",
    ]);
    expect(hydrated.outputAllowlist).toEqual([
      { key: "api_url", from: "api_url", type: "url" },
    ]);
  });
});
