import { test } from "bun:test";
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

test("HttpArtifactFetcher.fetch returns bytes and kind from header", async () => {
  const payload = new TextEncoder().encode("hello world");
  let seenAuth: string | null = null;
  let seenUrl = "";
  const fetcher = new HttpArtifactFetcher({
    baseUrl: "https://service.example.com/v1/artifacts",
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
    "https://service.example.com/v1/artifacts/sha256%3Aabc",
  );
  assert.equal(seenAuth, "Bearer tk");
  assert.equal(got.kind, "lambda-zip");
  assert.equal(got.contentType, "application/zip");
  assert.equal(new TextDecoder().decode(got.bytes), "hello world");
});

test("HttpArtifactFetcher.fetch throws on non-200", async () => {
  const fetcher = new HttpArtifactFetcher({
    baseUrl: "https://service.example.com/v1/artifacts",
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

test("HttpArtifactFetcher.fetch rejects when content-length exceeds cap", async () => {
  let cancelled = false;
  const fetcher = new HttpArtifactFetcher({
    baseUrl: "https://service.example.com/v1/artifacts",
    token: "tk",
    maxBytes: 16,
    fetch: mockFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        pull(controller) {
          controller.enqueue(new Uint8Array(64));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-length": "64" },
      });
    }),
  });
  await assert.rejects(
    () => fetcher.fetch("sha256:big"),
    /declares 64 bytes, cap is 16/,
  );
  assert.equal(cancelled, true);
});

test("HttpArtifactFetcher.fetch streams and aborts past cap when length absent", async () => {
  const fetcher = new HttpArtifactFetcher({
    baseUrl: "https://service.example.com/v1/artifacts",
    token: "tk",
    maxBytes: 8,
    fetch: mockFetch(() => {
      // Chunked/unknown length: no content-length header, body streams past cap.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(4));
          controller.enqueue(new Uint8Array(4));
          controller.enqueue(new Uint8Array(4));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }),
  });
  await assert.rejects(
    () => fetcher.fetch("sha256:stream"),
    /exceeds 8 bytes/,
  );
});

test("HttpArtifactFetcher.fetch accepts a body at the cap boundary", async () => {
  const payload = new Uint8Array(8).fill(1);
  const fetcher = new HttpArtifactFetcher({
    baseUrl: "https://service.example.com/v1/artifacts",
    token: "tk",
    maxBytes: 8,
    fetch: mockFetch(() =>
      new Response(payload, {
        status: 200,
        headers: { "x-takosumi-artifact-kind": "raw" },
      })
    ),
  });
  const got = await fetcher.fetch("sha256:ok");
  assert.equal(got.bytes.byteLength, 8);
});

test("HttpArtifactFetcher.head returns kind+size from headers", async () => {
  const fetcher = new HttpArtifactFetcher({
    baseUrl: "https://service.example.com/v1/artifacts/",
    token: "tk",
    fetch: mockFetch(() =>
      new Response(null, {
        status: 200,
        headers: {
          "x-takosumi-artifact-kind": "operator.example/test-bundle",
          "x-takosumi-artifact-size": "256",
        },
      })
    ),
  });
  const got = await fetcher.head("sha256:abc");
  assert.deepEqual(got, { kind: "operator.example/test-bundle", size: 256 });
});

test("HttpArtifactFetcher.head returns undefined on 404", async () => {
  const fetcher = new HttpArtifactFetcher({
    baseUrl: "https://service.example.com/v1/artifacts",
    token: "tk",
    fetch: mockFetch(() => new Response(null, { status: 404 })),
  });
  const got = await fetcher.head("sha256:missing");
  assert.equal(got, undefined);
});

test("HttpArtifactFetcher.head throws on other errors", async () => {
  const fetcher = new HttpArtifactFetcher({
    baseUrl: "https://service.example.com/v1/artifacts",
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
