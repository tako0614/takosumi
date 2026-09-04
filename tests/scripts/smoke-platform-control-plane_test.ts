import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  CLOUDFLARE_PUBLIC_URL_PROPAGATION_TIMEOUT_MS,
  MAX_PUBLIC_URL_RESPONSE_BYTES,
  PLATFORM_CONTROL_PLANE_SMOKE_KIND,
  PUBLIC_URL_REQUEST_TIMEOUT_MS,
  assertInterfaceMaterialization,
  assertInterfacesRetired,
  assertSmokeSerializationSafe,
  assertConfiguredPublicUrls,
  capsuleFromLedgerResponse,
  canonicalRunEventSequenceFromActivity,
  defaultHelloWorkerInterfaceBlueprint,
  dryRunResult,
  failedResult,
  isSmokeProviderConnectionMatch,
  isSelectableCapsuleInstallConfig,
  interfaceMaterializationEvidence,
  main,
  resolveSmokeProviderBindingsFromCompatibility,
  resolveOptions,
  runPlatformControlPlaneSmoke,
  selectSmokeInstallConfigId,
  shouldMarkPendingSmokeCapsuleError,
  smokeGitInstallPlanBody,
  smokeGitInstallPlanProviderBindings,
  smokeSourceCompatibilityCheckBody,
  smokeCloudflareProviderConnectionMatch,
  smokeWorkspaceCloudflareConnectionBody,
  assertServiceIdentityResponse,
  fetchPinnedInterfaceBearerResource,
  fetchPinnedControlPlaneRequest,
  fetchBoundedCloudflareApi,
  fetchPublicUrlCheckWithRetry,
  probeServiceIdentity,
  publicCheckUrl,
  verifyInterfaceEndpointRetired,
  verifyConfiguredPublicUrlsDestroyed,
  verifyPublicWorkerUrlGone,
} from "../../scripts/smoke-platform-control-plane.ts";

test("platform smoke preserves the original pre-apply failure when a projected runtime URL is configured", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareConnectionMode: "guided",
      cloudflareAccountId: "acc_test",
      cloudflareWorkersSubdomain: "workers-subdomain",
      verificationMode: "cloudflare-worker",
      outputAllowlistJson: JSON.stringify({
        launch_url: { from: "launch_url", type: "url", required: true },
      }),
      runtimePublicUrlOutput: "launch_url",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );
  const startedAtMs = Date.now();
  const result = failedResult(options, {
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    workspaceId: "ws_test",
    completedSteps: ["sourceSynced"],
    stepTimings: [],
    runTimings: [],
    capsuleGateStatus: "not_reached",
    policyStatus: "not_reached",
    connectionRevoked: false,
    error: new Error("original source install failure"),
  });

  expect(result.status).toBe("failed");
  expect(result.workerUrl).toBe("");
  expect(result.error).toBe("original source install failure");
});

test("Cloudflare public URL verification allows bounded edge propagation", () => {
  expect(CLOUDFLARE_PUBLIC_URL_PROPAGATION_TIMEOUT_MS).toBe(180_000);
});

const PUBLIC_URL_CHECK_FIXTURE = {
  name: "health",
  output: "launch_url",
  path: "/healthz",
  expectedStatus: 200,
  bodyIncludes: ["ok"],
  destroyExpectation: { kind: "http-404" },
} as const;

const PUBLIC_DNS_ANSWER = [{ address: "93.184.216.34", family: 4 }] as const;
const resolvePublicDns = async () => PUBLIC_DNS_ANSWER;

type FixtureFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function pinnedControlPlaneFixture(fetcher: FixtureFetch) {
  return {
    controlPlaneResolver: resolvePublicDns,
    controlPlaneConnector: async (request: {
      readonly servername: string;
      readonly method: string;
      readonly path: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body?: Uint8Array;
      readonly signal: AbortSignal;
    }) => {
      const body = request.body === undefined
        ? undefined
        : request.headers["content-type"] === "application/json"
          ? new TextDecoder().decode(request.body)
          : request.body as unknown as BodyInit;
      return await fetcher(
        `https://${request.servername}${request.path}`,
        {
          method: request.method,
          headers: request.headers,
          ...(body === undefined ? {} : { body }),
          signal: request.signal,
          redirect: "error",
        },
      );
    },
  };
}

test("control-plane transport rejects unsafe resolution before exposing bearer or provider secrets", async () => {
  const bearer = "session-bearer-fixture";
  const cloudflareToken = "cloudflare-provider-token-fixture";
  for (const [hostname, answers] of [
    ["localtest.me", [{ address: "::1", family: 6 }]],
    ["control.selfhosted.dev", [{ address: "10.0.0.8", family: 4 }]],
    [
      "control.selfhosted.dev",
      [
        { address: "93.184.216.34", family: 4 },
        { address: "fd00::8", family: 6 },
      ],
    ],
    [
      "control.selfhosted.dev",
      [{ address: "::ffff:192.168.1.8", family: 6 }],
    ],
  ] as const) {
    const requests: unknown[] = [];
    await expect(
      fetchPinnedControlPlaneRequest(
        {
          baseUrl: `https://${hostname}`,
          token: bearer,
          method: "POST",
          path: "/api/v1/connections",
          body: { env: { CLOUDFLARE_API_TOKEN: cloudflareToken } },
        },
        {
          resolver: async () => answers,
          connector: async (request) => {
            requests.push(request);
            return Response.json({ ok: true });
          },
        },
      ),
    ).rejects.toThrow("non-public address");
    expect(requests).toHaveLength(0);
  }
});

test("control-plane DNS failures are fail-closed and redact resolver diagnostics", async () => {
  let connectorCalls = 0;
  let message = "";
  try {
    await fetchPinnedControlPlaneRequest(
      {
        baseUrl: "https://control.selfhosted.dev",
        token: "session-bearer-fixture",
        path: "/api/v1/workspaces",
      },
      {
        resolver: async () => {
          throw new Error("lookup leaked.private.internal EAI_AGAIN");
        },
        connector: async () => {
          connectorCalls += 1;
          return Response.json({ ok: true });
        },
      },
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("DNS resolution failed");
  expect(message).not.toContain("leaked.private.internal");
  expect(connectorCalls).toBe(0);

  await expect(
    fetchPinnedControlPlaneRequest(
      {
        baseUrl: "https://control.selfhosted.dev",
        token: "session-bearer-fixture",
        path: "/api/v1/workspaces",
        timeoutMs: 10,
      },
      {
        resolver: async () => await new Promise(() => {}),
        connector: async () => {
          connectorCalls += 1;
          return Response.json({ ok: true });
        },
      },
    ),
  ).rejects.toThrow("DNS resolution failed");
  expect(connectorCalls).toBe(0);
});

test("control-plane transport pins one deterministic address and preserves method, Host, SNI, bearer, and body", async () => {
  let resolverCalls = 0;
  const requests: Array<{
    readonly address: string;
    readonly family: number;
    readonly servername: string;
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: Uint8Array;
  }> = [];
  const result = await fetchPinnedControlPlaneRequest(
    {
      baseUrl: "https://Control.SelfHosted.dev",
      token: "session-bearer-fixture",
      method: "POST",
      path: "/api/v1/connections?mode=create",
      body: { env: { CLOUDFLARE_API_TOKEN: "provider-token-fixture" } },
    },
    {
      resolver: async () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? [
              { address: "2606:4700:4700::1111", family: 6 },
              { address: "93.184.216.35", family: 4 },
              { address: "93.184.216.34", family: 4 },
            ]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      connector: async (request) => {
        requests.push(request);
        return Response.json({ ok: true });
      },
    },
  );
  expect(result.response.status).toBe(200);
  expect(resolverCalls).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    address: "93.184.216.34",
    family: 4,
    servername: "control.selfhosted.dev",
    method: "POST",
    path: "/api/v1/connections?mode=create",
    headers: {
      accept: "application/json",
      authorization: "Bearer session-bearer-fixture",
      "content-type": "application/json",
      host: "control.selfhosted.dev",
    },
  });
  expect(JSON.parse(new TextDecoder().decode(requests[0]!.body))).toEqual({
    env: { CLOUDFLARE_API_TOKEN: "provider-token-fixture" },
  });
  expect(requests.some((request) => request.address === "127.0.0.1")).toBe(
    false,
  );
});

test("control-plane transport refuses redirects without replaying credentials", async () => {
  const requests: unknown[] = [];
  await expect(
    fetchPinnedControlPlaneRequest(
      {
        baseUrl: "https://control.selfhosted.dev",
        token: "session-bearer-fixture",
        path: "/api/v1/workspaces",
      },
      {
        resolver: resolvePublicDns,
        connector: async (request) => {
          requests.push(request);
          return new Response("redirect", {
            status: 302,
            headers: { location: "https://127.0.0.1/private" },
          });
        },
      },
    ),
  ).rejects.toThrow("rejected a redirect response");
  expect(requests).toHaveLength(1);
});

test("control-plane transport bounds request time and body bytes", async () => {
  let aborted = false;
  await expect(
    fetchPinnedControlPlaneRequest(
      {
        baseUrl: "https://control.selfhosted.dev",
        token: "session-bearer-fixture",
        path: "/api/v1/workspaces",
        timeoutMs: 10,
      },
      {
        resolver: resolvePublicDns,
        connector: async ({ signal }) =>
          await new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new DOMException("secret transport detail", "AbortError"));
              },
              { once: true },
            );
          }),
      },
    ),
  ).rejects.toThrow("did not return within 10ms");
  expect(aborted).toBe(true);

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_PUBLIC_URL_RESPONSE_BYTES));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    fetchPinnedControlPlaneRequest(
      {
        baseUrl: "https://control.selfhosted.dev",
        token: "session-bearer-fixture",
        path: "/api/v1/workspaces",
      },
      {
        resolver: resolvePublicDns,
        connector: async () => new Response(stream, { status: 200 }),
      },
    ),
  ).rejects.toThrow("response body exceeded the maximum size");
  expect(cancelled).toBe(true);

  let oversizedRequestCalls = 0;
  await expect(
    fetchPinnedControlPlaneRequest(
      {
        baseUrl: "https://control.selfhosted.dev",
        token: "session-bearer-fixture",
        path: "/api/v1/workspaces",
        method: "POST",
        binary: new Uint8Array(4 * 1024 * 1024 + 1),
      },
      {
        resolver: resolvePublicDns,
        connector: async () => {
          oversizedRequestCalls += 1;
          return new Response(null, { status: 204 });
        },
      },
    ),
  ).rejects.toThrow("request body is oversized");
  expect(oversizedRequestCalls).toBe(0);

});

test("control-plane transport cancels a late non-cooperative connector response", async () => {
  let resolveConnector: ((response: Response) => void) | undefined;
  const connection = new Promise<Response>((resolve) => {
    resolveConnector = resolve;
  });
  let observeCancellation: ((cancelled: boolean) => void) | undefined;
  const cancellation = new Promise<boolean>((resolve) => {
    observeCancellation = resolve;
  });
  const request = fetchPinnedControlPlaneRequest(
    {
      baseUrl: "https://control.selfhosted.dev",
      token: "session-bearer-fixture",
      path: "/api/v1/workspaces",
      timeoutMs: 10,
    },
    {
      resolver: resolvePublicDns,
      connector: async () => await connection,
    },
  );

  await expect(request).rejects.toThrow("did not return within 10ms");
  resolveConnector!(new Response(new ReadableStream<Uint8Array>({
    cancel() {
      observeCancellation!(true);
    },
  }), { status: 200 }));
  await expect(Promise.race([
    cancellation,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
  ])).resolves.toBe(true);
});

test("control-plane transport bounds a never-settling response read and cancel", async () => {
  let cancelStarted = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
    },
    cancel() {
      cancelStarted = true;
      return new Promise<void>(() => {});
    },
  });
  const request = fetchPinnedControlPlaneRequest(
    {
      baseUrl: "https://control.selfhosted.dev",
      token: "session-bearer-fixture",
      path: "/api/v1/workspaces",
      timeoutMs: 20,
    },
    {
      resolver: resolvePublicDns,
      connector: async () => new Response(stream, { status: 200 }),
    },
  );
  const outcome = await Promise.race([
    request.then(() => "resolved", (error) => error),
    new Promise<"test-deadline">((resolve) =>
      setTimeout(() => resolve("test-deadline"), 100)
    ),
  ]);

  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain("did not return within 20ms");
  expect(cancelStarted).toBe(true);
});

test("control-plane URL validation does not serialize userinfo", async () => {
  const secret = "userinfo-secret-fixture";
  let resolverCalls = 0;
  let connectorCalls = 0;
  let message = "";
  try {
    await fetchPinnedControlPlaneRequest(
      {
        baseUrl: `https://operator:${secret}@control.selfhosted.dev`,
        token: "session-bearer-fixture",
        path: "/api/v1/workspaces",
      },
      {
        resolver: async () => {
          resolverCalls += 1;
          return PUBLIC_DNS_ANSWER;
        },
        connector: async () => {
          connectorCalls += 1;
          return Response.json({ ok: true });
        },
      },
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("canonical public HTTPS origin");
  expect(message).not.toContain(secret);
  expect(resolverCalls).toBe(0);
  expect(connectorCalls).toBe(0);
});

test("service identity probe validates every DNS answer and pins the original authority", async () => {
  let connectorCalls = 0;
  await expect(probeServiceIdentity(
    {
      url: "https://control.selfhosted.dev",
      expectedServiceIdentity: {
        headerName: "x-release-revision",
        value: "release-fixture",
      },
    },
    {
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      connector: async () => {
        connectorCalls += 1;
        return new Response(null, { status: 200 });
      },
    },
  )).rejects.toThrow("resolved to a non-public address");
  expect(connectorCalls).toBe(0);

  let resolverCalls = 0;
  const requests: Array<{
    readonly address: string;
    readonly servername: string;
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
  }> = [];
  await expect(probeServiceIdentity(
    {
      url: "https://control.selfhosted.dev",
      expectedServiceIdentity: {
        headerName: "x-release-revision",
        value: "release-fixture",
      },
    },
    {
      resolver: async () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? [
              { address: "93.184.216.35", family: 4 },
              { address: "93.184.216.34", family: 4 },
            ]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      connector: async (request) => {
        requests.push(request);
        return new Response("identity response", {
          status: 200,
          headers: { "x-release-revision": "release-fixture" },
        });
      },
    },
  )).resolves.toBeUndefined();
  expect(resolverCalls).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    address: "93.184.216.34",
    servername: "control.selfhosted.dev",
    method: "GET",
    path: "/",
    headers: {
      accept: "text/html,application/json",
      host: "control.selfhosted.dev",
    },
  });
  expect(requests[0]!.headers.authorization).toBeUndefined();
});

test("Interface retirement accepts only explicit 404 and fails closed on transport ambiguity", async () => {
  const endpoint = "https://interface-runtime.takos.jp/";
  const retry = {
    maxAttempts: 2,
    requestTimeoutMs: 10,
    sleep: async () => {},
  } as const;
  let dnsAttempts = 0;
  await expect(verifyInterfaceEndpointRetired(endpoint, {
    ...retry,
    resolver: async () => {
      dnsAttempts += 1;
      throw new Error("private resolver detail");
    },
    connector: async () => new Response("gone", { status: 404 }),
  })).rejects.toThrow("retirement is inconclusive");
  expect(dnsAttempts).toBe(1);

  await expect(verifyInterfaceEndpointRetired(endpoint, {
    ...retry,
    resolver: resolvePublicDns,
    connector: async () => {
      throw new Error("TLS private certificate detail");
    },
  })).rejects.toThrow("retirement is inconclusive");

  let timeoutAborted = false;
  await expect(verifyInterfaceEndpointRetired(endpoint, {
    ...retry,
    resolver: resolvePublicDns,
    connector: async ({ signal }) => await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        timeoutAborted = true;
        reject(new DOMException("timed out", "AbortError"));
      }, { once: true });
    }),
  })).rejects.toThrow("retirement is inconclusive");
  expect(timeoutAborted).toBe(true);

  let oversizedCancelled = false;
  await expect(verifyInterfaceEndpointRetired(endpoint, {
    ...retry,
    resolver: resolvePublicDns,
    connector: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PUBLIC_URL_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        oversizedCancelled = true;
      },
    }), { status: 500 }),
  })).rejects.toThrow("retirement is inconclusive");
  expect(oversizedCancelled).toBe(true);

  for (const status of [200, 401, 410, 500]) {
    await expect(verifyInterfaceEndpointRetired(endpoint, {
      ...retry,
      resolver: resolvePublicDns,
      connector: async () => new Response("not a contract absence", { status }),
    })).rejects.toThrow("did not return contract 404");
  }
  await expect(verifyInterfaceEndpointRetired(endpoint, {
    ...retry,
    resolver: resolvePublicDns,
    connector: async () => new Response("gone", { status: 404 }),
  })).resolves.toBe(true);
});

test("Interface retirement retries only the original validated address", async () => {
  let resolverCalls = 0;
  const requests: Array<{ readonly address: string; readonly servername: string }> = [];
  await expect(verifyInterfaceEndpointRetired(
    "https://interface-runtime.takos.jp/",
    {
      maxAttempts: 2,
      requestTimeoutMs: 10,
      sleep: async () => {},
      resolver: async () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? [
              { address: "93.184.216.35", family: 4 },
              { address: "93.184.216.34", family: 4 },
            ]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      connector: async (request) => {
        requests.push(request);
        return new Response("gone", {
          status: requests.length === 1 ? 503 : 404,
        });
      },
    },
  )).resolves.toBe(true);
  expect(resolverCalls).toBe(1);
  expect(requests).toHaveLength(2);
  expect(requests.every((request) =>
    request.address === "93.184.216.34" &&
    request.servername === "interface-runtime.takos.jp"
  )).toBe(true);
});

test("Worker URL cleanup accepts only explicit 404 and fails closed on transport ambiguity", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareConnectionMode: "guided",
      cloudflareAccountId: "acc_test",
      cloudflareWorkersSubdomain: "workers-subdomain",
      verificationMode: "cloudflare-worker",
      outputAllowlistJson: JSON.stringify({
        launch_url: { from: "launch_url", type: "url", required: true },
      }),
      runtimePublicUrlOutput: "launch_url",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );
  const outputs = { launch_url: "https://worker-runtime.takos.jp" };
  const retry = {
    maxAttempts: 2,
    requestTimeoutMs: 10,
    sleep: async () => {},
  } as const;
  let dnsAttempts = 0;
  await expect(verifyPublicWorkerUrlGone(options, outputs, {
    ...retry,
    resolver: async () => {
      dnsAttempts += 1;
      throw new Error("private resolver detail");
    },
    connector: async () => new Response("gone", { status: 404 }),
  })).rejects.toThrow("retirement is inconclusive");
  expect(dnsAttempts).toBe(1);

  await expect(verifyPublicWorkerUrlGone(options, outputs, {
    ...retry,
    resolver: resolvePublicDns,
    connector: async () => {
      throw new Error("TLS private certificate detail");
    },
  })).rejects.toThrow("retirement is inconclusive");

  let timeoutAborted = false;
  await expect(verifyPublicWorkerUrlGone(options, outputs, {
    ...retry,
    resolver: resolvePublicDns,
    connector: async ({ signal }) => await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        timeoutAborted = true;
        reject(new DOMException("timed out", "AbortError"));
      }, { once: true });
    }),
  })).rejects.toThrow("retirement is inconclusive");
  expect(timeoutAborted).toBe(true);

  let oversizedCancelled = false;
  await expect(verifyPublicWorkerUrlGone(options, outputs, {
    ...retry,
    resolver: resolvePublicDns,
    connector: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PUBLIC_URL_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        oversizedCancelled = true;
      },
    }), { status: 500 }),
  })).rejects.toThrow("retirement is inconclusive");
  expect(oversizedCancelled).toBe(true);

  for (const status of [200, 401, 410, 500]) {
    await expect(verifyPublicWorkerUrlGone(options, outputs, {
      ...retry,
      resolver: resolvePublicDns,
      connector: async () => new Response("not a contract absence", { status }),
    })).rejects.toThrow("did not return contract 404");
  }
  await expect(verifyPublicWorkerUrlGone(options, outputs, {
    ...retry,
    resolver: resolvePublicDns,
    connector: async () => new Response("gone", { status: 404 }),
  })).resolves.toBeUndefined();
});

test("Worker URL cleanup retries only the original validated address", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareConnectionMode: "guided",
      cloudflareAccountId: "acc_test",
      cloudflareWorkersSubdomain: "workers-subdomain",
      verificationMode: "cloudflare-worker",
      outputAllowlistJson: JSON.stringify({
        launch_url: { from: "launch_url", type: "url", required: true },
      }),
      runtimePublicUrlOutput: "launch_url",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );
  let resolverCalls = 0;
  const requests: Array<{ readonly address: string; readonly servername: string }> = [];
  await expect(verifyPublicWorkerUrlGone(
    options,
    { launch_url: "https://worker-runtime.takos.jp" },
    {
      maxAttempts: 2,
      requestTimeoutMs: 10,
      sleep: async () => {},
      resolver: async () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? [
              { address: "93.184.216.35", family: 4 },
              { address: "93.184.216.34", family: 4 },
            ]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      connector: async (request) => {
        requests.push(request);
        return new Response("gone", {
          status: requests.length === 1 ? 503 : 404,
        });
      },
    },
  )).resolves.toBeUndefined();
  expect(resolverCalls).toBe(1);
  expect(requests).toHaveLength(2);
  expect(requests.every((request) =>
    request.address === "93.184.216.34" &&
    request.servername === "worker-runtime.takos.jp"
  )).toBe(true);
});

test("fixed Cloudflare API transport rejects redirects and never replays its bearer", async () => {
  const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  await expect(
    fetchBoundedCloudflareApi(
      "/client/v4/accounts/account-fixture/workers/scripts",
      "cloudflare-api-token-fixture",
      {
        fetcher: async (input, init) => {
          requests.push({ url: String(input), init });
          return new Response("redirect", {
            status: 302,
            headers: { location: "https://127.0.0.1/private" },
          });
        },
      },
    ),
  ).rejects.toThrow("rejected a redirect response");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(
    "https://api.cloudflare.com/client/v4/accounts/account-fixture/workers/scripts",
  );
  expect(requests[0]?.init?.redirect).toBe("error");
  expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
    "Bearer cloudflare-api-token-fixture",
  );
});

test("fixed Cloudflare API transport aborts stalls and cancels oversized bodies", async () => {
  let aborted = false;
  await expect(
    fetchBoundedCloudflareApi(
      "/client/v4/accounts/account-fixture/workers/scripts",
      "cloudflare-api-token-fixture",
      {
        timeoutMs: 10,
        fetcher: async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("credential-bearing transport stalled"));
              },
              { once: true },
            );
          }),
      },
    ),
  ).rejects.toThrow("request timed out");
  expect(aborted).toBe(true);

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_PUBLIC_URL_RESPONSE_BYTES));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    fetchBoundedCloudflareApi(
      "/client/v4/accounts/account-fixture/workers/scripts",
      "cloudflare-api-token-fixture",
      {
        fetcher: async () => new Response(stream, { status: 200 }),
      },
    ),
  ).rejects.toThrow("response body exceeded the maximum size");
  expect(cancelled).toBe(true);

  let unusedBodyCancelled = false;
  const unusedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("unused Worker body"));
    },
    cancel() {
      unusedBodyCancelled = true;
    },
  });
  const scriptReadback = await fetchBoundedCloudflareApi(
    "/client/v4/accounts/account-fixture/workers/scripts/worker-fixture",
    "cloudflare-api-token-fixture",
    {
      readBody: false,
      fetcher: async () => new Response(unusedBody, { status: 200 }),
    },
  );
  expect(scriptReadback.body).toBe("");
  expect(unusedBodyCancelled).toBe(true);
});

test("fixed Cloudflare transport cancels a late non-cooperative fetch response", async () => {
  let resolveFetcher: ((response: Response) => void) | undefined;
  const fetchResult = new Promise<Response>((resolve) => {
    resolveFetcher = resolve;
  });
  let observeCancellation: ((cancelled: boolean) => void) | undefined;
  const cancellation = new Promise<boolean>((resolve) => {
    observeCancellation = resolve;
  });
  const request = fetchBoundedCloudflareApi(
    "/client/v4/accounts/account-fixture/workers/scripts",
    "cloudflare-api-token-fixture",
    {
      timeoutMs: 10,
      fetcher: async () => await fetchResult,
    },
  );

  await expect(request).rejects.toThrow("request timed out");
  resolveFetcher!(new Response(new ReadableStream<Uint8Array>({
    cancel() {
      observeCancellation!(true);
    },
  }), { status: 200 }));
  await expect(Promise.race([
    cancellation,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
  ])).resolves.toBe(true);
});

test("fixed Cloudflare transport does not wait for a never-settling body cancel", async () => {
  let cancelStarted = false;
  const response = {
    status: 200,
    headers: new Headers(),
    body: {
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => {});
      },
    },
  } as unknown as Response;
  const request = fetchBoundedCloudflareApi(
    "/client/v4/accounts/account-fixture/workers/scripts/worker-fixture",
    "cloudflare-api-token-fixture",
    {
      readBody: false,
      timeoutMs: 20,
      fetcher: async () => response,
    },
  );
  const outcome = await Promise.race([
    request,
    new Promise<"test-deadline">((resolve) =>
      setTimeout(() => resolve("test-deadline"), 100)
    ),
  ]);

  expect(outcome).not.toBe("test-deadline");
  expect((outcome as { readonly body: string }).body).toBe("");
  expect(cancelStarted).toBe(true);
});

test("fixed Cloudflare transport bounds a never-settling read and cancel", async () => {
  let cancelStarted = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
    },
    cancel() {
      cancelStarted = true;
      return new Promise<void>(() => {});
    },
  });
  const request = fetchBoundedCloudflareApi(
    "/client/v4/accounts/account-fixture/workers/scripts",
    "cloudflare-api-token-fixture",
    {
      timeoutMs: 20,
      fetcher: async () => new Response(stream, { status: 200 }),
    },
  );
  const outcome = await Promise.race([
    request.then(() => "resolved", (error) => error),
    new Promise<"test-deadline">((resolve) =>
      setTimeout(() => resolve("test-deadline"), 100)
    ),
  ]);

  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain("request timed out");
  expect(cancelStarted).toBe(true);
});

test("Cloudflare transport failure reaches the normal redacted smoke finalization", async () => {
  const cloudflareToken = "cloudflare-finalization-secret-fixture";
  const options = await resolveOptions(
    {
      url: "https://control.selfhosted.dev",
      workspace: "ws_test",
      cloudflareConnectionMode: "none",
      cloudflareResourcePreflight: "workers",
      cloudflareAccountId: "account-fixture",
      cloudflareWorkersSubdomain: "workers-fixture",
      verificationMode: "opentofu",
      noInterfaceProof: true,
      sourceGitUrl: "https://git.selfhosted.dev/takosumi/smoke.git",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-finalization-secret-fixture",
      CLOUDFLARE_API_TOKEN: cloudflareToken,
    },
  );
  const originalFetch = globalThis.fetch;
  let cloudflareCalls = 0;
  let cleanupCalls = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "control.selfhosted.dev") {
      cleanupCalls += 1;
      return Response.json({ capsules: [] });
    }
    cloudflareCalls += 1;
    return new Response("redirected secret response", {
      status: 302,
      headers: { location: "https://127.0.0.1/private" },
    });
  }) as typeof fetch;
  try {
    const result = await runPlatformControlPlaneSmoke(
      options,
      pinnedControlPlaneFixture(async (input, init) =>
        await globalThis.fetch(input, init)
      ),
    );
    expect(result.status).toBe("failed");
    expect(result.completedSteps).not.toContain("cloudflareResourcePreflight");
    expect(result.capsuleId).toBeUndefined();
    expect(result.error).toContain("Cloudflare API rejected a redirect response");
    expect(result.error).not.toContain(cloudflareToken);
    expect(result.nextAction).toContain("Update the operator Cloudflare API token");
    expect(cloudflareCalls).toBe(1);
    expect(cleanupCalls).toBe(1);
    expect(() => assertSmokeSerializationSafe(result, options)).not.toThrow();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public URL checks require a canonical HTTPS origin with a public hostname", () => {
  expect(publicCheckUrl("https://Public.Takos.JP", PUBLIC_URL_CHECK_FIXTURE)).toBe(
    "https://public.takos.jp/healthz",
  );
  for (const value of [
    "http://public.takos.jp",
    "https://public.takos.jp:443",
    "https://user:pass@public.takos.jp",
    "https://public.takos.jp/base",
    "https://public.takos.jp?token=secret",
    "https://public.takos.jp/#fragment",
    "https://127.0.0.1",
    "https://[::1]",
    "https://service.corp",
    "https://service.lan",
    "https://service.example",
    "https://service.onion",
    "https://service.home",
    "https://single-label",
  ]) {
    expect(() => publicCheckUrl(value, PUBLIC_URL_CHECK_FIXTURE)).toThrow();
  }
  expect(() => publicCheckUrl(
    "https://public.takos.jp",
    { ...PUBLIC_URL_CHECK_FIXTURE, path: "/health?token=secret" },
  )).toThrow("path is invalid");
});

test("public URL checks reject redirects without following them", async () => {
  await expect(fetchPublicUrlCheckWithRetry(
    "https://public.takos.jp/healthz",
    PUBLIC_URL_CHECK_FIXTURE,
    {
      maxAttempts: 1,
      sleep: async () => undefined,
      resolver: resolvePublicDns,
      connector: async () => new Response("redirect", {
        status: 302,
        headers: { location: "https://other.takos.jp/secret" },
      }),
    },
  )).rejects.toThrow("rejected a redirect response");
});

test("public URL checks abort stalled requests at the bounded deadline", async () => {
  let aborted = false;
  await expect(fetchPublicUrlCheckWithRetry(
    "https://public.takos.jp/healthz",
    PUBLIC_URL_CHECK_FIXTURE,
    {
      maxAttempts: 1,
      requestTimeoutMs: 10,
      sleep: async () => undefined,
      resolver: resolvePublicDns,
      connector: async ({ signal }) => await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }),
    },
  )).rejects.toThrow("timed out");
  expect(aborted).toBe(true);
});

test("public URL checks cancel a late non-cooperative connector response", async () => {
  let resolveConnector: ((response: Response) => void) | undefined;
  const connection = new Promise<Response>((resolve) => {
    resolveConnector = resolve;
  });
  let observeCancellation: ((cancelled: boolean) => void) | undefined;
  const cancellation = new Promise<boolean>((resolve) => {
    observeCancellation = resolve;
  });
  const request = fetchPublicUrlCheckWithRetry(
    "https://public.takos.jp/healthz",
    PUBLIC_URL_CHECK_FIXTURE,
    {
      maxAttempts: 1,
      requestTimeoutMs: 10,
      resolver: resolvePublicDns,
      connector: async () => await connection,
    },
  );

  await expect(request).rejects.toThrow("timed out");
  resolveConnector!(new Response(new ReadableStream<Uint8Array>({
    cancel() {
      observeCancellation!(true);
    },
  }), { status: 200 }));
  await expect(Promise.race([
    cancellation,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
  ])).resolves.toBe(true);
});

test("public URL retry uses one deadline even when retry sleep never settles", async () => {
  const request = fetchPublicUrlCheckWithRetry(
    "https://public.takos.jp/healthz",
    PUBLIC_URL_CHECK_FIXTURE,
    {
      maxAttempts: 4,
      requestTimeoutMs: 10,
      resolver: resolvePublicDns,
      connector: async () => new Response("not ready", { status: 503 }),
      sleep: async () => await new Promise<void>(() => {}),
    },
  );
  const outcome = await Promise.race([
    request.then(() => "resolved", (error) => error),
    new Promise<"test-deadline">((resolve) =>
      setTimeout(() => resolve("test-deadline"), 100)
    ),
  ]);

  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain("timed out");
});

test("public URL DNS and connection share one absolute deadline", async () => {
  const request = fetchPublicUrlCheckWithRetry(
    "https://public.takos.jp/healthz",
    PUBLIC_URL_CHECK_FIXTURE,
    {
      maxAttempts: 1,
      requestTimeoutMs: 70,
      resolver: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 60));
        return PUBLIC_DNS_ANSWER;
      },
      connector: async () => await new Promise<Response>(() => {}),
    },
  );
  const outcome = await Promise.race([
    request.then(() => "resolved", (error) => error),
    new Promise<"test-deadline">((resolve) =>
      setTimeout(() => resolve("test-deadline"), 110)
    ),
  ]);

  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain("timed out");
});

test("public URL checks cancel a response stream that stalls while reading", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("ok"));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(fetchPublicUrlCheckWithRetry(
    "https://public.takos.jp/healthz",
    PUBLIC_URL_CHECK_FIXTURE,
    {
      maxAttempts: 1,
      requestTimeoutMs: 10,
      sleep: async () => undefined,
      resolver: resolvePublicDns,
      connector: async () => new Response(stream, { status: 200 }),
    },
  )).rejects.toThrow("timed out");
  expect(cancelled).toBe(true);
});

test("public URL checks bound a never-settling response read and cancel", async () => {
  let cancelStarted = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
    },
    cancel() {
      cancelStarted = true;
      return new Promise<void>(() => {});
    },
  });
  const request = fetchPublicUrlCheckWithRetry(
    "https://public.takos.jp/healthz",
    PUBLIC_URL_CHECK_FIXTURE,
    {
      maxAttempts: 1,
      requestTimeoutMs: 20,
      resolver: resolvePublicDns,
      connector: async () => new Response(stream, { status: 200 }),
    },
  );
  const outcome = await Promise.race([
    request.then(() => "resolved", (error) => error),
    new Promise<"test-deadline">((resolve) =>
      setTimeout(() => resolve("test-deadline"), 100)
    ),
  ]);

  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain("timed out");
  expect(cancelStarted).toBe(true);
});

test("public URL checks cancel an oversized streamed response before retaining it", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_PUBLIC_URL_RESPONSE_BYTES));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(fetchPublicUrlCheckWithRetry(
    "https://public.takos.jp/healthz",
    PUBLIC_URL_CHECK_FIXTURE,
    {
      maxAttempts: 1,
      sleep: async () => undefined,
      resolver: resolvePublicDns,
      connector: async () => new Response(stream, { status: 200 }),
    },
  )).rejects.toThrow("response body exceeded the maximum size");
  expect(cancelled).toBe(true);
});

test("public URL origin validation runs before the first network request", async () => {
  let calls = 0;
  await expect(assertConfiguredPublicUrls(
    { publicUrlChecks: [PUBLIC_URL_CHECK_FIXTURE] } as never,
    { launch_url: "https://service.corp" },
    {
      resolver: async () => {
        calls += 1;
        return PUBLIC_DNS_ANSWER;
      },
      connector: async () => new Response("ok", { status: 200 }),
    },
  )).rejects.toThrow("public non-reserved HTTPS hostname");
  expect(calls).toBe(0);
});

test("configured public URL checks share one authority pin for the same output origin", async () => {
  let resolverCalls = 0;
  const requests: Array<{
    readonly address: string;
    readonly servername: string;
    readonly path: string;
  }> = [];
  const checks = [
    PUBLIC_URL_CHECK_FIXTURE,
    {
      ...PUBLIC_URL_CHECK_FIXTURE,
      name: "ready",
      path: "/readyz",
    },
  ] as const;
  const results = await assertConfiguredPublicUrls(
    { publicUrlChecks: checks } as never,
    { launch_url: "https://public.takos.jp" },
    {
      maxAttempts: 1,
      resolver: async () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? [
              { address: "93.184.216.35", family: 4 as const },
              { address: "93.184.216.34", family: 4 as const },
            ]
          : [
              { address: "93.184.216.37", family: 4 as const },
              { address: "93.184.216.36", family: 4 as const },
            ];
      },
      connector: async (request) => {
        requests.push(request);
        return new Response("ok", { status: 200 });
      },
    },
  );

  expect(results).toHaveLength(2);
  expect(resolverCalls).toBe(1);
  expect(requests.map((request) => request.path)).toEqual([
    "/healthz",
    "/readyz",
  ]);
  expect(requests.every((request) =>
    request.address === "93.184.216.34" &&
    request.servername === "public.takos.jp"
  )).toBe(true);
});

test("configured public URL absence reuses the exact Apply-side authority pin", async () => {
  let resolverCalls = 0;
  let destroyed = false;
  const requests: Array<{
    readonly address: string;
    readonly servername: string;
    readonly path: string;
  }> = [];
  const dependencies = {
    maxAttempts: 1,
    sleep: async () => {},
    resolver: async () => {
      resolverCalls += 1;
      return resolverCalls === 1
        ? [
            { address: "93.184.216.35", family: 4 as const },
            { address: "93.184.216.34", family: 4 as const },
          ]
        : [
            { address: "93.184.216.37", family: 4 as const },
            { address: "93.184.216.36", family: 4 as const },
          ];
    },
    connector: async (request: typeof requests[number] & { readonly signal: AbortSignal }) => {
      requests.push(request);
      return new Response(destroyed ? "gone" : "ok", {
        status: destroyed ? 404 : 200,
      });
    },
  } as const;
  const applied = await assertConfiguredPublicUrls(
    { publicUrlChecks: [PUBLIC_URL_CHECK_FIXTURE] } as never,
    { launch_url: "https://public.takos.jp" },
    dependencies,
  );
  destroyed = true;
  const absent = await verifyConfiguredPublicUrlsDestroyed(
    applied,
    dependencies,
  );

  expect(absent).toEqual([
    {
      name: "health",
      output: "launch_url",
      url: "https://public.takos.jp/healthz",
      expectation: { kind: "http-404" },
      applyStatus: "passed",
      status: "passed",
      observedStatus: 404,
    },
  ]);
  expect(resolverCalls).toBe(1);
  expect(requests).toHaveLength(2);
  expect(requests.every((request) =>
    request.address === "93.184.216.34" &&
    request.servername === "public.takos.jp" &&
    request.path === "/healthz"
  )).toBe(true);
});

test("public URL checks reject localtest.me and every non-global DNS answer before connecting", async () => {
  const cases = [
    ["localtest.me", [{ address: "::1", family: 6 }]],
    ["public.takos.jp", [{ address: "10.0.0.8", family: 4 }]],
    ["public.takos.jp", [{ address: "169.254.10.8", family: 4 }]],
    ["public.takos.jp", [{ address: "192.0.2.8", family: 4 }]],
    ["public.takos.jp", [{ address: "224.0.0.8", family: 4 }]],
    ["public.takos.jp", [{ address: "240.0.0.8", family: 4 }]],
    ["public.takos.jp", [{ address: "fc00::8", family: 6 }]],
    ["public.takos.jp", [{ address: "fe80::8", family: 6 }]],
    ["public.takos.jp", [{ address: "ff02::8", family: 6 }]],
    ["public.takos.jp", [{ address: "2001:db8::8", family: 6 }]],
    ["public.takos.jp", [{ address: "2410::8", family: 6 }]],
    ["public.takos.jp", [{ address: "3000::8", family: 6 }]],
    ["public.takos.jp", [{ address: "::ffff:10.0.0.8", family: 6 }]],
  ] as const;
  for (const [hostname, answers] of cases) {
    let connectorCalls = 0;
    await expect(fetchPublicUrlCheckWithRetry(
      `https://${hostname}/healthz`,
      PUBLIC_URL_CHECK_FIXTURE,
      {
        maxAttempts: 1,
        resolver: async () => answers,
        connector: async () => {
          connectorCalls += 1;
          return new Response("ok", { status: 200 });
        },
      },
    )).rejects.toThrow("non-public address");
    expect(connectorCalls).toBe(0);
  }
});

test("public URL checks reject mixed public and private DNS answers", async () => {
  let connectorCalls = 0;
  await expect(fetchPublicUrlCheckWithRetry(
    "https://public.takos.jp/healthz",
    PUBLIC_URL_CHECK_FIXTURE,
    {
      maxAttempts: 1,
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "192.168.1.9", family: 4 },
      ],
      connector: async () => {
        connectorCalls += 1;
        return new Response("ok", { status: 200 });
      },
    },
  )).rejects.toThrow("non-public address");
  expect(connectorCalls).toBe(0);
});

test("public URL checks resolve once and connect only to the deterministic pinned answer with original SNI and Host", async () => {
  let resolverCalls = 0;
  const requests: Array<{
    readonly address: string;
    readonly family: number;
    readonly servername: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly path: string;
    readonly signal: AbortSignal;
  }> = [];
  const result = await fetchPublicUrlCheckWithRetry(
    "https://public.takos.jp/healthz",
    PUBLIC_URL_CHECK_FIXTURE,
    {
      maxAttempts: 1,
      resolver: async () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? [
              { address: "2606:4700:4700::1111", family: 6 },
              { address: "93.184.216.35", family: 4 },
              { address: "93.184.216.34", family: 4 },
            ]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      connector: async (request) => {
        requests.push(request);
        return new Response("ok", { status: 200 });
      },
    },
  );
  expect(result.response.status).toBe(200);
  expect(resolverCalls).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    address: "93.184.216.34",
    family: 4,
    servername: "public.takos.jp",
    headers: {
      accept: "text/html,*/*",
      host: "public.takos.jp",
    },
    path: "/healthz",
  });
  expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
});

test("public URL DNS errors are fail-closed and redact resolver diagnostics", async () => {
  let connectorCalls = 0;
  const promise = fetchPublicUrlCheckWithRetry(
    "https://public.takos.jp/healthz",
    PUBLIC_URL_CHECK_FIXTURE,
    {
      maxAttempts: 1,
      resolver: async () => {
        throw new Error("lookup leaked.private.internal EAI_AGAIN");
      },
      connector: async () => {
        connectorCalls += 1;
        return new Response("ok", { status: 200 });
      },
    },
  );
  await expect(promise).rejects.toThrow("DNS resolution failed");
  await expect(promise).rejects.not.toThrow("leaked.private.internal");
  expect(connectorCalls).toBe(0);
});

test("Interface bearer transport validates every DNS answer before exposing Authorization", async () => {
  const bearer = "issued-interface-bearer";
  for (const answers of [
    [{ address: "10.0.0.8", family: 4 }],
    [
      { address: "93.184.216.34", family: 4 },
      { address: "fd00::8", family: 6 },
    ],
    [{ address: "::ffff:192.168.1.8", family: 6 }],
  ] as const) {
    const requests: unknown[] = [];
    await expect(fetchPinnedInterfaceBearerResource(
      "https://oauth-resource.takos.jp/mcp",
      bearer,
      {
        resolver: async () => answers,
        connector: async (request) => {
          requests.push(request);
          return Response.json({ ok: true });
        },
      },
    )).rejects.toThrow("non-public address");
    expect(requests).toHaveLength(0);
  }
});

test("Interface bearer transport pins one validated answer across a rebinding attempt", async () => {
  const bearer = "issued-interface-bearer";
  let resolverCalls = 0;
  const requests: Array<{
    readonly address: string;
    readonly family: number;
    readonly servername: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly path: string;
  }> = [];
  const result = await fetchPinnedInterfaceBearerResource(
    "https://oauth-resource.takos.jp/mcp",
    bearer,
    {
      resolver: async () => {
        resolverCalls += 1;
        return resolverCalls === 1
          ? [
              { address: "2606:4700:4700::1111", family: 6 },
              { address: "93.184.216.35", family: 4 },
              { address: "93.184.216.34", family: 4 },
            ]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      connector: async (request) => {
        requests.push(request);
        return Response.json({ ok: true });
      },
    },
  );
  expect(result.response.status).toBe(200);
  expect(resolverCalls).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    address: "93.184.216.34",
    family: 4,
    servername: "oauth-resource.takos.jp",
    path: "/mcp",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
      host: "oauth-resource.takos.jp",
    },
  });
  expect(requests.some((request) => request.address === "127.0.0.1")).toBe(false);
});

test("Interface bearer transport refuses redirects without replaying the bearer", async () => {
  const requests: unknown[] = [];
  await expect(fetchPinnedInterfaceBearerResource(
    "https://oauth-resource.takos.jp/mcp",
    "issued-interface-bearer",
    {
      resolver: resolvePublicDns,
      connector: async (request) => {
        requests.push(request);
        return new Response("redirect", {
          status: 302,
          headers: { location: "https://127.0.0.1/private" },
        });
      },
    },
  )).rejects.toThrow("rejected a redirect response");
  expect(requests).toHaveLength(1);
});

test("platform smoke materializes and retires the Plan-pinned Interface through public routes", async () => {
  const options = await resolveOptions(
    {
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      appName: "takosumi-interface-fixture",
      sourceGitUrl: "https://git.example.test/interface-fixture.git",
      cloudflareConnectionMode: "guided",
      verificationMode: "cloudflare-worker",
      cloudflareAccountId: "acc_test",
      cloudflareWorkersSubdomain: "workers.example.test",
      deployTimeoutSeconds: "1",
      pollIntervalMs: "1",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-secret-fixture",
      CLOUDFLARE_API_TOKEN: "cloudflare-secret-fixture",
    },
  );
  const blueprint = options.interfaceBlueprints?.[0];
  expect(blueprint).toBeDefined();
  const outputDigest = `sha256:${"a".repeat(64)}`;
  const workerUrl = "https://worker.takos.jp";
  const iface = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "Interface",
    metadata: {
      id: "if_fixture",
      workspaceId: "ws_test",
      name: blueprint!.name,
      ownerRef: { kind: "Capsule", id: "cap_fixture" },
      generation: 1,
      materializedFrom: { source: "capsule_blueprint", key: blueprint!.key },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    spec: {
      ...blueprint!.spec,
      inputs: {
        endpoint: {
          source: "capsule_output",
          capsuleId: "cap_fixture",
          outputName: "url",
        },
      },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 1,
      resolvedRevision: 1,
      resolvedInputs: { endpoint: workerUrl },
      resourceUri: `${workerUrl}/`,
      provenance: {
        endpoint: {
          source: "capsule_output",
          runId: "run_apply",
          stateVersionId: "state_fixture",
          outputId: "out_fixture",
          outputDigest,
          outputName: "url",
        },
      },
    },
  } as const;
  const binding = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "InterfaceBinding",
    metadata: {
      id: "ib_fixture",
      workspaceId: "ws_test",
      generation: 1,
      materializedFrom: {
        source: "capsule_blueprint",
        interfaceKey: blueprint!.key,
        key: blueprint!.bindings![0]!.key,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    spec: {
      interfaceId: "if_fixture",
      subjectRef: { kind: "Principal", id: "principal_fixture" },
      permissions: ["mcp.invoke"],
      delivery: { type: "none" },
    },
    status: {
      phase: "Ready",
      observedInterfaceRevision: 1,
    },
  } as const;
  const ledger = {
    capsuleStatus: "active",
    stateVersionId: "state_fixture",
    generation: 3,
    applyRunId: "run_apply",
    outputId: "out_fixture",
    outputDigest,
    publicOutputNames: ["url"],
    publicOutputDigest: `sha256:${"b".repeat(64)}`,
    publicOutputs: { url: workerUrl },
  } as const;
  const originalFetch = globalThis.fetch;
  let retired = false;
  let retirementTransportUnavailable = false;
  let publicResolverCalls = 0;
  const publicProbeRequests: Array<{
    readonly address: string;
    readonly servername: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly path: string;
  }> = [];
  const publicProbeDependencies = {
    ...pinnedControlPlaneFixture(
      async (input, init) => await globalThis.fetch(input, init),
    ),
    resolver: async () => {
      publicResolverCalls += 1;
      return publicResolverCalls === 1
        ? [
            { address: "93.184.216.35", family: 4 as const },
            { address: "93.184.216.34", family: 4 as const },
          ]
        : [
            { address: "93.184.216.37", family: 4 as const },
            { address: "93.184.216.36", family: 4 as const },
          ];
    },
    connector: async (request: typeof publicProbeRequests[number] & { readonly signal: AbortSignal }) => {
      publicProbeRequests.push(request);
      if (retired && retirementTransportUnavailable) {
        throw new Error("retirement transport unavailable");
      }
      return retired ? new Response("gone", { status: 404 }) : Response.json({ ok: true });
    },
    maxAttempts: 1,
  };
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/interfaces") {
      return Response.json({ interfaces: [retired ? { ...iface, status: { ...iface.status, phase: "Retired" } } : iface] });
    }
    if (url.pathname === "/api/v1/interfaces/if_fixture") {
      return Response.json(retired ? { ...iface, status: { ...iface.status, phase: "Retired" } } : iface);
    }
    if (url.pathname === "/api/v1/interfaces/if_fixture/bindings") {
      return Response.json({ bindings: [retired ? { ...binding, status: { ...binding.status, phase: "Revoked" } } : binding] });
    }
    if (url.pathname === "/api/v1/interfaces/if_fixture/bindings/ib_fixture") {
      return Response.json(retired ? { ...binding, status: { ...binding.status, phase: "Revoked" } } : binding);
    }
    throw new Error(`unexpected Interface fixture request: ${url}`);
  }) as typeof fetch;
  try {
    const context = await assertInterfaceMaterialization(options, {
      workspaceId: "ws_test",
      capsuleId: "cap_fixture",
      stateVersionLedger: ledger,
    }, publicProbeDependencies);
    expect(context.records).toHaveLength(1);
    expect(context.records[0]!.interface.metadata.id).toBe("if_fixture");
    expect(context.records[0]!.bindings[0]!.metadata.id).toBe("ib_fixture");
    retired = true;
    retirementTransportUnavailable = true;
    await expect(assertInterfacesRetired(
      options,
      context,
      publicProbeDependencies,
    )).rejects.toThrow("retirement is inconclusive");
    retirementTransportUnavailable = false;
    const retiredContext = await assertInterfacesRetired(
      options,
      context,
      publicProbeDependencies,
    );
    expect(retiredContext.records[0]!.interface.status.phase).toBe("Retired");
    expect(retiredContext.records[0]!.bindings[0]!.status.phase).toBe("Revoked");
    expect(publicResolverCalls).toBe(1);
    expect(publicProbeRequests).toHaveLength(3);
    expect(publicProbeRequests.every((request) =>
      request.address === "93.184.216.34" &&
      request.servername === "worker.takos.jp" &&
      request.headers.host === "worker.takos.jp" &&
      request.path === "/"
    )).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("platform smoke canonical Run events are redacted to ids and outcomes", () => {
  const sequence = canonicalRunEventSequenceFromActivity(
    [
      { id: "evt_plan", action: "run.plan_created", targetType: "run", targetId: "plan", runId: "plan", metadata: { capsuleId: "cap", operation: "plan", authorization: "Bearer secret" } },
      { id: "evt_apply", action: "run.applied", targetType: "run", targetId: "apply", runId: "apply", metadata: { capsuleId: "cap", stateVersionId: "state" } },
      { id: "evt_destroy_plan", action: "run.plan_created", targetType: "run", targetId: "destroy-plan", runId: "destroy-plan", metadata: { capsuleId: "cap", operation: "destroy" } },
      { id: "evt_destroy", action: "run.destroyed", targetType: "run", targetId: "destroy", runId: "destroy", metadata: { capsuleId: "cap" } },
    ],
    { capsuleId: "cap", planRunId: "plan", applyRunId: "apply", destroyPlanRunId: "destroy-plan", destroyApplyRunId: "destroy" },
  );
  expect(sequence?.plan.outcome).toBe("planned");
  expect(sequence?.apply.outcome).toBe("applied");
  expect(sequence?.destroyApply.outcome).toBe("destroyed");
  expect(JSON.stringify(sequence)).not.toContain("authorization");
  expect(() => assertSmokeSerializationSafe({ authorization: "Bearer secret-fixture" })).toThrow();
});

test("platform smoke optionally proves an OAuth Interface grant and post-destroy denial", async () => {
  const runtimeToken = "runtime-secret-fixture";
  const issuedToken = "issued-interface-secret-fixture";
  const optionsFromFile = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      appName: "takosumi-interface-oauth-fixture",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      interfaceBlueprintsJson: JSON.stringify([
        {
          key: "oauth-service",
          name: "oauth-service",
          spec: {
            type: "mcp.server",
            version: "2025-11-25",
            document: { transport: "streamable-http" },
            inputs: {
              endpoint: { source: "capsule_output", outputName: "url" },
            },
            access: { visibility: "workspace", resourceUriInput: "endpoint" },
          },
          bindings: [
            {
              key: "oauth-grant",
              subjectRef: { kind: "Principal", id: "principal_fixture" },
              permissions: ["mcp.invoke"],
              delivery: { type: "oauth2" },
            },
          ],
        },
      ]),
      interfaceTokenProof: true,
      interfaceRuntimeTokenFile: "/private/runtime-token",
      outputAllowlistJson: JSON.stringify({
        url: { from: "url", type: "url", required: true },
      }),
      deployTimeoutSeconds: "1",
      pollIntervalMs: "1",
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-secret-fixture" },
  );
  const options = {
    ...optionsFromFile,
    dryRun: false,
    interfaceRuntimeToken: runtimeToken,
  } as const;
  const blueprint = options.interfaceBlueprints![0]!;
  const outputDigest = `sha256:${"c".repeat(64)}`;
  const resource = "https://oauth-resource.takos.jp/";
  const iface = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "Interface",
    metadata: {
      id: "if_oauth_fixture",
      workspaceId: "ws_test",
      name: blueprint.name,
      ownerRef: { kind: "Capsule", id: "cap_oauth_fixture" },
      generation: 1,
      materializedFrom: { source: "capsule_blueprint", key: blueprint.key },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    spec: {
      ...blueprint.spec,
      inputs: {
        endpoint: {
          source: "capsule_output",
          capsuleId: "cap_oauth_fixture",
          outputName: "url",
        },
      },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 1,
      resolvedRevision: 1,
      resolvedInputs: { endpoint: resource },
      resourceUri: resource,
      provenance: {
        endpoint: {
          source: "capsule_output",
          runId: "run_apply",
          stateVersionId: "state_oauth_fixture",
          outputId: "out_oauth_fixture",
          outputDigest,
          outputName: "url",
        },
      },
    },
  } as const;
  const binding = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "InterfaceBinding",
    metadata: {
      id: "ib_oauth_fixture",
      workspaceId: "ws_test",
      generation: 1,
      materializedFrom: {
        source: "capsule_blueprint",
        interfaceKey: blueprint.key,
        key: blueprint.bindings![0]!.key,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    spec: {
      interfaceId: "if_oauth_fixture",
      subjectRef: { kind: "Principal", id: "principal_fixture" },
      permissions: ["mcp.invoke"],
      delivery: { type: "oauth2" },
    },
    status: { phase: "Ready", observedInterfaceRevision: 1 },
  } as const;
  const ledger = {
    capsuleStatus: "active",
    stateVersionId: "state_oauth_fixture",
    generation: 2,
    applyRunId: "run_apply",
    outputId: "out_oauth_fixture",
    outputDigest,
    publicOutputNames: ["url"],
    publicOutputDigest: `sha256:${"d".repeat(64)}`,
    publicOutputs: { url: resource },
  } as const;
  const originalFetch = globalThis.fetch;
  let retired = false;
  const mismatchedResource = "https://oauth-resource-mismatch.takos.jp/";
  let tokenResource = mismatchedResource;
  let mismatchedResourceFetches = 0;
  let reflectIssuedToken = false;
  let denyTransportUnavailable = false;
  let controlPlaneTokenRequests = 0;
  let publicResolverCalls = 0;
  const publicProbeRequests: Array<{
    readonly address: string;
    readonly servername: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly path: string;
  }> = [];
  const publicProbeDependencies = {
    ...pinnedControlPlaneFixture(
      async (input, init) => await globalThis.fetch(input, init),
    ),
    resolver: async () => {
      publicResolverCalls += 1;
      return publicResolverCalls === 1
        ? [
            { address: "93.184.216.35", family: 4 as const },
            { address: "93.184.216.34", family: 4 as const },
          ]
        : [
            { address: "93.184.216.37", family: 4 as const },
            { address: "93.184.216.36", family: 4 as const },
          ];
    },
    connector: async (request: typeof publicProbeRequests[number] & { readonly signal: AbortSignal }) => {
      publicProbeRequests.push(request);
      const authorization = request.headers.authorization;
      if (request.servername === "oauth-resource-mismatch.takos.jp") {
        mismatchedResourceFetches += 1;
      }
      if (authorization === undefined) {
        return retired
          ? new Response("gone", { status: 404 })
          : Response.json({ ok: true });
      }
      if (authorization !== `Bearer ${issuedToken}`) {
        throw new Error("unexpected Interface bearer");
      }
      if (retired && denyTransportUnavailable) {
        throw new Error(`retired resource transport unavailable ${issuedToken}`);
      }
      if (reflectIssuedToken) {
        return new Response(`reflected credential ${issuedToken}`, {
          status: 500,
        });
      }
      return retired
        ? new Response("denied", { status: 401 })
        : Response.json({ ok: true });
    },
  };
  globalThis.fetch = (async (input) => {
    const requestUrl = new URL(String(input));
    const requestPath = requestUrl.pathname;
    if (requestPath === "/api/v1/interfaces") {
      return Response.json({
        interfaces: [retired ? { ...iface, status: { ...iface.status, phase: "Retired" } } : iface],
      });
    }
    if (requestPath === "/api/v1/interfaces/if_oauth_fixture") {
      return Response.json(retired ? { ...iface, status: { ...iface.status, phase: "Retired" } } : iface);
    }
    if (requestPath === "/api/v1/interfaces/if_oauth_fixture/bindings") {
      return Response.json({
        bindings: [retired ? { ...binding, status: { ...binding.status, phase: "Revoked" } } : binding],
      });
    }
    if (requestPath === "/api/v1/interfaces/if_oauth_fixture/bindings/ib_oauth_fixture") {
      return Response.json(retired ? { ...binding, status: { ...binding.status, phase: "Revoked" } } : binding);
    }
    if (requestPath === "/api/v1/interfaces/if_oauth_fixture/token") {
      controlPlaneTokenRequests += 1;
      if (retired) return new Response("denied", { status: 403 });
      return Response.json({
        access_token: issuedToken,
        token_type: "Bearer",
        expires_in: 30,
        expires_at: "2026-01-01T00:00:30.000Z",
        scope: "mcp.invoke",
        resource: tokenResource,
      });
    }
    throw new Error(`unexpected OAuth Interface fixture request: ${requestUrl}`);
  }) as typeof fetch;
  try {
    await expect(
      assertInterfaceMaterialization(options, {
        workspaceId: "ws_test",
        capsuleId: "cap_oauth_fixture",
        stateVersionLedger: ledger,
      }, publicProbeDependencies),
    ).rejects.toThrow(/canonical Interface resource/u);
    expect(mismatchedResourceFetches).toBe(0);

    tokenResource = resource;
    reflectIssuedToken = true;
    let reflectedFailure = "";
    try {
      await assertInterfaceMaterialization(options, {
        workspaceId: "ws_test",
        capsuleId: "cap_oauth_fixture",
        stateVersionLedger: ledger,
      }, publicProbeDependencies);
    } catch (error) {
      reflectedFailure = error instanceof Error ? error.message : String(error);
    }
    expect(reflectedFailure).toContain("reflected credential");
    expect(reflectedFailure).not.toContain(issuedToken);
    reflectIssuedToken = false;

    publicResolverCalls = 0;
    const lifecycleRequestStart = publicProbeRequests.length;
    const context = await assertInterfaceMaterialization(options, {
      workspaceId: "ws_test",
      capsuleId: "cap_oauth_fixture",
      stateVersionLedger: ledger,
    }, publicProbeDependencies);
    expect(context.records[0]!.issuedToken?.token).toBe(issuedToken);
    expect(context.records[0]!.issuedToken?.permission).toBe("mcp.invoke");
    retired = true;
    denyTransportUnavailable = true;
    let deniedTransportFailure = "";
    try {
      await assertInterfacesRetired(
        options,
        context,
        publicProbeDependencies,
      );
    } catch (error) {
      deniedTransportFailure = error instanceof Error
        ? error.message
        : String(error);
    }
    expect(deniedTransportFailure).toContain(
      "Interface bearer resource request failed",
    );
    expect(deniedTransportFailure).not.toContain(issuedToken);
    denyTransportUnavailable = false;
    const retiredContext = await assertInterfacesRetired(
      options,
      context,
      publicProbeDependencies,
    );
    expect(retiredContext.records[0]!.tokenRevoked).toBe(true);
    expect(retiredContext.records[0]!.tokenUseDenied).toBe(true);
    expect(publicResolverCalls).toBe(1);
    expect(publicProbeRequests).toHaveLength(6);
    expect(publicProbeRequests.slice(lifecycleRequestStart).every((request) =>
      request.address === "93.184.216.34"
    )).toBe(true);
    const bearerRequests = publicProbeRequests.filter(
      (request) => request.headers.authorization !== undefined,
    );
    expect(bearerRequests).toHaveLength(4);
    expect(bearerRequests.every((request) =>
      request.address === "93.184.216.34" &&
      request.servername === "oauth-resource.takos.jp" &&
      request.headers.host === "oauth-resource.takos.jp" &&
      request.headers.authorization === `Bearer ${issuedToken}` &&
      request.path === "/"
    )).toBe(true);
    expect(controlPlaneTokenRequests).toBe(5);
    const evidence = interfaceMaterializationEvidence(
      retiredContext.records[0]!,
    );
    expect(JSON.stringify(evidence)).not.toContain(issuedToken);
    expect(evidence.tokenProof?.tokenDigest).toMatch(/^sha256:/u);
    assertSmokeSerializationSafe(evidence, options);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("platform smoke failure redaction includes raw issued Interface access tokens", async () => {
  const issuedToken = "issued-interface-token-reflected-by-provider";
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
  );
  const startedAtMs = Date.now();
  const result = failedResult(options, {
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    workspaceId: "ws_test",
    completedSteps: [],
    stepTimings: [],
    runTimings: [],
    capsuleGateStatus: "not_reached",
    policyStatus: "not_reached",
    serviceIdentitySampleCount: 0,
    redactedValues: [issuedToken],
    error: new Error(`provider reflected ${issuedToken}`),
  });

  expect(result.error).toContain("provider reflected");
  expect(JSON.stringify(result)).not.toContain(issuedToken);
});

test("platform smoke binds compatibility checks before Capsule creation", () => {
  const body = smokeSourceCompatibilityCheckBody({
    sourceSnapshotId: "snap_1",
    capsuleName: "example",
    installConfigId: "cfg_default",
    compileInstallUx: false,
    modulePath: "deploy/opentofu",
  });

  expect(body).toEqual({
    sourceSnapshotId: "snap_1",
    installConfigId: "cfg_default",
    modulePath: "deploy/opentofu",
  });
  expect(body).not.toHaveProperty("capsuleId");
});

test("platform smoke can reproduce Store-backed managed Provider resolution", async () => {
  const storeMetadata = {
    source: {
      git: "https://github.com/tako0614/takos.git",
      path: "deploy/opentofu",
    },
    order: 1_000,
    surface: "service",
    kind: "worker",
    provider: "cloudflare",
    suggestedName: "takos",
    badge: { ja: "追加候補", en: "Installable" },
    name: { ja: "Takos", en: "Takos" },
    description: {
      ja: "AI workspace distribution を公開します。",
      en: "Deploys the Takos AI workspace distribution.",
    },
    inputs: [],
  } as const;
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app.takosumi.com",
      workspace: "ws_test",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      sourceGitUrl: "https://github.com/tako0614/takos.git",
      modulePath: "deploy/opentofu",
      storeMetadataJson: JSON.stringify(storeMetadata),
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
  );

  expect(
    smokeGitInstallPlanBody(options, {
      sourceName: "example",
      sourceId: "src_test",
      sourceSnapshotId: "snap_test",
      compatibilityCheckRunId: "ccr_test",
      compatibilityReportId: "caprep_test",
      installConfigId: "cfg_generic",
      providerBindings: [],
    }),
  ).toMatchObject({
    preflight: {
      sourceId: "src_test",
      sourceSnapshotId: "snap_test",
      compatibilityCheckRunId: "ccr_test",
      compatibilityReportId: "caprep_test",
      installConfigId: "cfg_generic",
    },
    options: { modulePath: "deploy/opentofu" },
    initialConfiguration: { store: storeMetadata },
  });
  const result = dryRunResult(options);
  expect(result.inputs.storeMetadataDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(JSON.stringify(result)).not.toContain(
    "AI workspace distribution を公開します。",
  );
});

test("platform control-plane smoke dry-run is redacted and complete", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      appName: "takosumi-smoke-test",
      cloudflareAccountIdFile:
        "/operator/.secrets/staging/CLOUDFLARE_ACCOUNT_ID",
      cloudflareWorkersSubdomainFile:
        "/operator/.secrets/staging/CLOUDFLARE_WORKERS_SUBDOMAIN",
      sessionTokenFile:
        "/operator/.secrets/staging/TAKOSUMI_ACCOUNT_SESSION_TOKEN",
      cloudflareApiTokenFile: "/operator/.secrets/staging/CLOUDFLARE_API_TOKEN",
      cloudflareConnectionMode: "guided",
      verificationMode: "cloudflare-worker",
    },
    {},
  );

  const result = dryRunResult(options);
  const json = JSON.stringify(result);

  expect(result.kind).toBe("takosumi.platform-control-plane-smoke@v3");
  expect(result.status).toBe("dry_run");
  expect(result.environment).toBe("smoke");
  expect(result.capsuleModule).toBe("git-opentofu-capsule");
  expect(result.credentialPath).toBe("workspace_scoped_provider_connection");
  expect(result.steps).toEqual([
    "workspaceScopedProviderConnection",
    "connectionVerified",
    "sourceRegistered",
    "sourceSynced",
    "scratchInstall",
    "compatibilityChecked",
    "plan",
    "apply",
    "runtimeVerified",
    "publicUrlVerified",
    "stateVersionLedgerVerified",
    "interfaceMaterializationVerified",
    "destroy",
    "runEventSequenceVerified",
    "interfaceRetiredVerified",
    "connectionRevoked",
  ]);
  expect(result.workerUrl).toBe(
    "https://takosumi-smoke-test.<redacted>.workers.dev",
  );
  expect(result.publicUrlVerified).toBe(true);
  expect(result.stateVersionLedgerVerified).toBe(true);
  expect(result.destroyVerified).toBe(true);
  expect(result.connectionRevoked).toBe(true);
  expect(result.stateVersionLedger).toEqual({
    capsuleStatus: "active",
    stateVersionId: "state_dry_run",
    generation: 1,
    applyRunId: "apply_dry_run",
    outputId: "output_dry_run",
    outputDigest: `sha256:${"0".repeat(64)}`,
    publicOutputNames: ["url", "worker_name"],
    publicOutputDigest: `sha256:${"0".repeat(64)}`,
  });
  expect(result.interfaceMaterializations).toHaveLength(1);
  expect(result.interfaceMaterialization?.interfacePhase).toBe("Resolved");
  expect(result.interfaceMaterialization?.bindingPhase).toBe("Ready");
  expect(result.interfaceMaterialization?.retiredPhase).toBe("Retired");
  expect(result.interfaceMaterialization?.revokedBindingPhase).toBe("Revoked");
  expect(result.runEventSequence?.plan.runId).toBe("plan_dry_run");
  expect(result.runEventSequence?.apply.runId).toBe("apply_dry_run");
  expect(result.runEventSequence?.destroyApply.runId).toBe(
    "destroy_apply_dry_run",
  );
  expect(result.inputs.accountSessionTokenSource).toBe("file");
  expect(result.inputs.cloudflareApiTokenSource).toBe("file");
  expect(result.inputs.cloudflareAccountIdSource).toBe("file");
  expect(result.inputs.cloudflareAccountIdDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/,
  );
  expect(result.inputs.cloudflareWorkersSubdomainSource).toBe("file");
  expect(json).not.toContain("cf-account-secret-ish");
  expect(json).not.toContain("CLOUDFLARE_ACCOUNT_ID");
  expect(json).not.toContain("TAKOSUMI_ACCOUNT_SESSION_TOKEN");
  expect(json).not.toContain("CLOUDFLARE_API_TOKEN");
});

test("platform smoke binds an optional provider-neutral service identity without retaining it", async () => {
  const identity = "immutable-release-revision";
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      sessionTokenFile: "/operator/private/session",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      expectedServiceIdentityHeader: "X-Release-Revision",
      expectedServiceIdentity: identity,
    },
    {},
  );

  const result = dryRunResult(options);
  expect(result.serviceIdentity).toEqual({
    headerName: "x-release-revision",
    identityDigest: `sha256:${createHash("sha256")
      .update(identity)
      .digest("hex")}`,
    sampleCount: 0,
    result: "planned",
  });
  expect(JSON.stringify(result)).not.toContain(identity);
  expect(() =>
    assertServiceIdentityResponse(
      new Headers({ "x-release-revision": identity }),
      options.expectedServiceIdentity!,
    ),
  ).not.toThrow();
  expect(() =>
    assertServiceIdentityResponse(
      new Headers({ "x-release-revision": "substituted" }),
      options.expectedServiceIdentity!,
    ),
  ).toThrow("service identity response header did not match expectation");
});

test("platform smoke rejects partial service identity and unsafe private evidence inputs", async () => {
  await expect(
    resolveOptions(
      {
        dryRun: true,
        url: "https://app-staging.takosumi.com",
        workspace: "ws_test",
        sessionTokenFile: "/operator/private/session",
        cloudflareConnectionMode: "none",
        verificationMode: "opentofu",
        expectedServiceIdentityHeader: "x-release-revision",
      },
      {},
    ),
  ).rejects.toThrow("must be provided together");

  const root = await mkdtemp(join(tmpdir(), "takosumi-platform-private-"));
  try {
    await chmod(root, 0o700);
    const session = join(root, "session");
    const evidence = join(root, "evidence.json");
    await writeFile(session, "session-token\n", { mode: 0o644 });
    await expect(
      resolveOptions(
        {
          url: "https://app-staging.takosumi.com",
          workspace: "ws_test",
          sessionTokenFile: session,
          sourceGitUrl: "https://github.com/example/repository.git",
          cloudflareConnectionMode: "none",
          verificationMode: "opentofu",
        },
        {},
      ),
    ).rejects.toThrow("mode 0600");

    await chmod(session, 0o600);
    const args = [
      "--url",
      "https://app-staging.takosumi.com",
      "--workspace",
      "ws_test",
      "--session-token-file",
      session,
      "--cloudflare-connection-mode",
      "none",
      "--verification-mode",
      "opentofu",
      "--expected-service-identity-header",
      "x-release-revision",
      "--expected-service-identity",
      "immutable-release-revision",
      "--out-file",
      evidence,
      "--dry-run",
    ] as const;
    await expect(main(args)).resolves.toBe(0);
    expect((await lstat(evidence)).mode & 0o777).toBe(0o600);
    expect(await readFile(evidence, "utf8")).not.toContain(
      "immutable-release-revision",
    );
    await expect(main(args)).rejects.toThrow("target already exists");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("platform control-plane smoke keeps the Capsule name independent from OpenTofu variable names", async () => {
  const projectOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
      varsJson: JSON.stringify({
        project_name: "takos-from-project",
        cloudflare: { account_id: "account" },
      }),
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );
  expect(projectOptions.appName).toMatch(/^takosumi-smoke-[a-z0-9]+$/u);
  expect(projectOptions.appName).not.toBe("takos-from-project");

  const workerOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
      varsJson: JSON.stringify({
        worker_name: "worker-from-vars",
      }),
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );
  expect(workerOptions.appName).toMatch(/^takosumi-smoke-[a-z0-9]+$/u);
  expect(workerOptions.appName).not.toBe("worker-from-vars");

  const explicitOptions = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      appName: "explicit-name",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
      varsJson: JSON.stringify({
        project_name: "takos-from-project",
        worker_name: "worker-from-vars",
      }),
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );
  expect(explicitOptions.appName).toBe("explicit-name");
});

test("platform control-plane smoke reads current Capsule ledger responses", () => {
  expect(
    capsuleFromLedgerResponse({
      capsule: {
        id: "cap_current",
        workspaceId: "ws_current",
        currentStateVersionId: "state_current",
        currentStateGeneration: 1,
        status: "active",
      },
    }),
  ).toEqual({
    id: "cap_current",
    workspaceId: "ws_current",
    currentStateVersionId: "state_current",
    currentStateGeneration: 1,
    status: "active",
  });
  expect(() =>
    capsuleFromLedgerResponse({
      installation: {
        id: "inst_legacy",
        spaceId: "space_legacy",
        currentStateVersionId: "dep_legacy",
        currentStateGeneration: 1,
        status: "active",
      },
    } as never),
  ).toThrow("capsule ledger response did not include capsule");
  expect(() => capsuleFromLedgerResponse({})).toThrow(
    "capsule ledger response did not include capsule",
  );
});

test("platform control-plane smoke matches canonical provider connection sources", () => {
  const expected = smokeCloudflareProviderConnectionMatch(
    "Layer-2 smoke canonical",
  );

  expect(expected.provider).toBe("registry.opentofu.org/cloudflare/cloudflare");

  expect(
    isSmokeProviderConnectionMatch(
      {
        id: "pcn_test",
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        displayName: "Layer-2 smoke canonical",
      },
      expected,
    ),
  ).toBe(true);
  expect(
    isSmokeProviderConnectionMatch(
      {
        id: "pcn_test",
        providerSource: "cloudflare",
        displayName: "Layer-2 smoke canonical",
      },
      expected,
    ),
  ).toBe(false);
  expect(
    isSmokeProviderConnectionMatch(
      {
        id: "pcn_test",
        providerSource: "registry.opentofu.org/hashicorp/aws",
        displayName: "Layer-2 smoke canonical",
      },
      expected,
    ),
  ).toBe(false);
});

test("platform control-plane smoke creates Provider Connections through installed Credential Recipes", () => {
  const genericEnvOptions = {
    cloudflareConnectionMode: "generic-env" as const,
    cloudflareApiToken: "cloudflare-token",
    cloudflareAccountId: "account",
    cloudflareWorkersSubdomain: "takosumi-smoke",
  };

  expect(
    smokeWorkspaceCloudflareConnectionBody(
      genericEnvOptions,
      "ws_test",
      "Layer-2 smoke canonical",
    ),
  ).toEqual({
    workspaceId: "ws_test",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    credentialRecipe: {
      id: "generic-env",
      authMode: "env",
      secretPartition: "provider-credentials",
    },
    displayName: "Layer-2 smoke canonical",
    scopeHints: {
      providerSettings: {
        accountId: "account",
        workersSubdomain: "takosumi-smoke",
      },
      moduleInputDefaults: {
        cloudflare_account_id: "account",
        cloudflare_workers_subdomain: "takosumi-smoke",
      },
    },
    values: {
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_ACCOUNT_ID: "account",
    },
  });

  expect(
    smokeWorkspaceCloudflareConnectionBody(
      { ...genericEnvOptions, cloudflareConnectionMode: "guided" },
      "ws_test",
      "Layer-2 smoke canonical",
    ),
  ).toMatchObject({
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    credentialRecipe: {
      id: "cloudflare",
      authMode: "api_token",
      secretPartition: "provider-credentials",
    },
    values: { CLOUDFLARE_API_TOKEN: "cloudflare-token" },
  });
});

test("platform control-plane smoke accepts an existing ProviderConnection only in none mode", async () => {
  const base = {
    dryRun: true,
    url: "https://app-staging.takosumi.com",
    workspace: "ws_test",
    providerConnectionId: "pcn_existing_takoform",
    verificationMode: "opentofu",
    sourceGitUrl: "https://github.com/tako0614/takosumi.git",
    sourcePath: "examples/takoform-object-bucket-smoke",
    outputAllowlistJson: JSON.stringify({
      object_bucket_id: {
        from: "object_bucket_id",
        type: "string",
        required: true,
      },
    }),
    varsJson: JSON.stringify({ bucket_name: "unique-existing-provider" }),
  } as const;

  const options = await resolveOptions(base, {
    TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
  });
  expect(options.providerConnectionId).toBe("pcn_existing_takoform");
  expect(options.cloudflareConnectionMode).toBe("none");

  await expect(
    resolveOptions(
      { ...base, cloudflareConnectionMode: "guided" },
      { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
    ),
  ).rejects.toThrow(/mutually exclusive|cannot be combined|requires/u);
  await expect(
    resolveOptions(
      { ...base, cloudflareConnectionMode: "generic-env" },
      { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
    ),
  ).rejects.toThrow(/mutually exclusive|cannot be combined|requires/u);

  const envOptions = await resolveOptions(
    { ...base, providerConnectionId: undefined },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      TAKOSUMI_SMOKE_PROVIDER_CONNECTION_ID: "pcn_from_env",
    },
  );
  expect(envOptions.providerConnectionId).toBe("pcn_from_env");
});

test("platform control-plane smoke accepts a deterministic 0..N explicit ProviderBinding set", async () => {
  const bindings = [
    {
      provider: "registry.terraform.io/tako0614/takoform",
      moduleLocalName: "takoform",
      childAlias: "objects",
      rootAlias: "takoform_objects",
      connectionId: "pcn_takoform",
    },
    {
      provider: "registry.opentofu.org/hashicorp/aws",
      moduleLocalName: "aws",
      connectionId: "pcn_aws",
    },
  ];
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      sourceGitUrl: "https://github.com/example/multi-provider.git",
      providerBindingsJson: JSON.stringify(bindings),
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
  );

  expect(options.providerBindings).toEqual([bindings[1], bindings[0]]);
  expect(options.providerConnectionId).toBeUndefined();
  expect(options.runnerProfileId).toBeUndefined();

  const result = dryRunResult(options);
  expect(result.credentialPath).toBe("workspace_scoped_provider_connection");
  expect(result.steps).toContain("existingProviderConnectionsSelected");
  expect(result.steps).not.toContain("providerConnectionNotRequired");
  expect(result.inputs.providerBindingCount).toBe(2);
  expect(result.inputs.providerBindingsExplicit).toBe(true);
  expect(result.inputs.providerBindingsDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/u,
  );
  expect(JSON.stringify(result)).not.toContain("pcn_takoform");
  expect(JSON.stringify(result)).not.toContain("pcn_aws");
});

test("existing non-Cloudflare ProviderBindings do not inject Cloudflare hello-module variables", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      appName: "generic-service-e2e",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      sourceGitUrl: "https://github.com/example/generic-service.git",
      modulePath: "deploy/service",
      providerBindingsJson: JSON.stringify([
        {
          provider: "registry.terraform.io/tako0614/takoform",
          moduleLocalName: "takoform",
          connectionId: "pcn_takoform",
        },
      ]),
      varsJson: JSON.stringify({
        service_name: "generic-service-e2e",
      }),
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
  );

  const expectedVars = {
    service_name: "generic-service-e2e",
  };
  expect(options.vars).toEqual(expectedVars);
  expect(
    smokeGitInstallPlanBody(options, {
      sourceName: "generic-service",
      sourceId: "src_generic_service",
      sourceSnapshotId: "snap_generic_service",
      compatibilityCheckRunId: "ccr_generic_service",
      compatibilityReportId: "caprep_generic_service",
      installConfigId: "cfg_generic",
      providerBindings: options.providerBindings,
    }),
  ).toMatchObject({ variables: expectedVars });
});

test("Yurucommu Takoform smoke sends no reviewed variables and leaves project_name to capsule_name", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      appName: "yurucommu-e2e",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      sourceGitUrl: "https://github.com/tako0614/yurucommu.git",
      modulePath: "deploy/takoform",
      noDefaultVars: true,
      providerBindingsJson: JSON.stringify([
        {
          provider: "registry.terraform.io/tako0614/takoform",
          moduleLocalName: "takoform",
          connectionId: "pcn_takoform",
        },
      ]),
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
  );

  expect(options.vars).toEqual({});
  expect(
    smokeGitInstallPlanBody(options, {
      sourceName: "yurucommu",
      sourceId: "src_yurucommu",
      sourceSnapshotId: "snap_yurucommu",
      compatibilityCheckRunId: "ccr_yurucommu",
      compatibilityReportId: "caprep_yurucommu",
      installConfigId: "cfg_yurucommu_takoform",
      providerBindings: options.providerBindings,
    }),
  ).toMatchObject({ capsule: { name: "yurucommu-e2e" }, variables: {} });
});

test("an explicit empty ProviderBinding set remains authoritative zero", async () => {
  const base = {
    dryRun: true,
    url: "https://app-staging.takosumi.com",
    workspace: "ws_test",
    cloudflareConnectionMode: "none",
    verificationMode: "opentofu",
    sourceGitUrl: "https://github.com/example/providerless.git",
    providerBindingsJson: "[]",
  } as const;

  const options = await resolveOptions(base, {
    TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
  });
  const result = dryRunResult(options);
  expect(options.providerBindings).toEqual([]);
  expect(options.providerBindingsExplicit).toBe(true);
  expect(result.inputs.providerBindingCount).toBe(0);
  expect(result.inputs.providerBindingsExplicit).toBe(true);
  expect(result.inputs.providerBindingsDigest).toMatch(
    /^sha256:[0-9a-f]{64}$/u,
  );
  expect(result.steps).toContain("providerConnectionNotRequired");

  await expect(
    resolveOptions(base, {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      TAKOSUMI_SMOKE_PROVIDER_CONNECTION_ID: "pcn_legacy",
    }),
  ).rejects.toThrow(/cannot be combined/u);
  await expect(
    resolveOptions(
      {
        ...base,
        cloudflareConnectionMode: "guided",
        cloudflareAccountId: "account",
        cloudflareWorkersSubdomain: "workers-subdomain",
      },
      {
        TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
      },
    ),
  ).rejects.toThrow(/cannot be combined/u);
});

test("platform control-plane smoke rejects ambiguous or non-canonical ProviderBinding input", async () => {
  const base = {
    dryRun: true,
    url: "https://app-staging.takosumi.com",
    workspace: "ws_test",
    cloudflareConnectionMode: "none",
    verificationMode: "opentofu",
    sourceGitUrl: "https://github.com/example/multi-provider.git",
  } as const;
  const env = { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" };

  await expect(
    resolveOptions(
      {
        ...base,
        providerBindingsJson: JSON.stringify([
          { provider: "hashicorp/aws", connectionId: "pcn_aws" },
        ]),
      },
      env,
    ),
  ).rejects.toThrow(/exact canonical provider source/u);
  await expect(
    resolveOptions(
      {
        ...base,
        providerBindingsJson: JSON.stringify([
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
            connectionId: "pcn_aws",
          },
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
            connectionId: "pcn_other",
          },
        ]),
      },
      env,
    ),
  ).rejects.toThrow(/duplicate ProviderBinding address/u);
  await expect(
    resolveOptions(
      {
        ...base,
        providerConnectionId: "pcn_legacy",
        providerBindingsJson: JSON.stringify([
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            connectionId: "pcn_aws",
          },
        ]),
      },
      env,
    ),
  ).rejects.toThrow(/cannot be combined/u);
  await expect(
    resolveOptions(
      {
        ...base,
        providerBindingsJson: JSON.stringify([
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
            childAlias: "one",
            connectionId: "pcn_one",
          },
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
            childAlias: "two",
            connectionId: "pcn_two",
          },
        ]),
      },
      env,
    ),
  ).rejects.toThrow(/duplicate root provider target/u);
});

test("platform control-plane smoke binds an existing provider by its source", () => {
  expect(
    smokeGitInstallPlanProviderBindings([
        {
          provider: "registry.terraform.io/tako0614/takoform",
          moduleLocalName: "takoform",
          childAlias: "objects",
          rootAlias: "takoform_objects",
          connectionId: "pcn_existing_takoform",
        },
        {
          provider: "registry.opentofu.org/hashicorp/aws",
          moduleLocalName: "aws",
          connectionId: "pcn_existing_aws",
        },
      ],
    ),
  ).toEqual([
      {
        provider: "registry.opentofu.org/hashicorp/aws",
        moduleLocalName: "aws",
        connectionId: "pcn_existing_aws",
      },
      {
        provider: "registry.terraform.io/tako0614/takoform",
        moduleLocalName: "takoform",
        childAlias: "objects",
        rootAlias: "takoform_objects",
        connectionId: "pcn_existing_takoform",
      },
    ]);
  expect(
    JSON.stringify(
      smokeGitInstallPlanProviderBindings([
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            connectionId: "pcn_existing_aws",
          },
        ],
      ),
    ),
  ).not.toContain('"alias"');
});

test("platform smoke resolves an omitted guided binding identity from compatibility", () => {
  const resolved = resolveSmokeProviderBindingsFromCompatibility(
    [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        connectionId: "pcn_guided_cloudflare",
      },
    ],
    [
      {
        source: "registry.opentofu.org/cloudflare/cloudflare",
        moduleLocalName: "cloudflare",
      },
    ],
  );
  expect(resolved).toEqual([
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      moduleLocalName: "cloudflare",
      connectionId: "pcn_guided_cloudflare",
    },
  ]);
  expect(smokeGitInstallPlanProviderBindings(resolved)).toEqual([
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        moduleLocalName: "cloudflare",
        connectionId: "pcn_guided_cloudflare",
      },
    ]);
});

test("platform smoke selects the exact provider source from a multi-provider report", () => {
  expect(
    resolveSmokeProviderBindingsFromCompatibility(
      [
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          connectionId: "pcn_guided_cloudflare",
        },
      ],
      [
        {
          source: "registry.opentofu.org/hashicorp/aws",
          moduleLocalName: "aws",
        },
        {
          // Prove that the report owns the module-local name. The provider
          // source suffix is not a safe fallback.
          source: "cloudflare/cloudflare",
          moduleLocalName: "edge",
        },
      ],
    ),
  ).toEqual([
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      moduleLocalName: "edge",
      connectionId: "pcn_guided_cloudflare",
    },
  ]);
});

test("platform smoke rejects an omitted identity when one source has multiple aliases", () => {
  expect(() =>
    resolveSmokeProviderBindingsFromCompatibility(
      [
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          connectionId: "pcn_guided_cloudflare",
        },
      ],
      [
        {
          source: "registry.opentofu.org/cloudflare/cloudflare",
          moduleLocalName: "edge",
          childAlias: "account",
        },
        {
          source: "registry.opentofu.org/cloudflare/cloudflare",
          moduleLocalName: "edge",
          childAlias: "zone",
        },
      ],
    ),
  ).toThrow(/2 matching root provider requirements.*explicit moduleLocalName and childAlias/u);
});

test("platform smoke rejects an omitted identity with no matching requirement", () => {
  expect(() =>
    resolveSmokeProviderBindingsFromCompatibility(
      [
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          connectionId: "pcn_guided_cloudflare",
        },
      ],
      [
        {
          source: "registry.opentofu.org/hashicorp/aws",
          moduleLocalName: "aws",
        },
      ],
    ),
  ).toThrow(/no matching root provider requirement.*explicit moduleLocalName and childAlias/u);
});

test("platform smoke preserves an explicit provider identity after compatibility validation", () => {
  const binding = {
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    moduleLocalName: "edge-provider",
    childAlias: "zone-edge",
    rootAlias: "production-edge",
    connectionId: "pcn_explicit_cloudflare",
  } as const;
  expect(
    resolveSmokeProviderBindingsFromCompatibility(
      [binding],
      [
        {
          source: binding.provider,
          moduleLocalName: binding.moduleLocalName,
          childAlias: binding.childAlias,
        },
      ],
    ),
  ).toEqual([binding]);
  expect(() =>
    resolveSmokeProviderBindingsFromCompatibility(
      [binding],
      [
        {
          source: binding.provider,
          moduleLocalName: "cloudflare",
        },
      ],
    ),
  ).toThrow(/explicit provider identity.*not declared/u);
});

test("multi-provider smoke evidence redacts explicit ProviderConnection ids on failure", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      sourceGitUrl: "https://github.com/example/multi-provider.git",
      providerBindingsJson: JSON.stringify([
        {
          provider: "registry.opentofu.org/hashicorp/aws",
          connectionId: "pcn_private_aws",
        },
      ]),
    },
    { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
  );
  const startedAtMs = Date.now();
  const result = failedResult(options, {
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    workspaceId: "ws_test",
    completedSteps: [],
    stepTimings: [],
    runTimings: [],
    capsuleGateStatus: "not_reached",
    policyStatus: "not_reached",
    runCancellationError: "cancel failed for pcn_private_aws",
    failureCleanup: {
      attempted: true,
      cloudflareWorkerGone: false,
      capsuleMarkedError: false,
      destroyAttempted: true,
      destroySucceeded: false,
      destroyError: "destroy failed for pcn_private_aws",
      error: "cleanup failed for pcn_private_aws",
    },
    serviceIdentitySampleCount: 0,
    error: new Error(
      "ProviderConnection pcn_private_aws was not available to this Workspace",
    ),
  });

  expect(result.error).toContain("<provider-connection>");
  expect(JSON.stringify(result)).not.toContain("pcn_private_aws");
});

test("platform control-plane smoke records an existing ProviderConnection without revoking or leaking secrets", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "ws_test",
      providerConnectionId: "pcn_existing_takoform",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      sourceGitUrl: "https://github.com/tako0614/takosumi.git",
      sourcePath: "examples/takoform-object-bucket-smoke",
      outputAllowlistJson: JSON.stringify({
        object_bucket_id: {
          from: "object_bucket_id",
          type: "string",
          required: true,
        },
      }),
      varsJson: JSON.stringify({ bucket_name: "unique-existing-provider" }),
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      TAKOFORM_TOKEN: "provider-secret",
    },
  );

  const result = dryRunResult(options);
  const serialized = JSON.stringify(result);
  expect(result.providerConnectionId).toBe("pcn_existing_takoform");
  expect(result.credentialPath).toBe("workspace_scoped_provider_connection");
  expect(result.steps).toContain("existingProviderConnectionSelected");
  expect(result.steps).not.toContain("providerConnectionNotRequired");
  expect(result.steps).not.toContain("connectionRevoked");
  expect(result.connectionRevoked).toBeUndefined();
  expect(result.inputs.providerConnectionId).toBe("pcn_existing_takoform");
  expect(serialized).not.toContain("provider-secret");
  expect(serialized).not.toContain("TAKOFORM_TOKEN");
});

test("platform control-plane smoke does not infer operator environment from URL", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app.takosumi.com",
      workspace: "@smoke-production",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );

  expect(options.environment).toBe("smoke");

  const explicit = await resolveOptions(
    {
      dryRun: true,
      url: "https://operator.selfhosted.dev",
      workspace: "@smoke-production",
      environment: "production",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );
  expect(explicit.environment).toBe("production");
});

test("platform control-plane URL is one canonical public HTTPS authority", async () => {
  const common = {
    dryRun: true,
    workspace: "ws_test",
    cloudflareConnectionMode: "none",
    verificationMode: "opentofu",
  } as const;
  const environment = {
    TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token-fixture",
  };
  const canonical = await resolveOptions(
    { ...common, url: "https://Control.SelfHosted.dev/" },
    environment,
  );
  expect(canonical.url).toBe("https://control.selfhosted.dev");

  for (const url of [
    "http://control.selfhosted.dev",
    "https://operator:secret@control.selfhosted.dev",
    "https://control.selfhosted.dev:443",
    "https://control.selfhosted.dev/api",
    "https://control.selfhosted.dev/.",
    "https://control.selfhosted.dev/a/..",
    " https://control.selfhosted.dev ",
    "https://control.\nselfhosted.dev",
    "https://control.selfhosted.dev?tenant=other",
    "https://control.selfhosted.dev?",
    "https://control.selfhosted.dev#other",
    "https://control.selfhosted.dev#",
    "https://127.0.0.1",
    "https://[::1]",
  ]) {
    await expect(resolveOptions({ ...common, url }, environment)).rejects.toThrow(
      "--url must be an absolute HTTPS origin",
    );
  }
});

test("platform control-plane smoke never infers auth authority from token prefixes", async () => {
  const sharedArgs = {
    url: "https://app-staging.takosumi.com",
    workspace: "ws_test",
    cloudflareConnectionMode: "none",
    verificationMode: "opentofu",
    sourceGitUrl: "https://github.example/takosumi/smoke-fixture.git",
  } as const;

  const sessionOptions = await resolveOptions(sharedArgs, {
    TAKOSUMI_ACCOUNT_SESSION_TOKEN: "opaque-token-with-no-session-prefix",
  });
  expect(sessionOptions.accountAuthTokenKind).toBe("session");
  expect(sessionOptions.accountSessionToken).toBe(
    "opaque-token-with-no-session-prefix",
  );

  const patOptions = await resolveOptions(sharedArgs, {
    TAKOSUMI_ACCOUNT_PAT_TOKEN: "another-opaque-token-with-no-pat-prefix",
  });
  expect(patOptions.accountAuthTokenKind).toBe("pat");
  expect(patOptions.accountSessionToken).toBe(
    "another-opaque-token-with-no-pat-prefix",
  );
});

test("platform control-plane smoke records Cloudflare D1 resource preflight", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
      cloudflareResourcePreflight: "d1",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );

  const result = dryRunResult(options);

  expect(result.inputs.cloudflareResourcePreflight).toBe("d1");
  expect(result.steps).toContain("cloudflareResourcePreflight");
  expect(result.completedSteps).toContain("cloudflareResourcePreflight");
  expect(result.cloudflareResourcePreflight).toEqual({
    mode: "d1",
    status: "passed",
    checks: ["cloudflare.d1.database.list"],
  });
});

test("platform control-plane smoke records Cloudflare account resource preflight", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
      cloudflareResourcePreflight: "account-resources",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );

  const result = dryRunResult(options);

  expect(result.inputs.cloudflareResourcePreflight).toBe("account-resources");
  expect(result.steps).toContain("cloudflareResourcePreflight");
  expect(result.completedSteps).toContain("cloudflareResourcePreflight");
  expect(result.cloudflareResourcePreflight).toEqual({
    mode: "account-resources",
    status: "passed",
    checks: [
      "cloudflare.workers.script.list",
      "cloudflare.d1.database.list",
      "cloudflare.kv.namespace.list",
      "cloudflare.r2.bucket.list",
      "cloudflare.queue.list",
      "cloudflare.workflow.list",
      "cloudflare.vectorize.index.list",
    ],
  });
});

test("platform control-plane smoke labels Git sources as Git OpenTofu Capsules", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
      sourceGitUrl: "https://github.com/tako0614/takos.git",
      sourceRef: "main",
      sourcePath: "deploy/opentofu",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
    },
  );

  expect(dryRunResult(options).capsuleModule).toBe("git-opentofu-capsule");
});

test("platform control-plane smoke rejects backup restore rehearsal even in dry-run", async () => {
  await expect(
    resolveOptions(
      {
        dryRun: true,
        backupRestoreRehearsal: true,
        url: "https://app-staging.takosumi.com",
        workspace: "ws_test",
        appName: "takosumi-smoke-test",
      },
      {
        TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      },
    ),
  ).rejects.toThrow(/no manifest-bound restore importer/);
});

test("platform control-plane smoke can require release activation evidence", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      requireReleaseActivation: "succeeded",
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
      appName: "takosumi-release-smoke",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
    },
  );

  const result = dryRunResult(options);

  expect(options.requireReleaseActivation).toBe("succeeded");
  expect(result.steps).toContain("releaseActivationVerified");
  expect(result.releaseActivation).toMatchObject({
    status: "succeeded",
    action: "release_activation.succeeded",
    runId: "apply_dry_run",
  });
});

test("platform control-plane smoke resolves secret sources from environment", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
      cloudflareAccountId: "account",
      cloudflareConnectionMode: "guided",
      verificationMode: "cloudflare-worker",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_WORKERS_SUBDOMAIN: "takosumi-smoke",
    },
  );

  expect(options.accountSessionTokenSource).toBe("env");
  expect(options.cloudflareApiTokenSource).toBe("env");
  expect(options.cloudflareAccountIdSource).toBe("arg");
  expect(options.cloudflareWorkersSubdomainSource).toBe("env");
  expect(options.accountSessionToken).toBe("<redacted>");
  expect(options.cloudflareApiToken).toBe("<redacted>");
  expect(options.cloudflareAccountId).toBe("<redacted>");
  expect(options.cloudflareWorkersSubdomain).toBe("<redacted>");
});

test("platform control-plane smoke defaults providerless OpenTofu mode to a keyless capsule", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
      appName: "takosumi-keyless-test",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
    },
  );

  const result = dryRunResult(options);

  expect(result.capsuleModule).toBe("git-opentofu-capsule");
  expect(result.providerConnectionMode).toBe("none");
  expect(result.credentialPath).toBe("none");
  expect(result.inputs.runnerProfileId).toBe("opentofu-default");
  expect(options.runnerProfileId).toBe("opentofu-default");
  expect(result.inputs.cloudflareApiTokenSource).toBe("not_required");
  expect(result.inputs.cloudflareAccountIdSource).toBe("not_required");
  expect(result.inputs.outputAllowlistNames).toEqual([
    "example_endpoint",
    "example_label",
  ]);
  expect(options.sourceRef).toBeUndefined();
  expect(result.inputs).not.toHaveProperty("sourceRef");
  expect(options.vars).toEqual({
    name: "takosumi-keyless-test",
    base_url: "https://takosumi-keyless-test.example.invalid",
  });
  expect(result.steps).toEqual([
    "providerConnectionNotRequired",
    "sourceRegistered",
    "sourceSynced",
    "scratchInstall",
    "compatibilityChecked",
    "plan",
    "apply",
    "opentofuApplyVerified",
    "stateVersionLedgerVerified",
    "destroy",
  ]);
});

test("platform control-plane smoke can require public URL checks for generic OpenTofu Capsules", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
      appName: "takosumi-public-url-test",
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      outputAllowlistJson: JSON.stringify({
        launch_url: { from: "launch_url", type: "url", required: true },
      }),
      publicUrlChecksJson: JSON.stringify([
        {
          name: "launch",
          output: "launch_url",
          path: "/healthz",
          expectedStatus: 204,
          bodyIncludes: ["ok"],
          destroyExpectation: { kind: "http-404" },
        },
      ]),
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
    },
  );

  const result = dryRunResult(options);

  expect(options.publicUrlChecks).toEqual([
    {
      name: "launch",
      output: "launch_url",
      path: "/healthz",
      expectedStatus: 204,
      bodyIncludes: ["ok"],
      destroyExpectation: { kind: "http-404" },
    },
  ]);
  expect(result.steps).toEqual([
    "providerConnectionNotRequired",
    "sourceRegistered",
    "sourceSynced",
    "scratchInstall",
    "compatibilityChecked",
    "plan",
    "apply",
    "opentofuApplyVerified",
    "stateVersionLedgerVerified",
    "publicUrlVerified",
    "destroy",
  ]);
  expect(result.publicUrlVerified).toBe(true);
  expect(result.publicUrlChecks).toEqual([
    {
      name: "launch",
      output: "launch_url",
      url: "https://example.invalid/healthz",
      status: 204,
      ok: true,
      bodyIncludes: ["ok"],
      bodyDigest: `sha256:${"0".repeat(64)}`,
      destroyExpectation: { kind: "http-404" },
    },
  ]);
  expect(result.publicUrlDestroyChecks).toEqual([
    {
      name: "launch",
      output: "launch_url",
      url: "https://example.invalid/healthz",
      expectation: { kind: "http-404" },
      applyStatus: "planned",
      status: "planned",
    },
  ]);
  expect(result.inputs.publicUrlCheckNames).toEqual(["launch"]);
  expect(result.inputs.publicUrlDestroyExpectations).toEqual([
    {
      name: "launch",
      expectation: { kind: "http-404" },
    },
  ]);
});

test("configured public URL checks require an explicit post-Destroy contract", async () => {
  const args = {
    dryRun: true,
    url: "https://app-staging.takosumi.com",
    workspace: "@scratch",
    cloudflareConnectionMode: "none",
    verificationMode: "opentofu",
    outputAllowlistJson: JSON.stringify({
      launch_url: { from: "launch_url", type: "url", required: true },
    }),
  } as const;
  const environment = {
    TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
  };

  await expect(resolveOptions({
    ...args,
    publicUrlChecksJson: JSON.stringify([
      { name: "launch", output: "launch_url", path: "/healthz" },
    ]),
  }, environment)).rejects.toThrow(
    "destroyExpectation must explicitly select http-404 or not-verifiable",
  );
  await expect(resolveOptions({
    ...args,
    publicUrlChecksJson: JSON.stringify([
      {
        name: "launch",
        output: "launch_url",
        path: "/healthz",
        destroyExpectation: { kind: "not-verifiable" },
      },
    ]),
  }, environment)).rejects.toThrow(
    "not-verifiable destroyExpectation requires a bounded reason",
  );
});

test("configured public URL lifecycle checks require a distinct Apply presence status", async () => {
  const args = {
    dryRun: true,
    url: "https://app-staging.takosumi.com",
    workspace: "@scratch",
    cloudflareConnectionMode: "none",
    verificationMode: "opentofu",
    outputAllowlistJson: JSON.stringify({
      launch_url: { from: "launch_url", type: "url", required: true },
    }),
  } as const;
  const environment = {
    TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
  };

  for (const expectedStatus of [404, 410]) {
    await expect(resolveOptions({
      ...args,
      publicUrlChecksJson: JSON.stringify([
        {
          name: "launch",
          output: "launch_url",
          path: "/healthz",
          expectedStatus,
          destroyExpectation: { kind: "http-404" },
        },
      ]),
    }, environment)).rejects.toThrow(
      "expectedStatus must prove presence and cannot be 404 or 410",
    );
  }

  let connectorCalls = 0;
  await expect(assertConfiguredPublicUrls(
    {
      publicUrlChecks: [{
        ...PUBLIC_URL_CHECK_FIXTURE,
        expectedStatus: 404,
      }],
    } as never,
    { launch_url: "https://public.takos.jp" },
    {
      resolver: resolvePublicDns,
      connector: async () => {
        connectorCalls += 1;
        return new Response("always absent", { status: 404 });
      },
    },
  )).rejects.toThrow(
    "expectedStatus must prove presence and cannot be 404 or 410",
  );
  expect(connectorCalls).toBe(0);
});

test("platform control-plane smoke only reads provider verification Outputs through explicit projection names", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
      appName: "explicit-runtime",
      cloudflareConnectionMode: "guided",
      verificationMode: "cloudflare-worker",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
      outputAllowlistJson: JSON.stringify({
        endpoint_for_probe: {
          from: "arbitrary_endpoint",
          type: "url",
          required: true,
        },
        resource_for_probe: {
          from: "arbitrary_resource_name",
          type: "string",
          required: true,
        },
      }),
      runtimePublicUrlOutput: "endpoint_for_probe",
      cloudflareWorkerNameOutput: "resource_for_probe",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );

  expect(options.runtimePublicUrlOutput).toBe("endpoint_for_probe");
  expect(options.cloudflareWorkerNameOutput).toBe("resource_for_probe");
  expect(dryRunResult(options).inputs).toMatchObject({
    runtimePublicUrlOutput: "endpoint_for_probe",
    cloudflareWorkerNameOutput: "resource_for_probe",
  });
});

test("platform control-plane smoke rejects implicit or mistyped provider verification Output mappings", async () => {
  const base = {
    dryRun: true,
    url: "https://app-staging.takosumi.com",
    workspace: "@scratch",
    cloudflareConnectionMode: "none",
    verificationMode: "opentofu",
    outputAllowlistJson: JSON.stringify({
      endpoint_for_probe: { from: "endpoint", type: "url", required: true },
    }),
  } as const;

  await expect(
    resolveOptions(
      { ...base, runtimePublicUrlOutput: "unlisted_endpoint" },
      { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
    ),
  ).rejects.toThrow(
    "--runtime-public-url-output must also be in the output allowlist",
  );
  await expect(
    resolveOptions(
      {
        ...base,
        cloudflareWorkerNameOutput: "endpoint_for_probe",
      },
      { TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token" },
    ),
  ).rejects.toThrow(
    "--cloudflare-worker-name-output must reference an output projected as string",
  );
});

test("platform control-plane smoke rejects untyped output allowlist entries before live API calls", async () => {
  await expect(
    resolveOptions(
      {
        dryRun: true,
        url: "https://app-staging.takosumi.com",
        workspace: "@scratch",
        appName: "takosumi-untyped-output-test",
        cloudflareConnectionMode: "none",
        verificationMode: "opentofu",
        outputAllowlistJson: JSON.stringify({
          launch_url: { from: "launch_url", required: true },
        }),
      },
      {
        TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      },
    ),
  ).rejects.toThrow(
    "output allowlist launch_url.type must be one of string, url, hostname, number, boolean, json",
  );
});

test("platform control-plane smoke selects InstallConfig from explicit structure, not ids or retired aliases", () => {
  expect(
    isSelectableCapsuleInstallConfig({
      id: "icfg_0123456789abcdef",
      workspaceId: "ws_current",
      name: "workspace config",
    }),
  ).toBe(true);
  expect(
    isSelectableCapsuleInstallConfig({
      id: "any-id-shape",
      internal: { reason: "per_install_overrides" },
      name: "internal override",
    }),
  ).toBe(false);
  expect(
    isSelectableCapsuleInstallConfig({
      id: "generic-opentofu-capsule",
      name: "Generic OpenTofu Capsule",
    }),
  ).toBe(true);

  expect(
    selectSmokeInstallConfigId([
      { id: "workspace-config", workspaceId: "ws_current" },
    ]),
  ).toBe("workspace-config");
  expect(
    selectSmokeInstallConfigId([{ id: "one" }, { id: "two" }], "two"),
  ).toBe("two");
  expect(() =>
    selectSmokeInstallConfigId([{ id: "one" }, { id: "two" }]),
  ).toThrow(
    "multiple selectable Capsule install configs are available; set --install-config-id explicitly",
  );
});

test("platform control-plane smoke uses configured public checks for app Workers", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
      appName: "takos-app-public-url-test",
      cloudflareConnectionMode: "generic-env",
      verificationMode: "cloudflare-worker",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
      outputAllowlistJson: JSON.stringify({
        url: { from: "url", type: "url", required: true },
        worker_name: { from: "worker_name", type: "string", required: true },
      }),
      publicUrlChecksJson: JSON.stringify([
        {
          name: "health",
          output: "url",
          path: "/health",
          expectedStatus: 200,
          bodyIncludes: ['"status":"ok"'],
          destroyExpectation: { kind: "http-404" },
        },
      ]),
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );

  const result = dryRunResult(options);

  expect(result.steps).toContain("runtimeVerified");
  expect(result.steps).toContain("publicUrlVerified");
  expect(result.publicUrlVerified).toBe(true);
  expect(result.publicUrlChecks).toEqual([
    {
      name: "health",
      output: "url",
      url: "https://example.invalid/health",
      status: 200,
      ok: true,
      bodyIncludes: ['"status":"ok"'],
      bodyDigest: `sha256:${"0".repeat(64)}`,
      destroyExpectation: { kind: "http-404" },
    },
  ]);
});

test("platform control-plane smoke does not infer Cloudflare resource verification from ordinary Outputs", async () => {
  const options = await resolveOptions(
    {
      dryRun: true,
      url: "https://app-staging.takosumi.com",
      workspace: "@scratch",
      appName: "takos-opentofu-public-url-test",
      cloudflareConnectionMode: "guided",
      verificationMode: "opentofu",
      cloudflareAccountId: "account",
      cloudflareWorkersSubdomain: "takosumi-smoke",
      outputAllowlistJson: JSON.stringify({
        url: { from: "url", type: "url", required: true },
        worker_name: { from: "worker_name", type: "string", required: true },
      }),
      publicUrlChecksJson: JSON.stringify([
        {
          name: "health",
          output: "url",
          path: "/health",
          expectedStatus: 200,
          bodyIncludes: ['"status":"ok"'],
          destroyExpectation: {
            kind: "not-verifiable",
            reason: "the stable routing origin outlives this Capsule",
          },
        },
      ]),
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
    },
  );

  const result = dryRunResult(options);

  expect(result.steps).toEqual([
    "workspaceScopedProviderConnection",
    "connectionVerified",
    "sourceRegistered",
    "sourceSynced",
    "scratchInstall",
    "compatibilityChecked",
    "plan",
    "apply",
    "opentofuApplyVerified",
    "stateVersionLedgerVerified",
    "publicUrlVerified",
    "destroy",
    "connectionRevoked",
  ]);
  expect(result.workerUrl).toBe("");
  expect(result.runtimeVerified).toBe(false);
  expect(result.publicUrlVerified).toBe(true);
  expect(result.destroyVerified).toBe(false);
  expect(result.inputs.publicUrlDestroyExpectations).toEqual([
    {
      name: "health",
      expectation: {
        kind: "not-verifiable",
        reason: "the stable routing origin outlives this Capsule",
      },
    },
  ]);
  expect(result.publicUrlDestroyChecks).toEqual([
    {
      name: "health",
      output: "url",
      url: "https://example.invalid/health",
      expectation: {
        kind: "not-verifiable",
        reason: "the stable routing origin outlives this Capsule",
      },
      applyStatus: "planned",
      status: "not_claimed",
    },
  ]);
});

test("platform control-plane smoke cleanup only marks failed pending upload remnants", () => {
  expect(
    shouldMarkPendingSmokeCapsuleError(
      {
        id: "inst_pending",
        name: "takosumi-smoke-test",
        status: "pending",
        currentStateGeneration: 0,
      },
      "takosumi-smoke-test",
    ),
  ).toBe(true);
  expect(
    shouldMarkPendingSmokeCapsuleError(
      {
        id: "inst_active",
        name: "takosumi-smoke-test",
        status: "active",
        currentStateGeneration: 1,
      },
      "takosumi-smoke-test",
    ),
  ).toBe(false);
  expect(
    shouldMarkPendingSmokeCapsuleError(
      {
        id: "inst_other",
        name: "other-app",
        status: "pending",
        currentStateGeneration: 0,
      },
      "takosumi-smoke-test",
    ),
  ).toBe(false);
});

async function runConfiguredPublicUrlLifecycleFixture(
  destroyExpectation:
    | { readonly kind: "http-404" }
    | { readonly kind: "not-verifiable"; readonly reason: string },
  behavior: {
    readonly failReadyCheckBeforeDestroy?: boolean;
    readonly failHealthCheckAfterDestroy?: boolean;
    readonly invalidReadyOutput?: boolean;
    readonly applyFails?: boolean;
    readonly applyPollNeverTerminal?: boolean;
    readonly destroyPlanFails?: boolean;
    readonly destroyApplyFails?: boolean;
    readonly applyAcknowledgement?: "transport-loss" | "timeout";
    readonly reconcileApply?: boolean;
    readonly ambiguousApplyReconciliation?: boolean;
    readonly temporaryConnection?: boolean;
  } = {},
) {
  const appName = "takosumi-configured-public-url-lifecycle";
  const workspaceId = "ws_configuredpublicurl";
  const capsuleId = "cap_configured_public_url";
  const sourceId = "src_configured_public_url";
  const sourceSnapshotId = "snap_configured_public_url";
  const stateVersionId = "state_configured_public_url";
  const outputId = "out_configured_public_url";
  const rawConnectionId = "conn_configured_public_url";
  const providerConnectionId = "pcn_configured_public_url";
  const runs = {
    sync: {
      id: "run_sync_configured_public_url",
      status: "succeeded",
      type: "source_sync",
      sourceSnapshotId,
    },
    planWaiting: {
      id: "run_plan_configured_public_url",
      status: "waiting_approval",
      type: "plan",
    },
    planSucceeded: {
      id: "run_plan_configured_public_url",
      status: "succeeded",
      type: "plan",
    },
    applySucceeded: {
      id: "run_apply_configured_public_url",
      workspaceId,
      capsuleId,
      planRunId: "run_plan_configured_public_url",
      status: "succeeded",
      type: "apply",
    },
    applyFailed: {
      id: "run_apply_failed_configured_public_url",
      workspaceId,
      capsuleId,
      planRunId: "run_plan_configured_public_url",
      status: "failed",
      type: "apply",
    },
    applyRunning: {
      id: "run_apply_configured_public_url",
      workspaceId,
      capsuleId,
      planRunId: "run_plan_configured_public_url",
      status: "running",
      type: "apply",
    },
    destroyPlan: {
      id: "run_destroy_plan_configured_public_url",
      status: "waiting_approval",
      type: "destroy",
    },
    destroyApply: {
      id: "run_destroy_apply_configured_public_url",
      status: "succeeded",
      type: "destroy",
    },
    destroyApplyFailed: {
      id: "run_destroy_apply_configured_public_url",
      status: "failed",
      type: "destroy",
    },
  } as const;
  const options = await resolveOptions(
    {
      url: "https://app-staging.takosumi.com",
      workspace: workspaceId,
      appName,
      sourceGitUrl: "https://git.example.test/configured-public-url.git",
      cloudflareConnectionMode: behavior.temporaryConnection
        ? "guided"
        : "none",
      ...(behavior.temporaryConnection
        ? {
            cloudflareAccountId: "account-configured-public-url",
            cloudflareWorkersSubdomain: "workers.example.test",
          }
        : {}),
      verificationMode: "opentofu",
      noInterfaceProof: true,
      outputAllowlistJson: JSON.stringify({
        launch_url: { from: "launch_url", type: "url", required: true },
        ready_url: { from: "ready_url", type: "url", required: true },
      }),
      publicUrlChecksJson: JSON.stringify([
        {
          name: "health",
          output: "launch_url",
          path: "/healthz",
          expectedStatus: 200,
          bodyIncludes: ["ok"],
          destroyExpectation,
        },
        {
          name: "ready",
          output: "ready_url",
          path: "/readyz",
          expectedStatus: 200,
          bodyIncludes: ["ok"],
          destroyExpectation,
        },
      ]),
      timeoutSeconds: "1",
      deployTimeoutSeconds: "1",
      pollIntervalMs: behavior.applyPollNeverTerminal ? "100" : "1",
      expectedServiceIdentityHeader: "x-release-revision",
      expectedServiceIdentity: "release-configured-public-url",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      ...(behavior.temporaryConnection
        ? { CLOUDFLARE_API_TOKEN: "cloudflare-token" }
        : {}),
    },
  );
  let destroyed = false;
  let controlPlaneResolverCalls = 0;
  let publicResolverCalls = 0;
  const controlPlaneRequests: Array<{
    readonly address: string;
    readonly servername: string;
    readonly method: string;
    readonly path: string;
  }> = [];
  const publicRequests: Array<{
    readonly address: string;
    readonly servername: string;
    readonly path: string;
  }> = [];

  const result = await runPlatformControlPlaneSmoke(options, {
    controlPlaneResolver: async () => {
      controlPlaneResolverCalls += 1;
      return controlPlaneResolverCalls === 1
        ? [
            { address: "93.184.216.35", family: 4 as const },
            { address: "93.184.216.34", family: 4 as const },
          ]
        : [
            { address: "93.184.216.37", family: 4 as const },
            { address: "93.184.216.36", family: 4 as const },
          ];
    },
    resolver: async () => {
      publicResolverCalls += 1;
      return [
        { address: "93.184.216.37", family: 4 as const },
        { address: "93.184.216.36", family: 4 as const },
      ];
    },
    connector: async (request) => {
      publicRequests.push(request);
      if (
        !destroyed &&
        behavior.failReadyCheckBeforeDestroy === true &&
        request.path === "/readyz"
      ) {
        return new Response("not ready", { status: 503 });
      }
      if (
        destroyed &&
        behavior.failHealthCheckAfterDestroy === true &&
        request.path === "/healthz"
      ) {
        return new Response("still here", { status: 503 });
      }
      return new Response(destroyed ? "gone" : "ok", {
        status: destroyed ? 404 : 200,
      });
    },
    sleep: async () => {},
    maxAttempts: 1,
    ...(behavior.applyAcknowledgement === "timeout"
      ? { requestTimeoutMs: 20 }
      : {}),
    controlPlaneConnector: async (request) => {
      controlPlaneRequests.push(request);
      const path = new URL(request.path, options.url).pathname;
      const method = request.method;
      if (method === "GET" && path === "/") {
        return new Response("identity", {
          status: 200,
          headers: { "x-release-revision": "release-configured-public-url" },
        });
      }
      if (method === "POST" && path === "/api/v1/connections") {
        return Response.json({ connection: { id: rawConnectionId } });
      }
      if (
        method === "POST" &&
        path === `/api/v1/connections/${rawConnectionId}/test`
      ) {
        return Response.json({ status: "verified" });
      }
      if (method === "GET" && path === "/api/v1/provider-connections") {
        return Response.json({
          providerConnections: [{
            id: providerConnectionId,
            providerSource: "registry.opentofu.org/cloudflare/cloudflare",
            displayName: `Layer-2 smoke ${appName}`,
          }],
        });
      }
      if (method === "POST" && path === "/api/v1/sources") {
        return Response.json({ source: { id: sourceId } });
      }
      if (method === "POST" && path === `/api/v1/sources/${sourceId}/sync`) {
        return Response.json({ run: runs.sync });
      }
      if (method === "GET" && path === `/api/v1/runs/${runs.sync.id}`) {
        return Response.json({ run: runs.sync });
      }
      if (method === "GET" && path === `/api/v1/sources/${sourceId}/snapshots`) {
        return Response.json({
          snapshots: [{
            id: sourceSnapshotId,
            resolvedCommit: "a".repeat(40),
            archiveRef: "r2://fixture/source.tar.zst",
            archiveDigest: `sha256:${"b".repeat(64)}`,
            archiveSizeBytes: 1,
            fetchedByRunId: runs.sync.id,
          }],
        });
      }
      if (method === "GET" && path === "/api/v1/capsule-configs") {
        return Response.json({
          installConfigs: [{ id: "cfg_configured_public_url", workspaceId }],
        });
      }
      if (method === "POST" && path === `/api/v1/sources/${sourceId}/compatibility-check`) {
        const reportId = "caprep_configured_public_url";
        return Response.json({
          report: {
            id: reportId,
            level: "ready",
            rootProviderRequirements: behavior.temporaryConnection
              ? [{
                  source: "registry.opentofu.org/cloudflare/cloudflare",
                  moduleLocalName: "cloudflare",
                }]
              : [],
          },
          run: {
            id: "ccr_configured_public_url",
            type: "compatibility_check",
            status: "succeeded",
            compatibilityReportId: reportId,
          },
          repositoryInstallUx: { status: "absent" },
        });
      }
      if (
        method === "POST" &&
        path === `/api/v1/workspaces/${workspaceId}/install-plans`
      ) {
        return Response.json({
          installPlan: { id: "gip_configured_public_url", phase: "creating_capsule" },
          nextAction: "reconcile",
        }, { status: 201 });
      }
      if (
        method === "POST" &&
        path === "/api/v1/install-plans/gip_configured_public_url/reconcile"
      ) {
        return Response.json({
          installPlan: {
            id: "gip_configured_public_url",
            phase: "reviewable",
            capsuleId,
            installConfigId: "icfg_configured_public_url",
            planRunId: runs.planWaiting.id,
          },
          nextAction: "review_run",
        });
      }
      if (method === "GET" && path === `/api/v1/runs/${runs.planWaiting.id}`) {
        return Response.json({ run: runs.planWaiting });
      }
      if (method === "POST" && path === `/api/v1/runs/${runs.planWaiting.id}/approve`) {
        return Response.json({ run: runs.planSucceeded });
      }
      if (method === "POST" && path === `/api/v1/runs/${runs.planWaiting.id}/apply`) {
        if (behavior.applyAcknowledgement === "timeout") {
          return await new Promise<Response>(() => {});
        }
        if (behavior.applyAcknowledgement === "transport-loss") {
          throw new Error("fixture process lost the Apply acknowledgement");
        }
        return Response.json({
          run: behavior.applyPollNeverTerminal
            ? runs.applyRunning
            : behavior.applyFails
              ? runs.applyFailed
              : runs.applySucceeded,
        });
      }
      if (
        method === "GET" &&
        path === `/api/v1/workspaces/${workspaceId}/runs`
      ) {
        return Response.json({
          runs: behavior.reconcileApply === false
            ? []
            : [
                {
                  ...runs.applySucceeded,
                  workspaceId,
                  capsuleId,
                  planRunId: runs.planSucceeded.id,
                },
                ...(behavior.ambiguousApplyReconciliation
                  ? [{
                      ...runs.applySucceeded,
                      id: "run_apply_duplicate_configured_public_url",
                      workspaceId,
                      capsuleId,
                      planRunId: runs.planSucceeded.id,
                    }]
                  : []),
              ],
        });
      }
      if (method === "GET" && path === `/api/v1/runs/${runs.applySucceeded.id}`) {
        return Response.json({
          run: behavior.applyPollNeverTerminal
            ? runs.applyRunning
            : runs.applySucceeded,
        });
      }
      if (
        behavior.applyPollNeverTerminal &&
        method === "POST" &&
        path === `/api/v1/runs/${runs.applyRunning.id}/cancel`
      ) {
        return Response.json({ run: runs.applyRunning });
      }
      if (method === "GET" && path === `/api/v1/runs/${runs.applyFailed.id}`) {
        return Response.json({ run: runs.applyFailed });
      }
      if (method === "GET" && path === `/api/v1/capsules/${capsuleId}`) {
        return Response.json({
          capsule: {
            id: capsuleId,
            workspaceId,
            status: "active",
            currentStateVersionId: stateVersionId,
            currentStateGeneration: 1,
          },
        });
      }
      if (method === "GET" && path === `/api/v1/capsules/${capsuleId}/state-versions`) {
        return Response.json({
          stateVersions: [{
            id: stateVersionId,
            workspaceId,
            capsuleId,
            environment: options.environment,
            createdByRunId: runs.applySucceeded.id,
            generation: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
          }],
        });
      }
      if (method === "GET" && path === `/api/v1/capsules/${capsuleId}/outputs`) {
        return Response.json({
          output: {
            id: outputId,
            workspaceId,
            capsuleId,
            stateGeneration: 1,
            publicOutputs: {
              launch_url: options.url,
              ready_url: behavior.invalidReadyOutput
                ? "http://private.invalid"
                : options.url,
            },
            outputDigest: `sha256:${"c".repeat(64)}`,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        });
      }
      if (method === "POST" && path === `/api/v1/capsules/${capsuleId}/destroy-plan`) {
        if (behavior.destroyPlanFails) {
          throw new Error("fixture destroy plan failed before URL verification");
        }
        return Response.json({ run: runs.destroyPlan });
      }
      if (method === "GET" && path === `/api/v1/runs/${runs.destroyPlan.id}`) {
        return Response.json({ run: runs.destroyPlan });
      }
      if (method === "POST" && path === `/api/v1/runs/${runs.destroyPlan.id}/approve`) {
        return Response.json({});
      }
      if (method === "POST" && path === `/api/v1/runs/${runs.destroyPlan.id}/apply`) {
        destroyed = !behavior.destroyApplyFails;
        return Response.json({
          run: behavior.destroyApplyFails
            ? runs.destroyApplyFailed
            : runs.destroyApply,
        });
      }
      if (method === "GET" && path === `/api/v1/runs/${runs.destroyApply.id}`) {
        return Response.json({
          run: behavior.destroyApplyFails
            ? runs.destroyApplyFailed
            : runs.destroyApply,
        });
      }
      if (
        method === "POST" &&
        path === `/api/v1/connections/${rawConnectionId}/revoke`
      ) {
        return Response.json({});
      }
      if (method === "PATCH" && path === `/api/v1/capsules/${capsuleId}`) {
        throw new Error("indeterminate Apply must retain the Capsule for recovery");
      }
      throw new Error(`unexpected lifecycle request ${method} ${request.path}`);
    },
  });
  return {
    result,
    controlPlaneResolverCalls,
    publicResolverCalls,
    controlPlaneRequests,
    publicRequests,
    rawConnectionId,
    providerConnectionId,
    runs,
  };
}

test("generic OpenTofu smoke verifies every configured URL absent after Destroy", async () => {
  const fixture = await runConfiguredPublicUrlLifecycleFixture({
    kind: "http-404",
  });

  expect(fixture.result.error).toBeUndefined();
  expect(fixture.result.status).toBe("passed");
  expect(fixture.result.destroyVerified).toBe(true);
  expect(fixture.result.publicUrlDestroyChecks).toEqual([
    {
      name: "health",
      output: "launch_url",
      url: "https://app-staging.takosumi.com/healthz",
      expectation: { kind: "http-404" },
      applyStatus: "passed",
      status: "passed",
      observedStatus: 404,
    },
    {
      name: "ready",
      output: "ready_url",
      url: "https://app-staging.takosumi.com/readyz",
      expectation: { kind: "http-404" },
      applyStatus: "passed",
      status: "passed",
      observedStatus: 404,
    },
  ]);
  expect(fixture.controlPlaneResolverCalls).toBe(1);
  expect(fixture.publicResolverCalls).toBe(0);
  expect(fixture.controlPlaneRequests.length).toBeGreaterThan(10);
  expect(fixture.controlPlaneRequests.some((request) =>
    request.method === "POST" &&
    request.path === "/api/v1/workspaces/ws_configuredpublicurl/install-plans"
  )).toBe(true);
  expect(fixture.controlPlaneRequests.some((request) =>
    request.path.includes("/provider-bindings") ||
    /\/capsules\/[^/]+\/plan$/u.test(request.path)
  )).toBe(false);
  expect(fixture.controlPlaneRequests.some((request) =>
    request.method === "PUT"
  )).toBe(false);
  expect(fixture.publicRequests).toHaveLength(4);
  expect([
    ...fixture.controlPlaneRequests,
    ...fixture.publicRequests,
  ].every((request) =>
    request.address === "93.184.216.34" &&
    request.servername === "app-staging.takosumi.com"
  )).toBe(true);
});

test("generic OpenTofu cleanup checks every registered URL and does not claim a failed Apply probe", async () => {
  const fixture = await runConfiguredPublicUrlLifecycleFixture(
    { kind: "http-404" },
    { failReadyCheckBeforeDestroy: true },
  );

  expect(fixture.result.status).toBe("failed");
  expect(fixture.result.publicUrlVerified).toBe(false);
  expect(fixture.result.publicUrlChecks?.map((check) => check.name)).toEqual([
    "health",
  ]);
  expect(fixture.result.publicUrlDestroyChecks).toEqual([
    {
      name: "health",
      output: "launch_url",
      url: "https://app-staging.takosumi.com/healthz",
      expectation: { kind: "http-404" },
      status: "passed",
      applyStatus: "passed",
      observedStatus: 404,
    },
    {
      name: "ready",
      output: "ready_url",
      url: "https://app-staging.takosumi.com/readyz",
      expectation: { kind: "http-404" },
      status: "inconclusive",
      applyStatus: "unverified",
      observedStatus: 404,
      error:
        "Apply existence proof was not established: public URL check ready returned HTTP 503; expected 200",
    },
  ]);
  expect(fixture.result.destroyVerified).toBe(false);
  expect(fixture.result.completedSteps).not.toContain("destroy");
  expect(fixture.publicRequests.map((request) => request.path)).toEqual([
    "/healthz",
    "/readyz",
    "/healthz",
    "/readyz",
  ]);
  expect(fixture.controlPlaneResolverCalls).toBe(1);
  expect(fixture.publicResolverCalls).toBe(0);
  expect(fixture.publicRequests.every((request) =>
    request.address === "93.184.216.34" &&
    request.servername === "app-staging.takosumi.com"
  )).toBe(true);
});

test("generic OpenTofu Destroy verification records every URL after one absence check fails", async () => {
  const fixture = await runConfiguredPublicUrlLifecycleFixture(
    { kind: "http-404" },
    { failHealthCheckAfterDestroy: true },
  );

  expect(fixture.result.status).toBe("failed");
  expect(fixture.result.destroyVerified).toBe(false);
  expect(fixture.result.publicUrlDestroyChecks).toEqual([
    expect.objectContaining({
      name: "health",
      applyStatus: "passed",
      status: "inconclusive",
    }),
    expect.objectContaining({
      name: "ready",
      applyStatus: "passed",
      status: "passed",
      observedStatus: 404,
    }),
  ]);
  expect(fixture.publicRequests.map((request) => request.path)).toEqual([
    "/healthz",
    "/readyz",
    "/healthz",
    "/readyz",
  ]);
});

test("generic OpenTofu registers every configured URL before probing and fails closed on an invalid applied URL", async () => {
  const fixture = await runConfiguredPublicUrlLifecycleFixture(
    { kind: "http-404" },
    { invalidReadyOutput: true },
  );

  expect(fixture.result.status).toBe("failed");
  expect(fixture.result.publicUrlChecks).toBeUndefined();
  expect(fixture.result.publicUrlDestroyChecks).toEqual([
    {
      name: "health",
      output: "launch_url",
      url: "https://app-staging.takosumi.com/healthz",
      expectation: { kind: "http-404" },
      status: "inconclusive",
      applyStatus: "unverified",
      observedStatus: 404,
      error:
        "Apply existence proof was not established: URL checks were not started because at least one configured applied URL was invalid",
    },
    {
      name: "ready",
      output: "ready_url",
      expectation: { kind: "http-404" },
      status: "inconclusive",
      applyStatus: "unverified",
      error:
        "public URL check ready URL output must be an absolute HTTPS URL without credentials, port, query, or fragment",
    },
  ]);
  expect(fixture.result.destroyVerified).toBe(false);
  expect(fixture.result.completedSteps).not.toContain("destroy");
  expect(fixture.publicRequests.map((request) => request.path)).toEqual([
    "/healthz",
  ]);
});

test("generic OpenTofu cleanup keeps every configured URL explicitly unresolved when Apply fails before Outputs", async () => {
  const fixture = await runConfiguredPublicUrlLifecycleFixture(
    { kind: "http-404" },
    { applyFails: true },
  );

  expect(fixture.result.status).toBe("failed");
  expect(fixture.result.error).toContain(
    `apply run ${fixture.runs.applyFailed.id} ended as failed`,
  );
  expect(fixture.result.publicUrlChecks).toBeUndefined();
  expect(fixture.result.publicUrlDestroyChecks).toEqual([
    {
      name: "health",
      output: "launch_url",
      expectation: { kind: "http-404" },
      applyStatus: "unverified",
      status: "inconclusive",
      error: "Output ledger did not expose publicOutputs for URL checks",
    },
    {
      name: "ready",
      output: "ready_url",
      expectation: { kind: "http-404" },
      applyStatus: "unverified",
      status: "inconclusive",
      error: "Output ledger did not expose publicOutputs for URL checks",
    },
  ]);
  expect(fixture.result.destroyVerified).toBe(false);
  expect(fixture.result.completedSteps).not.toContain("destroy");
  expect(fixture.publicRequests).toHaveLength(0);
});

test("generic OpenTofu cleanup materializes every configured URL when Destroy planning fails", async () => {
  const fixture = await runConfiguredPublicUrlLifecycleFixture(
    { kind: "http-404" },
    { destroyPlanFails: true, temporaryConnection: true },
  );

  expect(fixture.result.status).toBe("failed");
  expect(fixture.result.destroyVerified).toBe(false);
  expect(fixture.result.publicUrlDestroyChecks).toEqual([
    expect.objectContaining({
      name: "health",
      output: "launch_url",
      url: "https://app-staging.takosumi.com/healthz",
      expectation: { kind: "http-404" },
      applyStatus: "passed",
      status: "inconclusive",
    }),
    expect.objectContaining({
      name: "ready",
      output: "ready_url",
      url: "https://app-staging.takosumi.com/readyz",
      expectation: { kind: "http-404" },
      applyStatus: "passed",
      status: "inconclusive",
    }),
  ]);
  expect(fixture.result.publicUrlDestroyChecks?.every((check) =>
    check.error?.includes("Destroy absence verification was not completed")
  )).toBe(true);
  expect(fixture.result.failureCleanup).toMatchObject({
    attempted: true,
    destroyAttempted: true,
    destroyApplyAttempted: false,
    destroySucceeded: false,
    destroyVerification: {
      status: "inconclusive",
      publicUrlDestroyChecks: fixture.result.publicUrlDestroyChecks,
    },
  });
  expect(fixture.result.connectionRevoked).toBe(false);
});

test("generic OpenTofu cleanup materializes every configured URL when Destroy apply fails", async () => {
  const fixture = await runConfiguredPublicUrlLifecycleFixture(
    { kind: "http-404" },
    { destroyApplyFails: true, temporaryConnection: true },
  );

  expect(fixture.result.status).toBe("failed");
  expect(fixture.result.destroyVerified).toBe(false);
  expect(fixture.result.publicUrlDestroyChecks).toHaveLength(2);
  expect(fixture.result.publicUrlDestroyChecks?.every((check) =>
    check.status === "inconclusive" &&
    check.applyStatus === "passed" &&
    check.error?.includes("Destroy absence verification was not completed")
  )).toBe(true);
  expect(fixture.result.failureCleanup).toMatchObject({
    attempted: true,
    destroyAttempted: true,
    destroyApplyAttempted: true,
    destroySucceeded: false,
    destroyVerification: {
      status: "inconclusive",
      publicUrlDestroyChecks: fixture.result.publicUrlDestroyChecks,
    },
  });
  expect(fixture.result.connectionRevoked).toBe(false);
});

test("platform smoke retains recovery authority and URL evidence when Apply cancellation stays non-terminal", async () => {
  const fixture = await runConfiguredPublicUrlLifecycleFixture(
    { kind: "http-404" },
    { applyPollNeverTerminal: true, temporaryConnection: true },
  );

  expect(fixture.result.status).toBe("failed");
  expect(fixture.result.timedOutRunId).toBe(fixture.runs.applyRunning.id);
  expect(fixture.result.runCancellationStatus).toBe("failed");
  expect(fixture.result.runCancellationError).toContain(
    "cancel returned non-terminal status running",
  );
  expect(fixture.result.destroyPlanRunId).toBeUndefined();
  expect(fixture.result.destroyApplyRunId).toBeUndefined();
  expect(fixture.result.destroyVerified).toBe(false);
  expect(fixture.result.publicUrlDestroyChecks).toEqual([
    expect.objectContaining({
      name: "health",
      output: "launch_url",
      applyStatus: "unverified",
      status: "inconclusive",
    }),
    expect.objectContaining({
      name: "ready",
      output: "ready_url",
      applyStatus: "unverified",
      status: "inconclusive",
    }),
  ]);
  expect(fixture.result.failureCleanup).toMatchObject({
    attempted: true,
    destroyAttempted: false,
    retainedForOperatorRecovery: true,
    destroyVerification: {
      status: "inconclusive",
      publicUrlDestroyChecks: fixture.result.publicUrlDestroyChecks,
    },
  });
  expect(fixture.result.failureCleanup).not.toHaveProperty("destroySucceeded");
  expect(fixture.result.connectionRevoked).toBe(false);
  expect(fixture.result.connectionRevokeSkippedReason).toContain(
    "terminal ownership",
  );
  expect(fixture.controlPlaneRequests.some((request) =>
    request.method === "POST" && request.path.endsWith("/destroy-plan")
  )).toBe(false);
  expect(fixture.controlPlaneRequests.some((request) =>
    request.method === "POST" &&
    request.path === `/api/v1/connections/${fixture.rawConnectionId}/revoke`
  )).toBe(false);
});

test("platform smoke reconciles the exact ApplyRun after process loss drops the POST acknowledgement", async () => {
  const fixture = await runConfiguredPublicUrlLifecycleFixture(
    { kind: "http-404" },
    {
      applyAcknowledgement: "transport-loss",
      temporaryConnection: true,
    },
  );

  expect(fixture.result.status).toBe("passed");
  expect(fixture.result.applyRunId).toBe(fixture.runs.applySucceeded.id);
  expect(fixture.result.destroyVerified).toBe(true);
  expect(fixture.result.connectionRevoked).toBe(true);
  expect(fixture.controlPlaneRequests.filter((request) =>
    request.method === "POST" &&
    request.path ===
      `/api/v1/runs/${fixture.runs.planSucceeded.id}/apply`
  )).toHaveLength(1);
  expect(fixture.controlPlaneRequests.filter((request) =>
    request.method === "GET" &&
    request.path ===
      "/api/v1/workspaces/ws_configuredpublicurl/runs?limit=500"
  )).toHaveLength(1);
  expect(fixture.controlPlaneRequests.filter((request) =>
    request.method === "POST" &&
    request.path ===
      `/api/v1/connections/${fixture.rawConnectionId}/revoke`
  )).toHaveLength(1);
});

test("platform smoke reconciles Apply after a non-cooperative POST exceeds its response deadline", async () => {
  const smoke = runConfiguredPublicUrlLifecycleFixture(
    { kind: "http-404" },
    {
      applyAcknowledgement: "timeout",
      temporaryConnection: true,
    },
  );
  const outcome = await Promise.race([
    smoke,
    new Promise<"test-deadline">((resolve) =>
      setTimeout(() => resolve("test-deadline"), 500)
    ),
  ]);

  expect(outcome).not.toBe("test-deadline");
  const fixture = outcome as Awaited<typeof smoke>;
  expect(fixture.result.status).toBe("passed");
  expect(fixture.result.applyRunId).toBe(fixture.runs.applySucceeded.id);
  expect(fixture.result.destroyVerified).toBe(true);
  expect(fixture.result.connectionRevoked).toBe(true);
  expect(fixture.controlPlaneRequests.filter((request) =>
    request.method === "POST" &&
    request.path ===
      `/api/v1/runs/${fixture.runs.planSucceeded.id}/apply`
  )).toHaveLength(1);
  expect(fixture.controlPlaneRequests.filter((request) =>
    request.method === "GET" &&
    request.path ===
      "/api/v1/workspaces/ws_configuredpublicurl/runs?limit=500"
  )).toHaveLength(1);
});

test("platform smoke retains recovery authority when a lost Apply acknowledgement cannot be reconciled", async () => {
  const fixture = await runConfiguredPublicUrlLifecycleFixture(
    { kind: "http-404" },
    {
      applyAcknowledgement: "transport-loss",
      reconcileApply: false,
      temporaryConnection: true,
    },
  );

  expect(fixture.result.status).toBe("failed");
  expect(fixture.result.error).toContain(
    "Apply POST acknowledgement was lost and no exact ApplyRun could be reconciled",
  );
  expect(fixture.result.applyRunId).toBeUndefined();
  expect(fixture.result.destroyPlanRunId).toBeUndefined();
  expect(fixture.result.destroyApplyRunId).toBeUndefined();
  expect(fixture.result.destroyVerified).toBe(false);
  expect(fixture.result.connectionRevoked).toBe(false);
  expect(fixture.result.connectionRevokeSkippedReason).toContain(
    "retaining the ProviderConnection for operator recovery",
  );
  expect(fixture.result.nextAction).toContain(
    fixture.runs.planSucceeded.id,
  );
  expect(fixture.controlPlaneRequests.some((request) =>
    request.method === "POST" &&
    request.path.endsWith("/destroy-plan")
  )).toBe(false);
  expect(fixture.controlPlaneRequests.some((request) =>
    request.method === "PATCH" &&
    request.path.includes("/capsules/")
  )).toBe(false);
  expect(fixture.controlPlaneRequests.some((request) =>
    request.method === "POST" &&
    request.path ===
      `/api/v1/connections/${fixture.rawConnectionId}/revoke`
  )).toBe(false);
});

test("platform smoke refuses to guess between multiple Plan-linked ApplyRuns", async () => {
  const fixture = await runConfiguredPublicUrlLifecycleFixture(
    { kind: "http-404" },
    {
      applyAcknowledgement: "transport-loss",
      ambiguousApplyReconciliation: true,
      temporaryConnection: true,
    },
  );

  expect(fixture.result.status).toBe("failed");
  expect(fixture.result.error).toContain(
    "Workspace Run authority returned multiple exact matches",
  );
  expect(fixture.result.applyRunId).toBeUndefined();
  expect(fixture.result.destroyVerified).toBe(false);
  expect(fixture.result.connectionRevoked).toBe(false);
  expect(fixture.controlPlaneRequests.some((request) =>
    request.method === "POST" &&
    request.path.endsWith("/destroy-plan")
  )).toBe(false);
  expect(fixture.controlPlaneRequests.some((request) =>
    request.method === "POST" &&
    request.path ===
      `/api/v1/connections/${fixture.rawConnectionId}/revoke`
  )).toBe(false);
});

test("generic OpenTofu smoke does not claim Destroy when URL absence is not verifiable", async () => {
  const fixture = await runConfiguredPublicUrlLifecycleFixture({
    kind: "not-verifiable",
    reason: "the stable routing origin outlives this Capsule",
  });

  expect(fixture.result.status).toBe("failed");
  expect(fixture.result.destroyVerified).toBe(false);
  expect(fixture.result.completedSteps).not.toContain("destroy");
  expect(fixture.result.publicUrlDestroyChecks).toEqual([
    {
      name: "health",
      output: "launch_url",
      url: "https://app-staging.takosumi.com/healthz",
      expectation: {
        kind: "not-verifiable",
        reason: "the stable routing origin outlives this Capsule",
      },
      applyStatus: "passed",
      status: "not_claimed",
    },
    {
      name: "ready",
      output: "ready_url",
      url: "https://app-staging.takosumi.com/readyz",
      expectation: {
        kind: "not-verifiable",
        reason: "the stable routing origin outlives this Capsule",
      },
      applyStatus: "passed",
      status: "not_claimed",
    },
  ]);
  expect(fixture.result.error).toContain("has no valid absence contract");
  expect(fixture.publicRequests).toHaveLength(2);
});

test("platform smoke keeps a successfully destroyed Capsule terminal when post-destroy Worker verification lacks Outputs", async () => {
  const appName = "takosumi-destroy-output-fixture";
  const rawConnectionId = "conn_destroy_output_fixture";
  const providerConnectionId = "pcn_destroy_output_fixture";
  const capsuleId = "cap_destroy_output_fixture";
  const sourceId = "src_destroy_output_fixture";
  const sourceSnapshotId = "snap_destroy_output_fixture";
  const runRecords = {
    sync: {
      id: "run_sync_destroy_output_fixture",
      status: "succeeded",
      type: "source_sync",
      sourceSnapshotId,
    },
    planWaitingApproval: {
      id: "run_plan_destroy_output_fixture",
      status: "waiting_approval",
      type: "plan",
    },
    planSucceeded: {
      id: "run_plan_destroy_output_fixture",
      status: "succeeded",
      type: "plan",
    },
    applyFailed: {
      id: "run_apply_destroy_output_fixture",
      workspaceId: "ws_destroyoutput",
      capsuleId,
      planRunId: "run_plan_destroy_output_fixture",
      status: "failed",
      type: "apply",
    },
    destroyPlanWaitingApproval: {
      id: "run_destroy_plan_output_fixture",
      status: "waiting_approval",
      type: "destroy",
    },
    destroySucceeded: {
      id: "run_destroy_apply_output_fixture",
      status: "succeeded",
      type: "destroy",
    },
  } as const;
  const options = await resolveOptions(
    {
      url: "https://app-staging.takosumi.com",
      workspace: "ws_destroyoutput",
      appName,
      sourceGitUrl: "https://git.example.test/destroy-output-fixture.git",
      cloudflareConnectionMode: "guided",
      verificationMode: "cloudflare-worker",
      noInterfaceProof: true,
      cloudflareWorkerNameOutput: "service_runtime_name",
      runtimePublicUrlOutput: "launch_url",
      outputAllowlistJson: JSON.stringify({
        launch_url: { from: "launch_url", type: "url", required: true },
        service_runtime_name: {
          from: "service_runtime_name",
          type: "string",
        },
      }),
      publicUrlChecksJson: JSON.stringify([
        {
          name: "launch",
          output: "launch_url",
          path: "/healthz",
          expectedStatus: 200,
          bodyIncludes: ["ok"],
          destroyExpectation: { kind: "http-404" },
        },
      ]),
      timeoutSeconds: "1",
      deployTimeoutSeconds: "1",
      pollIntervalMs: "1",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_ACCOUNT_ID: "account-fixture",
      CLOUDFLARE_WORKERS_SUBDOMAIN: "workers.example.test",
    },
  );
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly body?: string;
  }> = [];
  let controlPlaneResolverCalls = 0;
  const pinnedControlPlaneRequests: Array<{
    readonly address: string;
    readonly servername: string;
  }> = [];
  globalThis.fetch = (async (input, init) => {
    const requestUrl = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url: requestUrl.toString(), ...(body ? { body } : {}) });
    if (requestUrl.origin !== options.url) {
      throw new Error(`unexpected external fixture request: ${requestUrl}`);
    }
    const path = requestUrl.pathname;
    if (method === "POST" && path === "/api/v1/connections") {
      return Response.json({ connection: { id: rawConnectionId } });
    }
    if (
      method === "POST" &&
      path === `/api/v1/connections/${rawConnectionId}/test`
    ) {
      return Response.json({ status: "verified" });
    }
    if (method === "GET" && path === "/api/v1/provider-connections") {
      return Response.json({
        providerConnections: [
          {
            id: providerConnectionId,
            providerSource: "registry.opentofu.org/cloudflare/cloudflare",
            displayName: `Layer-2 smoke ${appName}`,
          },
        ],
      });
    }
    if (method === "POST" && path === "/api/v1/sources") {
      return Response.json({ source: { id: sourceId } });
    }
    if (
      method === "POST" &&
      path === `/api/v1/sources/${sourceId}/sync`
    ) {
      return Response.json({ run: runRecords.sync });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.sync.id}`
    ) {
      return Response.json({ run: runRecords.sync });
    }
    if (
      method === "GET" &&
      path === `/api/v1/sources/${sourceId}/snapshots`
    ) {
      return Response.json({
        snapshots: [
          {
            id: sourceSnapshotId,
            resolvedCommit: "a".repeat(40),
            archiveRef: "r2://fixture/source.tar.zst",
            archiveDigest: `sha256:${"b".repeat(64)}`,
            archiveSizeBytes: 1,
            fetchedByRunId: runRecords.sync.id,
          },
        ],
      });
    }
    if (method === "GET" && path === "/api/v1/capsule-configs") {
      return Response.json({
        installConfigs: [{ id: "cfg_destroy_output_fixture", workspaceId: options.workspace }],
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/sources/${sourceId}/compatibility-check`
    ) {
      const reportId = "caprep_destroy_output_fixture";
      return Response.json({
        report: {
          id: reportId,
          level: "ready",
          rootProviderRequirements: [
            {
              source: "registry.opentofu.org/cloudflare/cloudflare",
              moduleLocalName: "cloudflare",
            },
          ],
        },
        run: {
          id: "ccr_destroy_output_fixture",
          type: "compatibility_check",
          status: "succeeded",
          compatibilityReportId: reportId,
        },
        repositoryInstallUx: { status: "absent" },
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/workspaces/${options.workspace}/install-plans`
    ) {
      return Response.json({
        installPlan: { id: "gip_destroy_output_fixture", phase: "creating_capsule" },
        nextAction: "reconcile",
      }, { status: 201 });
    }
    if (
      method === "POST" &&
      path === "/api/v1/install-plans/gip_destroy_output_fixture/reconcile"
    ) {
      return Response.json({
        installPlan: {
          id: "gip_destroy_output_fixture",
          phase: "reviewable",
          capsuleId,
          installConfigId: "icfg_destroy_output_fixture",
          planRunId: runRecords.planWaitingApproval.id,
        },
        nextAction: "review_run",
      });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}`
    ) {
      const planPolls = requests.filter(
        (request) =>
          request.method === "GET" &&
          request.url.endsWith(`/api/v1/runs/${runRecords.planWaitingApproval.id}`),
      ).length;
      return Response.json({
        run:
          planPolls === 1
            ? runRecords.planWaitingApproval
            : runRecords.planSucceeded,
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}/approve`
    ) {
      return Response.json({ run: runRecords.planSucceeded });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}/apply`
    ) {
      return Response.json({ run: runRecords.applyFailed });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.applyFailed.id}`
    ) {
      return Response.json({ run: runRecords.applyFailed });
    }
    if (
      method === "POST" &&
      path === `/api/v1/capsules/${capsuleId}/destroy-plan`
    ) {
      return Response.json({ run: runRecords.destroyPlanWaitingApproval });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}`
    ) {
      return Response.json({ run: runRecords.destroyPlanWaitingApproval });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}/approve`
    ) {
      return Response.json({});
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}/apply`
    ) {
      return Response.json({ run: runRecords.destroySucceeded });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.destroySucceeded.id}`
    ) {
      return Response.json({ run: runRecords.destroySucceeded });
    }
    if (
      method === "POST" &&
      path === `/api/v1/connections/${rawConnectionId}/revoke`
    ) {
      return Response.json({});
    }
    if (method === "PATCH" && path === `/api/v1/capsules/${capsuleId}`) {
      throw new Error("destroyed Capsule must not be patched to error");
    }
    throw new Error(`unexpected Takosumi fixture request: ${method} ${requestUrl}`);
  }) as typeof fetch;
  try {
    const fixtureTransport = pinnedControlPlaneFixture(
      async (input, init) => await globalThis.fetch(input, init),
    );
    const result = await runPlatformControlPlaneSmoke(
      options,
      {
        ...fixtureTransport,
        controlPlaneResolver: async () => {
          controlPlaneResolverCalls += 1;
          return controlPlaneResolverCalls === 1
            ? [
                { address: "93.184.216.35", family: 4 as const },
                { address: "93.184.216.34", family: 4 as const },
              ]
            : [
                { address: "93.184.216.37", family: 4 as const },
                { address: "93.184.216.36", family: 4 as const },
              ];
        },
        controlPlaneConnector: async (request) => {
          pinnedControlPlaneRequests.push(request);
          return await fixtureTransport.controlPlaneConnector(request);
        },
      },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("apply run run_apply_destroy_output_fixture ended as failed");
    expect(result.capsuleId).toBe(capsuleId);
    expect(result.applyRunId).toBe(runRecords.applyFailed.id);
    expect(result.destroyPlanRunId).toBe(runRecords.destroyPlanWaitingApproval.id);
    expect(result.destroyApplyRunId).toBe(runRecords.destroySucceeded.id);
    expect(result.destroyVerified).toBe(false);
    expect(result.connectionRevoked).toBe(true);
    expect(controlPlaneResolverCalls).toBe(1);
    expect(pinnedControlPlaneRequests.length).toBeGreaterThan(10);
    expect(pinnedControlPlaneRequests.every((request) =>
      request.address === "93.184.216.34" &&
      request.servername === "app-staging.takosumi.com"
    )).toBe(true);
    expect(result.connectionRevokeSkippedReason).toBeUndefined();
    expect(result.failureCleanup).toMatchObject({
      attempted: true,
      cloudflareWorkerGone: false,
      capsuleMarkedError: false,
      destroyAttempted: true,
      destroyPlanRunId: runRecords.destroyPlanWaitingApproval.id,
      destroyApplyRunId: runRecords.destroySucceeded.id,
      destroySucceeded: true,
      destroyVerification: {
        status: "inconclusive",
        cloudflareWorkerGone: false,
      },
    });
    expect(result.failureCleanup?.error).toContain(
      'Cloudflare Worker name output "service_runtime_name" is missing',
    );
    expect(result.publicUrlDestroyChecks).toEqual([
      expect.objectContaining({
        name: "launch",
        output: "launch_url",
        expectation: { kind: "http-404" },
        applyStatus: "unverified",
        status: "inconclusive",
      }),
    ]);
    expect(result.failureCleanup?.destroyVerification?.publicUrlDestroyChecks)
      .toEqual(result.publicUrlDestroyChecks);
    expect(
      requests.some(
        (request) =>
          request.method === "PATCH" &&
          request.url.endsWith(`/api/v1/capsules/${capsuleId}`),
      ),
    ).toBe(false);
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" &&
          request.url.endsWith(`/api/v1/connections/${rawConnectionId}/revoke`),
      ),
    ).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("platform smoke does not retry or directly delete after a failed destroy apply", async () => {
  const appName = "takosumi-destroy-failure-fixture";
  const rawConnectionId = "conn_destroy_failure_fixture";
  const providerConnectionId = "pcn_destroy_failure_fixture";
  const capsuleId = "cap_destroy_failure_fixture";
  const sourceId = "src_destroy_failure_fixture";
  const sourceSnapshotId = "snap_destroy_failure_fixture";
  const stateVersionId = "state_destroy_failure_fixture";
  const outputId = "out_destroy_failure_fixture";
  const runRecords = {
    sync: {
      id: "run_sync_destroy_failure_fixture",
      status: "succeeded",
      type: "source_sync",
      sourceSnapshotId,
    },
    planWaitingApproval: {
      id: "run_plan_destroy_failure_fixture",
      status: "waiting_approval",
      type: "plan",
    },
    planSucceeded: {
      id: "run_plan_destroy_failure_fixture",
      status: "succeeded",
      type: "plan",
    },
    applySucceeded: {
      id: "run_apply_destroy_failure_fixture",
      workspaceId: "ws_destroyfailure",
      capsuleId,
      planRunId: "run_plan_destroy_failure_fixture",
      status: "succeeded",
      type: "apply",
    },
    destroyPlanWaitingApproval: {
      id: "run_destroy_plan_failure_fixture",
      status: "waiting_approval",
      type: "destroy",
    },
    destroyFailed: {
      id: "run_destroy_apply_failure_fixture",
      status: "failed",
      type: "destroy",
    },
  } as const;
  const options = await resolveOptions(
    {
      url: "https://app-staging.takosumi.com",
      workspace: "ws_destroyfailure",
      appName,
      sourceGitUrl: "https://git.example.test/destroy-failure-fixture.git",
      cloudflareConnectionMode: "guided",
      verificationMode: "opentofu",
      noInterfaceProof: true,
      outputAllowlistJson: JSON.stringify({}),
      timeoutSeconds: "1",
      deployTimeoutSeconds: "1",
      pollIntervalMs: "1",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_ACCOUNT_ID: "account-fixture",
      CLOUDFLARE_WORKERS_SUBDOMAIN: "workers.example.test",
    },
  );
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly body?: string;
  }> = [];
  globalThis.fetch = (async (input, init) => {
    const requestUrl = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url: requestUrl.toString(), ...(body ? { body } : {}) });
    if (requestUrl.origin !== options.url) {
      throw new Error(`unexpected external fixture request: ${requestUrl}`);
    }
    const path = requestUrl.pathname;
    if (method === "POST" && path === "/api/v1/connections") {
      return Response.json({ connection: { id: rawConnectionId } });
    }
    if (
      method === "POST" &&
      path === `/api/v1/connections/${rawConnectionId}/test`
    ) {
      return Response.json({ status: "verified" });
    }
    if (method === "GET" && path === "/api/v1/provider-connections") {
      return Response.json({
        providerConnections: [
          {
            id: providerConnectionId,
            providerSource: "registry.opentofu.org/cloudflare/cloudflare",
            displayName: `Layer-2 smoke ${appName}`,
          },
        ],
      });
    }
    if (method === "POST" && path === "/api/v1/sources") {
      return Response.json({ source: { id: sourceId } });
    }
    if (
      method === "POST" &&
      path === `/api/v1/sources/${sourceId}/sync`
    ) {
      return Response.json({ run: runRecords.sync });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.sync.id}`
    ) {
      return Response.json({ run: runRecords.sync });
    }
    if (
      method === "GET" &&
      path === `/api/v1/sources/${sourceId}/snapshots`
    ) {
      return Response.json({
        snapshots: [
          {
            id: sourceSnapshotId,
            resolvedCommit: "a".repeat(40),
            archiveRef: "r2://fixture/source.tar.zst",
            archiveDigest: `sha256:${"b".repeat(64)}`,
            archiveSizeBytes: 1,
            fetchedByRunId: runRecords.sync.id,
          },
        ],
      });
    }
    if (method === "GET" && path === "/api/v1/capsule-configs") {
      return Response.json({
        installConfigs: [{ id: "cfg_destroy_failure_fixture", workspaceId: options.workspace }],
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/sources/${sourceId}/compatibility-check`
    ) {
      const reportId = "caprep_destroy_failure_fixture";
      return Response.json({
        report: {
          id: reportId,
          level: "ready",
          rootProviderRequirements: [
            {
              source: "registry.opentofu.org/cloudflare/cloudflare",
              moduleLocalName: "cloudflare",
            },
          ],
        },
        run: {
          id: "ccr_destroy_failure_fixture",
          type: "compatibility_check",
          status: "succeeded",
          compatibilityReportId: reportId,
        },
        repositoryInstallUx: { status: "absent" },
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/workspaces/${options.workspace}/install-plans`
    ) {
      return Response.json({
        installPlan: { id: "gip_destroy_failure_fixture", phase: "creating_capsule" },
        nextAction: "reconcile",
      }, { status: 201 });
    }
    if (
      method === "POST" &&
      path === "/api/v1/install-plans/gip_destroy_failure_fixture/reconcile"
    ) {
      return Response.json({
        installPlan: {
          id: "gip_destroy_failure_fixture",
          phase: "reviewable",
          capsuleId,
          installConfigId: "icfg_destroy_failure_fixture",
          planRunId: runRecords.planWaitingApproval.id,
        },
        nextAction: "review_run",
      });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}`
    ) {
      const planPolls = requests.filter(
        (request) =>
          request.method === "GET" &&
          request.url.endsWith(`/api/v1/runs/${runRecords.planWaitingApproval.id}`),
      ).length;
      return Response.json({
        run:
          planPolls === 1
            ? runRecords.planWaitingApproval
            : runRecords.planSucceeded,
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}/approve`
    ) {
      return Response.json({ run: runRecords.planSucceeded });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}/apply`
    ) {
      return Response.json({ run: runRecords.applySucceeded });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.applySucceeded.id}`
    ) {
      return Response.json({ run: runRecords.applySucceeded });
    }
    if (method === "GET" && path === `/api/v1/capsules/${capsuleId}`) {
      return Response.json({
        capsule: {
          id: capsuleId,
          workspaceId: options.workspace,
          status: "active",
          currentStateVersionId: stateVersionId,
          currentStateGeneration: 1,
        },
      });
    }
    if (
      method === "GET" &&
      path === `/api/v1/capsules/${capsuleId}/state-versions`
    ) {
      return Response.json({
        stateVersions: [
          {
            id: stateVersionId,
            workspaceId: options.workspace,
            capsuleId,
            environment: options.environment,
            createdByRunId: runRecords.applySucceeded.id,
            generation: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }
    if (method === "GET" && path === `/api/v1/capsules/${capsuleId}/outputs`) {
      return Response.json({
        output: {
          id: outputId,
          workspaceId: options.workspace,
          capsuleId,
          stateGeneration: 1,
          publicOutputs: {},
          outputDigest: `sha256:${"c".repeat(64)}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/capsules/${capsuleId}/destroy-plan`
    ) {
      return Response.json({ run: runRecords.destroyPlanWaitingApproval });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}`
    ) {
      return Response.json({ run: runRecords.destroyPlanWaitingApproval });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}/approve`
    ) {
      return Response.json({});
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}/apply`
    ) {
      return Response.json({ run: runRecords.destroyFailed });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.destroyFailed.id}`
    ) {
      return Response.json({ run: runRecords.destroyFailed });
    }
    if (method === "PATCH" && path === `/api/v1/capsules/${capsuleId}`) {
      throw new Error("failed destroy must retain Capsule evidence");
    }
    if (
      method === "POST" &&
      path === `/api/v1/connections/${rawConnectionId}/revoke`
    ) {
      throw new Error("failed destroy must retain ProviderConnection");
    }
    throw new Error(`unexpected Takosumi fixture request: ${method} ${requestUrl}`);
  }) as typeof fetch;
  try {
    const result = await runPlatformControlPlaneSmoke(
      options,
      pinnedControlPlaneFixture(
        async (input, init) => await globalThis.fetch(input, init),
      ),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain(
      `destroy apply run ${runRecords.destroyFailed.id} ended as failed`,
    );
    expect(result.capsuleId).toBe(capsuleId);
    expect(result.applyRunId).toBe(runRecords.applySucceeded.id);
    expect(result.destroyPlanRunId).toBe(runRecords.destroyPlanWaitingApproval.id);
    expect(result.destroyApplyRunId).toBe(runRecords.destroyFailed.id);
    expect(result.connectionRevoked).toBe(false);
    expect(result.connectionRevokeSkippedReason).toContain(
      "keeping ProviderConnection",
    );
    expect(result.failureCleanup).toMatchObject({
      attempted: true,
      cloudflareWorkerGone: false,
      capsuleMarkedError: false,
      destroyAttempted: true,
      destroyApplyAttempted: true,
      destroyPlanRunId: runRecords.destroyPlanWaitingApproval.id,
      destroyApplyRunId: runRecords.destroyFailed.id,
      destroySucceeded: false,
    });
    expect(result.runTimings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "destroy_plan",
          runId: runRecords.destroyPlanWaitingApproval.id,
        }),
        expect.objectContaining({
          name: "destroy_apply",
          runId: runRecords.destroyFailed.id,
        }),
      ]),
    );
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" &&
          request.url.endsWith(`/api/v1/capsules/${capsuleId}/destroy-plan`),
      ),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" &&
          request.url.endsWith(
            `/api/v1/runs/${runRecords.destroyPlanWaitingApproval.id}/apply`,
          ),
      ),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (request) =>
          request.method === "DELETE" &&
          request.url.includes("api.cloudflare.com/client/v4/accounts"),
      ),
    ).toHaveLength(0);
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" &&
          request.url.endsWith(`/api/v1/connections/${rawConnectionId}/revoke`),
      ),
    ).toHaveLength(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

type DestroyApplyReconciliationCase =
  | "mismatched"
  | "cancelled"
  | "already_terminal"
  | "succeeded";

async function runDestroyApplyReconciliationFixture(
  reconciliation: DestroyApplyReconciliationCase,
) {
  const appName = `takosumi-destroy-apply-${reconciliation}-fixture`;
  const capsuleId = `cap_destroy_apply_${reconciliation}_fixture`;
  const sourceId = `src_destroy_apply_${reconciliation}_fixture`;
  const sourceSnapshotId = `snap_destroy_apply_${reconciliation}_fixture`;
  const stateVersionId = `state_destroy_apply_${reconciliation}_fixture`;
  const outputId = `out_destroy_apply_${reconciliation}_fixture`;
  const workspaceId = `ws_destroyapply${reconciliation.replaceAll("_", "")}`;
  const destroyPlanRunId = `run_destroy_plan_${reconciliation}_fixture`;
  const destroyApplyRunId = `run_destroy_apply_${reconciliation}_fixture`;
  const staleRunId = `run_destroy_apply_stale_${reconciliation}_fixture`;
  const runRecords = {
    sync: {
      id: `run_sync_${reconciliation}_fixture`,
      status: "succeeded",
      type: "source_sync",
      sourceSnapshotId,
    },
    planWaitingApproval: {
      id: `run_plan_${reconciliation}_fixture`,
      status: "waiting_approval",
      type: "plan",
    },
    planSucceeded: {
      id: `run_plan_${reconciliation}_fixture`,
      status: "succeeded",
      type: "plan",
    },
    applySucceeded: {
      id: `run_apply_${reconciliation}_fixture`,
      workspaceId,
      capsuleId,
      planRunId: `run_plan_${reconciliation}_fixture`,
      status: "succeeded",
      type: "apply",
    },
    destroyPlanWaitingApproval: {
      id: destroyPlanRunId,
      status: "waiting_approval",
      type: "destroy",
    },
    destroyApplyRunning: {
      id: destroyApplyRunId,
      status: "running",
      type: "destroy",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:02.000Z",
    },
    destroyApplyTerminal: {
      id: destroyApplyRunId,
      status: reconciliation === "succeeded"
        ? "succeeded"
        : reconciliation === "already_terminal"
          ? "failed"
          : "cancelled",
      type: "destroy",
      ...(reconciliation === "succeeded" ? {} : { policyStatus: "deny" }),
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:02.000Z",
      finishedAt: "2026-01-01T00:00:03.000Z",
    },
    destroyApplyStale: {
      id: staleRunId,
      status: "succeeded",
      type: "destroy",
      createdAt: "2025-01-01T00:00:00.000Z",
      startedAt: "2025-01-01T00:00:02.000Z",
      finishedAt: "2025-01-01T00:00:03.000Z",
    },
  } as const;
  const options = await resolveOptions(
    {
      url: "https://app-staging.takosumi.com",
      workspace: workspaceId,
      appName,
      sourceGitUrl: `https://git.example.test/${reconciliation}.git`,
      cloudflareConnectionMode: "none",
      verificationMode: "opentofu",
      noInterfaceProof: true,
      outputAllowlistJson: JSON.stringify(
        reconciliation === "succeeded"
          ? {
              launch_url: { from: "launch_url", type: "url", required: true },
              ready_url: { from: "ready_url", type: "url", required: true },
            }
          : {},
      ),
      ...(reconciliation === "succeeded"
        ? {
            publicUrlChecksJson: JSON.stringify([
              {
                name: "health",
                output: "launch_url",
                path: "/healthz",
                expectedStatus: 200,
                bodyIncludes: ["ok"],
                destroyExpectation: { kind: "http-404" },
              },
              {
                name: "ready",
                output: "ready_url",
                path: "/readyz",
                expectedStatus: 200,
                bodyIncludes: ["ok"],
                destroyExpectation: { kind: "http-404" },
              },
            ]),
          }
        : {}),
      timeoutSeconds: "1",
      deployTimeoutSeconds: "1",
      pollIntervalMs: "2000",
    },
    {
      TAKOSUMI_ACCOUNT_SESSION_TOKEN: "session-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CLOUDFLARE_ACCOUNT_ID: "account-fixture",
      CLOUDFLARE_WORKERS_SUBDOMAIN: "workers.example.test",
    },
  );
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly body?: string;
  }> = [];
  const publicRequests: Array<{ readonly path: string }> = [];
  let destroyApplyPolls = 0;
  let destroyTerminalReconciled = false;
  globalThis.fetch = (async (input, init) => {
    const requestUrl = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, url: requestUrl.toString(), ...(body ? { body } : {}) });
    if (requestUrl.origin !== options.url) {
      throw new Error(`unexpected external fixture request: ${requestUrl}`);
    }
    const path = requestUrl.pathname;
    if (method === "POST" && path === "/api/v1/sources") {
      return Response.json({ source: { id: sourceId } });
    }
    if (method === "POST" && path === `/api/v1/sources/${sourceId}/sync`) {
      return Response.json({ run: runRecords.sync });
    }
    if (method === "GET" && path === `/api/v1/runs/${runRecords.sync.id}`) {
      return Response.json({ run: runRecords.sync });
    }
    if (method === "GET" && path === `/api/v1/sources/${sourceId}/snapshots`) {
      return Response.json({
        snapshots: [
          {
            id: sourceSnapshotId,
            resolvedCommit: "a".repeat(40),
            archiveRef: "r2://fixture/source.tar.zst",
            archiveDigest: `sha256:${"b".repeat(64)}`,
            archiveSizeBytes: 1,
            fetchedByRunId: runRecords.sync.id,
          },
        ],
      });
    }
    if (method === "GET" && path === "/api/v1/capsule-configs") {
      return Response.json({
        installConfigs: [
          {
            id: `cfg_destroy_apply_${reconciliation}_fixture`,
            workspaceId: options.workspace,
          },
        ],
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/sources/${sourceId}/compatibility-check`
    ) {
      const reportId = `caprep_destroy_apply_${reconciliation}_fixture`;
      return Response.json({
        report: {
          id: reportId,
          level: "ready",
          rootProviderRequirements: [],
        },
        run: {
          id: `ccr_destroy_apply_${reconciliation}_fixture`,
          type: "compatibility_check",
          status: "succeeded",
          compatibilityReportId: reportId,
        },
        repositoryInstallUx: { status: "absent" },
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/workspaces/${options.workspace}/install-plans`
    ) {
      return Response.json({
        installPlan: {
          id: `gip_destroy_apply_${reconciliation}_fixture`,
          phase: "creating_capsule",
        },
        nextAction: "reconcile",
      }, { status: 201 });
    }
    if (
      method === "POST" &&
      path === `/api/v1/install-plans/gip_destroy_apply_${reconciliation}_fixture/reconcile`
    ) {
      return Response.json({
        installPlan: {
          id: `gip_destroy_apply_${reconciliation}_fixture`,
          phase: "reviewable",
          capsuleId,
          installConfigId: `icfg_destroy_apply_${reconciliation}_fixture`,
          planRunId: runRecords.planWaitingApproval.id,
        },
        nextAction: "review_run",
      });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}`
    ) {
      return Response.json({ run: runRecords.planWaitingApproval });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}/approve`
    ) {
      return Response.json({ run: runRecords.planSucceeded });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${runRecords.planWaitingApproval.id}/apply`
    ) {
      return Response.json({ run: runRecords.applySucceeded });
    }
    if (method === "GET" && path === `/api/v1/runs/${runRecords.applySucceeded.id}`) {
      return Response.json({ run: runRecords.applySucceeded });
    }
    if (method === "GET" && path === `/api/v1/capsules/${capsuleId}`) {
      return Response.json({
        capsule: {
          id: capsuleId,
          workspaceId: options.workspace,
          status: "active",
          currentStateVersionId: stateVersionId,
          currentStateGeneration: 1,
        },
      });
    }
    if (
      method === "GET" &&
      path === `/api/v1/capsules/${capsuleId}/state-versions`
    ) {
      return Response.json({
        stateVersions: [
          {
            id: stateVersionId,
            workspaceId: options.workspace,
            capsuleId,
            environment: options.environment,
            createdByRunId: runRecords.applySucceeded.id,
            generation: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }
    if (method === "GET" && path === `/api/v1/capsules/${capsuleId}/outputs`) {
      return Response.json({
        output: {
          id: outputId,
          workspaceId: options.workspace,
          capsuleId,
          stateGeneration: 1,
          publicOutputs: reconciliation === "succeeded"
            ? {
                launch_url: options.url,
                ready_url: options.url,
              }
            : {},
          outputDigest: `sha256:${"c".repeat(64)}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });
    }
    if (
      method === "POST" &&
      path === `/api/v1/capsules/${capsuleId}/destroy-plan`
    ) {
      return Response.json({ run: runRecords.destroyPlanWaitingApproval });
    }
    if (
      method === "GET" &&
      path === `/api/v1/runs/${destroyPlanRunId}`
    ) {
      return Response.json({ run: runRecords.destroyPlanWaitingApproval });
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${destroyPlanRunId}/approve`
    ) {
      return Response.json({});
    }
    if (
      method === "POST" &&
      path === `/api/v1/runs/${destroyPlanRunId}/apply`
    ) {
      return Response.json({ run: runRecords.destroyApplyRunning });
    }
    if (method === "GET" && path === `/api/v1/runs/${destroyApplyRunId}`) {
      destroyApplyPolls += 1;
      if (reconciliation === "mismatched") {
        return Response.json({ run: runRecords.destroyApplyStale });
      }
      if (destroyApplyPolls === 1) {
        return Response.json({ run: runRecords.destroyApplyRunning });
      }
      if (
        reconciliation === "already_terminal" ||
        reconciliation === "succeeded"
      ) {
        destroyTerminalReconciled = true;
        return Response.json({ run: runRecords.destroyApplyTerminal });
      }
      return Response.json({ run: runRecords.destroyApplyRunning });
    }
    if (
      reconciliation === "cancelled" &&
      method === "POST" &&
      path === `/api/v1/runs/${destroyApplyRunId}/cancel`
    ) {
      return Response.json({ run: runRecords.destroyApplyTerminal });
    }
    throw new Error(`unexpected Takosumi fixture request: ${method} ${requestUrl}`);
  }) as typeof fetch;
  try {
    const controlPlane = pinnedControlPlaneFixture(
      async (input, init) => await globalThis.fetch(input, init),
    );
    const result = await runPlatformControlPlaneSmoke(
      options,
      {
        ...controlPlane,
        resolver: resolvePublicDns,
        connector: async (request) => {
          publicRequests.push({ path: request.path });
          return new Response(destroyTerminalReconciled ? "gone" : "ok", {
            status: destroyTerminalReconciled ? 404 : 200,
          });
        },
        maxAttempts: 1,
        sleep: async () => {},
      },
    );
    return { result, requests, publicRequests, runRecords };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("platform smoke rejects a destroy poll response for a different Run id", async () => {
  const { result, runRecords } = await runDestroyApplyReconciliationFixture(
    "mismatched",
  );
  expect(result.status).toBe("failed");
  expect(result.error).toContain(
    `run ${runRecords.destroyApplyRunning.id} poll returned mismatched run id ${runRecords.destroyApplyStale.id}`,
  );
  expect(result.destroyApplyRunId).toBe(runRecords.destroyApplyRunning.id);
  expect(result.runTimings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "destroy_apply",
        runId: runRecords.destroyApplyRunning.id,
      }),
    ]),
  );
  expect(
    result.runTimings.some((timing) => timing.runId === runRecords.destroyApplyStale.id),
  ).toBe(false);
});

test.each([
  "cancelled",
  "already_terminal",
] as const)(
  "platform smoke records the exact terminal destroy Run after %s reconciliation",
  async (reconciliation) => {
    const { result, runRecords } = await runDestroyApplyReconciliationFixture(
      reconciliation,
    );
    expect(result.status).toBe("failed");
    expect(result.timedOutRunId).toBe(runRecords.destroyApplyRunning.id);
    expect(result.runCancellationStatus).toBe(reconciliation);
    expect(result.policyStatus).toBe("denied");
    expect(result.destroyApplyRunId).toBe(runRecords.destroyApplyTerminal.id);
    expect(result.runTimings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "destroy_apply",
          runId: runRecords.destroyApplyTerminal.id,
          finishedAt: runRecords.destroyApplyTerminal.finishedAt,
          executionMs: 1_000,
          totalMs: 3_000,
        }),
      ]),
    );
    expect(result.failureCleanup).toMatchObject({
      destroyApplyRunId: runRecords.destroyApplyTerminal.id,
      destroySucceeded: false,
    });
  },
);

test("platform smoke verifies every public URL after a timed-out Destroy reconciles succeeded", async () => {
  const { result, publicRequests, runRecords } =
    await runDestroyApplyReconciliationFixture("succeeded");

  expect(result.status).toBe("failed");
  expect(result.timedOutRunId).toBe(runRecords.destroyApplyRunning.id);
  expect(result.runCancellationStatus).toBe("already_terminal");
  expect(result.destroyApplyRunId).toBe(runRecords.destroyApplyTerminal.id);
  expect(result.publicUrlDestroyChecks).toEqual([
    {
      name: "health",
      output: "launch_url",
      url: "https://app-staging.takosumi.com/healthz",
      expectation: { kind: "http-404" },
      applyStatus: "passed",
      status: "passed",
      observedStatus: 404,
    },
    {
      name: "ready",
      output: "ready_url",
      url: "https://app-staging.takosumi.com/readyz",
      expectation: { kind: "http-404" },
      applyStatus: "passed",
      status: "passed",
      observedStatus: 404,
    },
  ]);
  expect(result.failureCleanup).toMatchObject({
    attempted: true,
    destroyAttempted: true,
    destroyApplyAttempted: true,
    destroyApplyRunId: runRecords.destroyApplyTerminal.id,
    destroySucceeded: true,
    destroyVerification: {
      status: "passed",
      publicUrlDestroyChecks: result.publicUrlDestroyChecks,
    },
  });
  expect(result.destroyVerified).toBe(true);
  expect(publicRequests.map((request) => request.path)).toEqual([
    "/healthz",
    "/readyz",
    "/healthz",
    "/readyz",
  ]);
});
