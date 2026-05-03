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

function okEnvelope(extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ success: true, result: extra }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function subdomainEnvelope(subdomain: string): Response {
  return new Response(
    JSON.stringify({ success: true, result: { subdomain } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * Build a recording fetch that returns sequential responses by URL pattern:
 * GET subdomain → returns subdomainEnvelope, anything else → okEnvelope.
 */
function recordingFetchWithSubdomain(
  subdomain: string,
): { fetch: typeof fetch; calls: CapturedCall[] } {
  return recordingFetch((call) => {
    if (call.method === "GET" && call.url.endsWith("/workers/subdomain")) {
      return subdomainEnvelope(subdomain);
    }
    return okEnvelope();
  });
}

Deno.test(
  "CloudflareWorkersConnector.apply fetches subdomain, then PUTs multipart upload",
  async () => {
    const bundleBytes = new TextEncoder().encode(
      "export default { fetch() {} }",
    );
    const requestedHashes: string[] = [];
    const fetcher = fakeFetcher(bundleBytes, requestedHashes);
    const { fetch: mockFetch, calls } = recordingFetchWithSubdomain("my-team");
    const connector = new CloudflareWorkersConnector({
      accountId: "acct-1",
      apiToken: "cf-token",
      fetch: mockFetch,
    });

    const result = await connector.apply({
      shape: "worker@v1",
      provider: "@takos/cloudflare-workers",
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
      "https://my-script.my-team.workers.dev",
    );
    assert.equal(result.outputs.scriptName, "my-script");
    assert.equal(calls.length, 2);
    const [subdomainCall, putCall] = calls;
    assert.equal(subdomainCall.method, "GET");
    assert.match(
      subdomainCall.url,
      /\/accounts\/acct-1\/workers\/subdomain$/,
    );
    assert.equal(putCall.method, "PUT");
    assert.equal(putCall.authorization, "Bearer cf-token");
    assert.match(
      putCall.url,
      /\/accounts\/acct-1\/workers\/scripts\/my-script$/,
    );
    assert.ok(putCall.body, "expected FormData body");
    const metadataPart = putCall.body!.get("metadata");
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
    const modulePart = putCall.body!.get("worker.js");
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
    const { fetch: mockFetch, calls } = recordingFetchWithSubdomain("teams");
    const connector = new CloudflareWorkersConnector({
      accountId: "acct",
      apiToken: "tok",
      fetch: mockFetch,
    });
    await connector.apply({
      shape: "worker@v1",
      provider: "@takos/cloudflare-workers",
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

    // [0]=GET subdomain, [1]=PUT script
    const putCall = calls[1];
    const metadataBlob = putCall.body!.get("metadata") as Blob;
    const metadata = JSON.parse(await metadataBlob.text());
    assert.equal(metadata.main_module, "main.mjs");
    assert.ok(putCall.body!.get("main.mjs") instanceof Blob);
  },
);

Deno.test(
  "CloudflareWorkersConnector.apply rejects when ctx.fetcher is undefined",
  async () => {
    const { fetch: mockFetch } = recordingFetchWithSubdomain("teams");
    const connector = new CloudflareWorkersConnector({
      accountId: "acct",
      apiToken: "tok",
      fetch: mockFetch,
    });
    let threw = false;
    try {
      await connector.apply({
        shape: "worker@v1",
        provider: "@takos/cloudflare-workers",
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
    const { fetch: mockFetch } = recordingFetchWithSubdomain("teams");
    const connector = new CloudflareWorkersConnector({
      accountId: "acct",
      apiToken: "tok",
      fetch: mockFetch,
    });
    let threw = false;
    try {
      await connector.apply({
        shape: "worker@v1",
        provider: "@takos/cloudflare-workers",
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
      provider: "@takos/cloudflare-workers",
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
      provider: "@takos/cloudflare-workers",
      handle: "acct-1/my-script",
    }, {});
    assert.equal(missing.ok, true);
    assert.equal(missing.note, "script not found");
  },
);

Deno.test(
  "CloudflareWorkersConnector.describe returns running on 200 with subdomain url, missing on 404",
  async () => {
    let nextScriptStatus = 200;
    const { fetch: mockFetch } = recordingFetch((call) => {
      if (call.method === "GET" && call.url.endsWith("/workers/subdomain")) {
        return subdomainEnvelope("teams");
      }
      // describe path: GET /workers/scripts/<name>
      const status = nextScriptStatus;
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

    const running = await connector.describe({
      shape: "worker@v1",
      provider: "@takos/cloudflare-workers",
      handle: "acct-1/my-script",
    }, {});
    assert.equal(running.status, "running");
    assert.equal(
      (running.outputs as { url?: string } | undefined)?.url,
      "https://my-script.teams.workers.dev",
    );

    nextScriptStatus = 404;
    const missing = await connector.describe({
      shape: "worker@v1",
      provider: "@takos/cloudflare-workers",
      handle: "acct-1/my-script",
    }, {});
    assert.equal(missing.status, "missing");
  },
);

Deno.test(
  "CloudflareWorkersConnector.apply falls back to accountId.workers.dev when subdomain returns 404",
  async () => {
    const fetcher = fakeFetcher(new Uint8Array([42]), []);
    const { fetch: mockFetch } = recordingFetch((call) => {
      if (call.method === "GET" && call.url.endsWith("/workers/subdomain")) {
        return new Response("", { status: 404 });
      }
      return okEnvelope();
    });
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    let result;
    try {
      const connector = new CloudflareWorkersConnector({
        accountId: "acct-no-sub",
        apiToken: "tok",
        fetch: mockFetch,
      });
      result = await connector.apply({
        shape: "worker@v1",
        provider: "@takos/cloudflare-workers",
        resourceName: "fn",
        spec: {
          artifact: { kind: "js-bundle", hash: "sha256:abc" },
          compatibilityDate: "2025-01-01",
        },
      }, { fetcher });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(result.outputs.url, "https://fn.acct-no-sub.workers.dev");
    assert.ok(
      warnings.some((w) => w.includes("acct-no-sub")),
      "expected console.warn about missing subdomain",
    );
  },
);

Deno.test(
  "CloudflareWorkersConnector.verify reports ok on 200 subdomain",
  async () => {
    const { fetch: mockFetch, calls } = recordingFetch((call) => {
      if (call.method === "GET" && call.url.endsWith("/workers/subdomain")) {
        return subdomainEnvelope("teams");
      }
      return okEnvelope();
    });
    const connector = new CloudflareWorkersConnector({
      accountId: "acct-1",
      apiToken: "cf-token",
      fetch: mockFetch,
    });
    const res = await connector.verify({});
    assert.equal(res.ok, true);
    assert.equal(res.note, "credentials valid");
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /\/accounts\/acct-1\/workers\/subdomain$/);
  },
);

Deno.test(
  "CloudflareWorkersConnector.verify treats 404 subdomain as ok (creds valid)",
  async () => {
    const { fetch: mockFetch } = recordingFetch(() =>
      new Response("", { status: 404 })
    );
    const connector = new CloudflareWorkersConnector({
      accountId: "acct-no-sub",
      apiToken: "cf-token",
      fetch: mockFetch,
    });
    const res = await connector.verify({});
    assert.equal(res.ok, true);
  },
);

Deno.test(
  "CloudflareWorkersConnector.verify reports auth_failed on 401",
  async () => {
    const { fetch: mockFetch } = recordingFetch(() =>
      new Response("{}", { status: 401 })
    );
    const connector = new CloudflareWorkersConnector({
      accountId: "acct",
      apiToken: "bad-token",
      fetch: mockFetch,
    });
    const res = await connector.verify({});
    assert.equal(res.ok, false);
    assert.equal(res.code, "auth_failed");
  },
);

Deno.test(
  "CloudflareWorkersConnector caches the subdomain across calls",
  async () => {
    const fetcher = fakeFetcher(new Uint8Array([1]), []);
    let subdomainHits = 0;
    const { fetch: mockFetch } = recordingFetch((call) => {
      if (call.method === "GET" && call.url.endsWith("/workers/subdomain")) {
        subdomainHits += 1;
        return subdomainEnvelope("cache-team");
      }
      return okEnvelope();
    });
    const connector = new CloudflareWorkersConnector({
      accountId: "acct",
      apiToken: "tok",
      fetch: mockFetch,
    });

    await connector.apply({
      shape: "worker@v1",
      provider: "@takos/cloudflare-workers",
      resourceName: "fn",
      spec: {
        artifact: { kind: "js-bundle", hash: "sha256:abc" },
        compatibilityDate: "2025-01-01",
      },
    }, { fetcher });
    await connector.apply({
      shape: "worker@v1",
      provider: "@takos/cloudflare-workers",
      resourceName: "fn2",
      spec: {
        artifact: { kind: "js-bundle", hash: "sha256:def" },
        compatibilityDate: "2025-01-01",
      },
    }, { fetcher });

    assert.equal(subdomainHits, 1);
  },
);
