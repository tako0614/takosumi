import assert from "node:assert/strict";
import type { ArtifactFetcher } from "../../src/artifact_fetcher.ts";
import { DenoDeployWorkersConnector } from "../../src/connectors/deno_deploy/workers.ts";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test(
  "DenoDeployWorkersConnector.verify lists projects and reports ok on 200",
  async () => {
    const { fetch: mockFetch, calls } = recordingFetch(() =>
      jsonResponse([], 200)
    );
    const connector = new DenoDeployWorkersConnector({
      accessToken: "tok",
      organizationId: "org-1",
      fetch: mockFetch,
    });
    const res = await connector.verify({});
    assert.equal(res.ok, true);
    assert.equal(res.note, "credentials valid");
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /\/organizations\/org-1\/projects\?limit=1$/);
  },
);

Deno.test(
  "DenoDeployWorkersConnector.verify reports auth_failed on 401",
  async () => {
    const { fetch: mockFetch } = recordingFetch(() =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );
    const connector = new DenoDeployWorkersConnector({
      accessToken: "bad",
      organizationId: "org-1",
      fetch: mockFetch,
    });
    const res = await connector.verify({});
    assert.equal(res.ok, false);
    assert.equal(res.code, "auth_failed");
  },
);

Deno.test(
  "DenoDeployWorkersConnector.apply lists project, creates it when missing, then uploads bundle",
  async () => {
    const bundleBytes = new TextEncoder().encode(
      "export default { fetch() {} }",
    );
    const requestedHashes: string[] = [];
    const fetcher = fakeFetcher(bundleBytes, requestedHashes);
    const { fetch: mockFetch, calls } = recordingFetch((call) => {
      if (
        call.method === "GET" && call.url.includes("/organizations/") &&
        call.url.includes("/projects?")
      ) {
        // No existing project for this name.
        return jsonResponse([]);
      }
      if (call.method === "POST" && call.url.endsWith("/projects")) {
        return jsonResponse({ id: "proj-1", name: "fn" });
      }
      if (call.method === "POST" && call.url.endsWith("/deployments")) {
        return jsonResponse({ id: "dpl-001", projectId: "proj-1" });
      }
      return new Response("unhandled", { status: 500 });
    });
    const connector = new DenoDeployWorkersConnector({
      accessToken: "deno-token",
      organizationId: "org-1",
      fetch: mockFetch,
    });

    const result = await connector.apply({
      shape: "worker@v1",
      provider: "deno-deploy",
      resourceName: "fn",
      spec: {
        artifact: { kind: "js-bundle", hash: "sha256:abc" },
        compatibilityDate: "2025-01-01",
        env: { LOG_LEVEL: "info" },
      },
    }, { fetcher });

    assert.deepEqual(requestedHashes, ["sha256:abc"]);
    assert.equal(result.handle, "org-1/fn");
    assert.equal(result.outputs.url, "https://fn.deno.dev");
    assert.equal(result.outputs.scriptName, "fn");
    assert.equal(result.outputs.version, "dpl-001");
    // GET list, POST create project, POST deployment
    assert.equal(calls.length, 3);
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /\/organizations\/org-1\/projects\?name=fn/);
    assert.equal(calls[0].authorization, "Bearer deno-token");
    assert.equal(calls[1].method, "POST");
    assert.match(calls[1].url, /\/organizations\/org-1\/projects$/);
    assert.equal(calls[2].method, "POST");
    assert.match(calls[2].url, /\/projects\/proj-1\/deployments$/);
    assert.ok(calls[2].body, "expected multipart body for deployment");
    const metadata = calls[2].body!.get("metadata");
    assert.ok(metadata instanceof Blob);
    const metaJson = JSON.parse(await (metadata as Blob).text()) as {
      entryPointUrl: string;
      compatibilityDate: string;
      envVars: Record<string, string>;
    };
    assert.equal(metaJson.entryPointUrl, "worker.js");
    assert.equal(metaJson.compatibilityDate, "2025-01-01");
    assert.deepEqual(metaJson.envVars, { LOG_LEVEL: "info" });
    const modulePart = calls[2].body!.get("worker.js");
    assert.ok(modulePart instanceof Blob);
  },
);

Deno.test(
  "DenoDeployWorkersConnector.apply reuses existing project when found",
  async () => {
    const fetcher = fakeFetcher(new Uint8Array([1]), []);
    const { fetch: mockFetch, calls } = recordingFetch((call) => {
      if (call.method === "GET" && call.url.includes("/projects?")) {
        return jsonResponse([{ id: "existing-id", name: "fn" }]);
      }
      if (call.method === "POST" && call.url.endsWith("/deployments")) {
        return jsonResponse({ id: "dpl-002" });
      }
      return new Response("unhandled", { status: 500 });
    });
    const connector = new DenoDeployWorkersConnector({
      accessToken: "tok",
      organizationId: "org-1",
      fetch: mockFetch,
    });
    await connector.apply({
      shape: "worker@v1",
      provider: "deno-deploy",
      resourceName: "fn",
      spec: {
        artifact: { kind: "js-bundle", hash: "sha256:abc" },
        compatibilityDate: "2025-01-01",
      },
    }, { fetcher });
    // Should NOT have created a new project — only list + deployment.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[1].method, "POST");
    assert.match(calls[1].url, /\/projects\/existing-id\/deployments$/);
  },
);

Deno.test(
  "DenoDeployWorkersConnector.apply rejects when ctx.fetcher is undefined",
  async () => {
    const { fetch: mockFetch } = recordingFetch(() =>
      new Response("", { status: 200 })
    );
    const connector = new DenoDeployWorkersConnector({
      accessToken: "tok",
      fetch: mockFetch,
    });
    let threw = false;
    try {
      await connector.apply({
        shape: "worker@v1",
        provider: "deno-deploy",
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
    assert.ok(threw);
  },
);

Deno.test(
  "DenoDeployWorkersConnector.destroy deletes the project, treats missing as ok",
  async () => {
    const { fetch: mockFetch, calls } = recordingFetch((call) => {
      if (call.method === "GET" && call.url.includes("/projects?")) {
        // Simulate project exists for first delete, missing for second.
        if (calls.filter((c) => c.method === "GET").length === 1) {
          return jsonResponse([{ id: "proj-x", name: "fn" }]);
        }
        return jsonResponse([]);
      }
      if (call.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("unhandled", { status: 500 });
    });
    const connector = new DenoDeployWorkersConnector({
      accessToken: "tok",
      organizationId: "org",
      fetch: mockFetch,
    });
    const ok = await connector.destroy({
      shape: "worker@v1",
      provider: "deno-deploy",
      handle: "org/fn",
    }, {});
    assert.equal(ok.ok, true);
    assert.equal(ok.note, undefined);
    assert.equal(calls.at(-1)?.method, "DELETE");
    assert.match(calls.at(-1)!.url, /\/projects\/proj-x$/);

    const missing = await connector.destroy({
      shape: "worker@v1",
      provider: "deno-deploy",
      handle: "org/fn",
    }, {});
    assert.equal(missing.ok, true);
    assert.equal(missing.note, "project not found");
  },
);

Deno.test(
  "DenoDeployWorkersConnector.describe returns running with publicUrl, missing when project absent",
  async () => {
    let projectsExist = true;
    const { fetch: mockFetch } = recordingFetch((call) => {
      if (call.method === "GET" && call.url.includes("/projects?")) {
        return jsonResponse(
          projectsExist ? [{ id: "proj-1", name: "fn" }] : [],
        );
      }
      return new Response("unhandled", { status: 500 });
    });
    const connector = new DenoDeployWorkersConnector({
      accessToken: "tok",
      organizationId: "org",
      fetch: mockFetch,
    });
    const running = await connector.describe({
      shape: "worker@v1",
      provider: "deno-deploy",
      handle: "org/fn",
    }, {});
    assert.equal(running.status, "running");
    assert.equal(
      (running.outputs as { url?: string } | undefined)?.url,
      "https://fn.deno.dev",
    );

    projectsExist = false;
    const missing = await connector.describe({
      shape: "worker@v1",
      provider: "deno-deploy",
      handle: "org/fn",
    }, {});
    assert.equal(missing.status, "missing");
  },
);
