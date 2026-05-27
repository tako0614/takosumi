import { assertEquals } from "jsr:@std/assert@^1.0.6";
import {
  checkJsrPackageReadiness,
  summarizeJsrReadiness,
} from "./jsr-package-readiness.ts";

Deno.test("checkJsrPackageReadiness classifies published and missing versions", async () => {
  const results = await checkJsrPackageReadiness({
    packages: [
      {
        name: "@takos/example-published",
        version: "1.2.0",
        directory: "packages/example-published",
      },
      {
        name: "@takos/example-old",
        version: "2.0.0",
        directory: "packages/example-old",
      },
      {
        name: "@takos/example-missing",
        version: "0.1.0",
        directory: "packages/example-missing",
      },
      {
        name: "@takos/example-empty",
        version: "0.1.0",
        directory: "packages/example-empty",
      },
    ],
    fetch: fakeFetch({
      "https://jsr.test/@takos/example-published/meta.json": {
        latest: "1.2.0",
        versions: {
          "1.0.0": { createdAt: "2026-01-01T00:00:00Z" },
          "1.2.0": { createdAt: "2026-01-02T00:00:00Z" },
        },
      },
      "https://jsr.test/@takos/example-old/meta.json": {
        latest: "1.9.0",
        versions: {
          "1.9.0": { createdAt: "2026-01-03T00:00:00Z" },
        },
      },
      "https://api.jsr.test/scopes/takos/packages/example-empty": {
        scope: "takos",
        name: "example-empty",
        versionCount: 0,
      },
    }),
    apiBaseUrl: "https://api.jsr.test",
    registryBaseUrl: "https://jsr.test",
  });

  assertEquals(results.map((result) => result.status), [
    "published",
    "version-missing",
    "package-missing",
    "version-missing",
  ]);
  assertEquals(results[0].publishedVersions, ["1.0.0", "1.2.0"]);
  assertEquals(results[1].latest, "1.9.0");
  assertEquals(results[3].publishedVersions, []);
});

Deno.test("summarizeJsrReadiness prints package status lines", () => {
  assertEquals(
    summarizeJsrReadiness([
      {
        name: "@takos/example",
        targetVersion: "1.0.0",
        status: "published",
        latest: "1.0.0",
      },
      {
        name: "@takos/missing",
        targetVersion: "0.1.0",
        status: "package-missing",
        message: "JSR package record does not exist",
      },
    ]),
    "published       @takos/example@1.0.0 latest=1.0.0\n" +
      "package-missing @takos/missing@0.1.0 JSR package record does not exist\n",
  );
});

function fakeFetch(
  fixtures: Readonly<Record<string, unknown>>,
): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (!(url in fixtures)) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(Response.json(fixtures[url]));
  }) as typeof fetch;
}
