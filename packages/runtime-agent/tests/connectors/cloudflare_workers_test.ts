import assert from "node:assert/strict";
import type { ArtifactFetcher } from "../../src/artifact_fetcher.ts";
import { CloudflareWorkersConnector } from "../../src/connectors/cloudflare/workers.ts";

interface CapturedCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  body?: FormData;
  bodyText?: string;
}

function recordingFetch(
  responder: (call: CapturedCall) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" || input instanceof URL
      ? `${input}`
      : input.url;
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const call: CapturedCall = {
      url,
      method,
      authorization: headers.get("authorization"),
    };
    const body = init?.body;
    if (body instanceof FormData) {
      // FormData can only be read once; clone via the constructor.
      const copy = new FormData();
      for (const [k, v] of body.entries()) copy.append(k, v);
      call.body = copy;
    } else if (typeof body === "string") {
      call.bodyText = body;
    }
    calls.push(call);
    return await Promise.resolve(responder(call));
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function fakeFetcher(
  bytes: Uint8Array,
  requestedHashes: string[],
): ArtifactFetcher {
  return {
    async fetch(hash: string) {
      requestedHashes.push(hash);
      return await Promise.resolve({
        bytes,
        kind: "js-bundle",
        contentType: "application/javascript+module",
      });
    },
    async head(_hash: string) {
      return await Promise.resolve({ kind: "js-bundle", size: bytes.length });
    },
  };
}

function okEnvelope(): Response {
  return new Response(
    JSON.stringify({ success: true, result: {} }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

Deno.test(
  "CloudflareWorkersConnector.apply fetches js-bundle, PUTs multipart upload, returns descriptor",
  async () => {
    const bundleBytes = new TextEncoder().encode(
      "export default { fetch() {} }",
    );
    const requestedHashes: string[] = [];
    const fetcher = fakeFetcher(bundleBytes, requestedHashes);
    const { fetch: mockFetch, calls } = recordingFetch(() => okEnvelope());
    const connector = new CloudflareWorkersConnector({
      accountId: "acct-1",
      apiToken: "cf-token",
      fetch: mockFetch,
    });

    const result = await connector.apply({
      shape: "worker@v1",
      provider: "cloudflare-workers",
      resourceName: "my-script",
      spec: {
        artifact: { kind: "js-bundle", hash: "sha256:abc" },
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
        env: { LOG_LEVEL: "info" },
      },
    }, { fetcher });

    assert.deepEqual(requestedHashes, ["sha256:abc"]);
    assert.equal(result.handle, "acct-1/my-script");
    assert.equal(
      result.outputs.url,
      "https://my-script.acct-1.workers.dev",
    );
    assert.equal(result.outputs.scriptName, "my-script");
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, "PUT");
    assert.equal(call.authorization, "Bearer cf-token");
    assert.match(
      call.url,
      /\/accounts\/acct-1\/workers\/scripts\/my-script$/,
    );
    assert.ok(call.body, "expected FormData body");
    const metadataPart = call.body!.get("metadata");
    assert.ok(metadataPart instanceof Blob);
    const metadataJson = JSON.parse(await (metadataPart as Blob).text()) as {
      main_module: string;
      compatibility_date: string;
      compatibility_flags?: string[];
      bindings?: { type: string; name: string; text: string }[];
    };
    assert.equal(metadataJson.main_module, "worker.js");
    assert.equal(metadataJson.compatibility_date, "2025-01-01");
    assert.deepEqual(metadataJson.compatibility_flags, ["nodejs_compat"]);
    assert.ok(metadataJson.bindings);
    assert.deepEqual(metadataJson.bindings, [
      { type: "plain_text", name: "LOG_LEVEL", text: "info" },
    ]);
    const modulePart = call.body!.get("worker.js");
    assert.ok(modulePart instanceof Blob);
    const moduleBytes = new Uint8Array(
      await (modulePart as Blob).arrayBuffer(),
    );
    assert.deepEqual(moduleBytes, bundleBytes);
  },
);

Deno.test(
  "CloudflareWorkersConnector.apply uses artifact.metadata.entrypoint when present",
  async () => {
    const fetcher = fakeFetcher(new Uint8Array([1, 2, 3]), []);
    const { fetch: mockFetch, calls } = recordingFetch(() => okEnvelope());
    const connector = new CloudflareWorkersConnector({
      accountId: "acct",
      apiToken: "tok",
      fetch: mockFetch,
    });
    await connector.apply({
      shape: "worker@v1",
      provider: "cloudflare-workers",
      resourceName: "fn",
      spec: {
        artifact: {
          kind: "js-bundle",
          hash: "sha256:abc",
          metadata: { entrypoint: "main.mjs" },
        },
        compatibilityDate: "2025-01-01",
      },
    }, { fetcher });

    const metadataBlob = calls[0].body!.get("metadata") as Blob;
    const metadata = JSON.parse(await metadataBlob.text());
    assert.equal(metadata.main_module, "main.mjs");
    assert.ok(calls[0].body!.get("main.mjs") instanceof Blob);
  },
);

Deno.test(
  "CloudflareWorkersConnector.apply rejects when ctx.fetcher is undefined",
  async () => {
    const { fetch: mockFetch } = recordingFetch(() => okEnvelope());
    const connector = new CloudflareWorkersConnector({
      accountId: "acct",
      apiToken: "tok",
      fetch: mockFetch,
    });
    let threw = false;
    try {
      await connector.apply({
        shape: "worker@v1",
        provider: "cloudflare-workers",
        resourceName: "fn",
        spec: {
          artifact: { kind: "js-bundle", hash: "sha256:abc" },
          compatibilityDate: "2025-01-01",
        },
      }, {});
    } catch (error) {
      threw = true;
      assert.match(String((error as Error).message), /artifactStore/);
    }
    assert.ok(threw, "expected apply to throw without fetcher");
  },
);

Deno.test(
  "CloudflareWorkersConnector.apply rejects when artifact.hash is missing",
  async () => {
    const fetcher = fakeFetcher(new Uint8Array(), []);
    const { fetch: mockFetch } = recordingFetch(() => okEnvelope());
    const connector = new CloudflareWorkersConnector({
      accountId: "acct",
      apiToken: "tok",
      fetch: mockFetch,
    });
    let threw = false;
    try {
      await connector.apply({
        shape: "worker@v1",
        provider: "cloudflare-workers",
        resourceName: "fn",
        spec: {
          artifact: { kind: "js-bundle" },
          compatibilityDate: "2025-01-01",
        },
      }, { fetcher });
    } catch (error) {
      threw = true;
      assert.match(String((error as Error).message), /hash/);
    }
    assert.ok(threw);
  },
);

Deno.test(
  "CloudflareWorkersConnector.destroy DELETEs script and treats 404 as ok",
  async () => {
    let nextStatus = 200;
    const { fetch: mockFetch, calls } = recordingFetch(() => {
      const status = nextStatus;
      return new Response(
        status === 404 ? "" : JSON.stringify({ success: true, result: {} }),
        {
          status,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const connector = new CloudflareWorkersConnector({
      accountId: "acct-1",
      apiToken: "cf-token",
      fetch: mockFetch,
    });

    const ok = await connector.destroy({
      shape: "worker@v1",
      provider: "cloudflare-workers",
      handle: "acct-1/my-script",
    }, {});
    assert.equal(ok.ok, true);
    assert.equal(ok.note, undefined);
    assert.equal(calls.at(-1)?.method, "DELETE");
    assert.match(
      calls.at(-1)!.url,
      /\/accounts\/acct-1\/workers\/scripts\/my-script$/,
    );

    nextStatus = 404;
    const missing = await connector.destroy({
      shape: "worker@v1",
      provider: "cloudflare-workers",
      handle: "acct-1/my-script",
    }, {});
    assert.equal(missing.ok, true);
    assert.equal(missing.note, "script not found");
  },
);

Deno.test(
  "CloudflareWorkersConnector.describe returns running on 200, missing on 404",
  async () => {
    let nextStatus = 200;
    const { fetch: mockFetch } = recordingFetch(() =>
      new Response(
        nextStatus === 404 ? "" : JSON.stringify({ success: true, result: {} }),
        {
          status: nextStatus,
          headers: { "content-type": "application/json" },
        },
      )
    );
    const connector = new CloudflareWorkersConnector({
      accountId: "acct-1",
      apiToken: "cf-token",
      fetch: mockFetch,
    });

    const running = await connector.describe({
      shape: "worker@v1",
      provider: "cloudflare-workers",
      handle: "acct-1/my-script",
    }, {});
    assert.equal(running.status, "running");
    assert.equal(
      (running.outputs as { url?: string } | undefined)?.url,
      "https://my-script.acct-1.workers.dev",
    );

    nextStatus = 404;
    const missing = await connector.describe({
      shape: "worker@v1",
      provider: "cloudflare-workers",
      handle: "acct-1/my-script",
    }, {});
    assert.equal(missing.status, "missing");
  },
);
