import assert from "node:assert/strict";
import { HttpArtifactFetcher } from "./artifact_fetcher.ts";

function mockFetch(
  responder: (
    url: string,
    init: RequestInit,
  ) => Response | Promise<Response>,
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL
      ? `${input}`
      : input.url;
    return Promise.resolve(responder(url, init ?? {}));
  }) as typeof fetch;
}

Deno.test("HttpArtifactFetcher.fetch returns bytes and kind from header", async () => {
  const payload = new TextEncoder().encode("hello world");
  let seenAuth: string | null = null;
  let seenUrl = "";
  const fetcher = new HttpArtifactFetcher({
    baseUrl: "https://kernel.example.com/v1/artifacts",
    token: "tk",
    fetch: mockFetch((url, init) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>).authorization;
      return new Response(payload, {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "x-takosumi-artifact-kind": "lambda-zip",
          "x-takosumi-artifact-size": "11",
        },
      });
    }),
  });
  const got = await fetcher.fetch("sha256:abc");
  assert.equal(
    seenUrl,
    "https://kernel.example.com/v1/artifacts/sha256%3Aabc",
  );
  assert.equal(seenAuth, "Bearer tk");
  assert.equal(got.kind, "lambda-zip");
  assert.equal(got.contentType, "application/zip");
  assert.equal(new TextDecoder().decode(got.bytes), "hello world");
});

Deno.test("HttpArtifactFetcher.fetch throws on non-200", async () => {
  const fetcher = new HttpArtifactFetcher({
    baseUrl: "https://kernel.example.com/v1/artifacts",
    token: "tk",
    fetch: mockFetch(() =>
      new Response("nope", { status: 500, statusText: "Server Error" })
    ),
  });
  await assert.rejects(
    () => fetcher.fetch("sha256:bad"),
    /artifact fetch failed/,
  );
});

Deno.test("HttpArtifactFetcher.head returns kind+size from headers", async () => {
  const fetcher = new HttpArtifactFetcher({
    baseUrl: "https://kernel.example.com/v1/artifacts/",
    token: "tk",
    fetch: mockFetch(() =>
      new Response(null, {
        status: 200,
        headers: {
          "x-takosumi-artifact-kind": "js-bundle",
          "x-takosumi-artifact-size": "256",
        },
      })
    ),
  });
  const got = await fetcher.head("sha256:abc");
  assert.deepEqual(got, { kind: "js-bundle", size: 256 });
});

Deno.test("HttpArtifactFetcher.head returns undefined on 404", async () => {
  const fetcher = new HttpArtifactFetcher({
    baseUrl: "https://kernel.example.com/v1/artifacts",
    token: "tk",
    fetch: mockFetch(() => new Response(null, { status: 404 })),
  });
  const got = await fetcher.head("sha256:missing");
  assert.equal(got, undefined);
});

Deno.test("HttpArtifactFetcher.head throws on other errors", async () => {
  const fetcher = new HttpArtifactFetcher({
    baseUrl: "https://kernel.example.com/v1/artifacts",
    token: "tk",
    fetch: mockFetch(() =>
      new Response(null, { status: 503, statusText: "Unavailable" })
    ),
  });
  await assert.rejects(
    () => fetcher.head("sha256:abc"),
    /artifact head failed/,
  );
});
