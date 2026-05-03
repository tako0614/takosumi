/**
 * End-to-end integration test: 6 packages booted together.
 *
 * Verifies the full kernel → provider plugin → RuntimeAgentLifecycle (HTTP) →
 * runtime-agent → connector chain by:
 *   1. Standing up an agent server backed by a fake `@takos/aws-s3` connector
 *      that records every apply / destroy call (no real AWS contact).
 *   2. Booting the kernel via `createPaaSApp` with TAKOSUMI_AGENT_URL pointing
 *      at the test agent. The bootstrap auto-registers production provider
 *      plugins, including `@takos/aws-s3` which proxies to our fake connector.
 *   3. POSTing `/v1/deployments` (apply + destroy) and asserting the recorded
 *      connector calls match what the manifest implied.
 *
 * No cloud APIs are contacted. The point is to confirm the wire-up across
 * `contract` + `runtime-agent` + `plugins` + `kernel` + (umbrella).
 */

import assert from "node:assert/strict";
import {
  type Connector,
  ConnectorRegistry,
} from "@takos/takosumi-runtime-agent/connectors";
import {
  type ServeHandle,
  serveRuntimeAgent,
} from "@takos/takosumi-runtime-agent/server";
import type {
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleDescribeRequest,
  LifecycleDescribeResponse,
  LifecycleDestroyRequest,
  LifecycleDestroyResponse,
} from "takosumi-contract";
import {
  type CreatedPaaSApp,
  createPaaSApp,
} from "@takos/takosumi-kernel/bootstrap";

const SHAPE_ID = "object-store@v1";
const PROVIDER_ID = "@takos/aws-s3";
const WORKER_SHAPE_ID = "worker@v1";
const WORKER_PROVIDER_ID = "@takos/cloudflare-workers";
const DEPLOY_TOKEN = "e2e-deploy-token";
const AGENT_TOKEN = "e2e-agent-token";

interface RecordedCall {
  readonly op: "apply" | "destroy" | "describe";
  readonly resourceName?: string;
  readonly handle?: string;
}

function buildTestConnector(): {
  connector: Connector;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const handles = new Map<
    string,
    { name: string; outputs: { bucket: string } }
  >();
  const connector: Connector = {
    provider: PROVIDER_ID,
    shape: SHAPE_ID,
    acceptedArtifactKinds: [],
    apply(req: LifecycleApplyRequest): Promise<LifecycleApplyResponse> {
      const handle = `arn:aws:s3:::${req.resourceName}`;
      calls.push({ op: "apply", resourceName: req.resourceName });
      handles.set(handle, {
        name: req.resourceName,
        outputs: { bucket: req.resourceName },
      });
      return Promise.resolve({
        handle,
        outputs: { bucket: req.resourceName, region: "us-east-1" },
      });
    },
    destroy(req: LifecycleDestroyRequest): Promise<LifecycleDestroyResponse> {
      calls.push({ op: "destroy", handle: req.handle });
      handles.delete(req.handle);
      return Promise.resolve({ ok: true });
    },
    describe(
      req: LifecycleDescribeRequest,
    ): Promise<LifecycleDescribeResponse> {
      calls.push({ op: "describe", handle: req.handle });
      const stored = handles.get(req.handle);
      return Promise.resolve(
        stored
          ? { status: "running" as const, outputs: stored.outputs }
          : { status: "missing" as const },
      );
    },
    verify() {
      return Promise.resolve({ ok: true, note: "verified" });
    },
  };
  return { connector, calls };
}

const TRACKED_ENV_KEYS = [
  "TAKOSUMI_AGENT_URL",
  "TAKOSUMI_AGENT_TOKEN",
  "TAKOSUMI_DEPLOY_TOKEN",
  "TAKOSUMI_DEV_MODE",
  "TAKOSUMI_LOG_LEVEL",
  "TAKOSUMI_PUBLIC_BASE_URL",
  "TAKOSUMI_ARTIFACT_FETCH_TOKEN",
] as const;

interface E2eHarness {
  readonly created: CreatedPaaSApp;
  readonly agent: ServeHandle;
  readonly calls: RecordedCall[];
  readonly connector: Connector;
  /** Optional kernel HTTP listener (set when `serveKernel: true`). */
  readonly kernelServer?: Deno.HttpServer;
  readonly kernelUrl?: string;
  shutdown(): Promise<void>;
}

interface BuildHarnessOptions {
  /** Override the AWS S3 fake. Falls back to `buildTestConnector()`. */
  readonly connectorFactory?: () => {
    connector: Connector;
    calls: RecordedCall[];
  };
  /** Extra connectors registered alongside the s3 fake. */
  readonly extraConnectors?: readonly Connector[];
  /** When true, also start a real `Deno.serve` listener for the kernel HTTP
   *  app and set `TAKOSUMI_PUBLIC_BASE_URL` so the agent can fetch artifact
   *  bytes back through the kernel. */
  readonly serveKernel?: boolean;
}

async function buildE2eHarness(
  opts: BuildHarnessOptions = {},
): Promise<E2eHarness> {
  const { connector, calls } = (opts.connectorFactory ?? buildTestConnector)();
  const registry = new ConnectorRegistry();
  registry.register(connector);
  for (const extra of opts.extraConnectors ?? []) registry.register(extra);

  const agent = serveRuntimeAgent({
    port: 0,
    registry,
    token: AGENT_TOKEN,
  });

  const previousEnv = snapshotEnv();
  Deno.env.set("TAKOSUMI_AGENT_URL", agent.url);
  Deno.env.set("TAKOSUMI_AGENT_TOKEN", AGENT_TOKEN);
  Deno.env.set("TAKOSUMI_DEPLOY_TOKEN", DEPLOY_TOKEN);
  Deno.env.set("TAKOSUMI_DEV_MODE", "1");
  Deno.env.set("TAKOSUMI_LOG_LEVEL", "warn");
  // Public base url is required for `artifactStore` to be wired into apply
  // envelopes — provisional placeholder, replaced after we know the bound
  // listener port when `serveKernel` is true.
  if (opts.serveKernel) {
    // Use the agent token here as the artifact fetch token so the kernel
    // GET /v1/artifacts/:hash route accepts the agent's bearer header.
    Deno.env.set("TAKOSUMI_ARTIFACT_FETCH_TOKEN", DEPLOY_TOKEN);
    Deno.env.set("TAKOSUMI_PUBLIC_BASE_URL", "http://placeholder.invalid");
  }

  let kernelServer: Deno.HttpServer | undefined;
  let kernelUrl: string | undefined;
  let created: CreatedPaaSApp;

  try {
    if (opts.serveKernel) {
      // Two-phase boot: spin up a placeholder Deno.serve so we have the bound
      // port, set TAKOSUMI_PUBLIC_BASE_URL accordingly, then build the kernel
      // app whose providers carry the artifactStore locator built from the
      // env. Finally swap the placeholder handler for the kernel app.
      const activeApp: {
        handler?: (req: Request) => Response | Promise<Response>;
      } = {};
      kernelServer = Deno.serve(
        { port: 0, hostname: "127.0.0.1", onListen: () => {} },
        (req) =>
          activeApp.handler
            ? activeApp.handler(req)
            : new Response("not ready", { status: 503 }),
      );
      const addr = kernelServer.addr as Deno.NetAddr;
      kernelUrl = `http://127.0.0.1:${addr.port}`;
      Deno.env.set("TAKOSUMI_PUBLIC_BASE_URL", kernelUrl);
      created = await createPaaSApp({
        runtimeEnv: { ...Deno.env.toObject() },
      });
      activeApp.handler = (req) => created.app.fetch(req) as Promise<Response>;
    } else {
      created = await createPaaSApp({
        runtimeEnv: { ...Deno.env.toObject() },
      });
    }
  } catch (err) {
    if (kernelServer) await kernelServer.shutdown();
    await agent.shutdown();
    restoreEnv(previousEnv);
    throw err;
  }

  return {
    created,
    agent,
    calls,
    connector,
    ...(kernelServer ? { kernelServer } : {}),
    ...(kernelUrl ? { kernelUrl } : {}),
    async shutdown() {
      if (kernelServer) {
        try {
          await kernelServer.shutdown();
        } catch {
          // already shut down
        }
      }
      await agent.shutdown();
      restoreEnv(previousEnv);
    },
  };
}

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const k of TRACKED_ENV_KEYS) snapshot[k] = Deno.env.get(k);
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of TRACKED_ENV_KEYS) {
    const v = snapshot[k];
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function manifestForS3() {
  return {
    metadata: { name: "e2e-app" },
    resources: [{
      shape: SHAPE_ID,
      name: "primary",
      provider: PROVIDER_ID,
      spec: { name: "primary" },
    }],
  };
}

Deno.test("e2e: kernel + agent + apply + destroy via @takos/aws-s3", async () => {
  const harness = await buildE2eHarness();
  try {
    // ---- Apply ----
    const applyResponse = await harness.created.app.request("/v1/deployments", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(DEPLOY_TOKEN) },
      body: JSON.stringify({ mode: "apply", manifest: manifestForS3() }),
    });
    if (applyResponse.status !== 200) {
      console.error(
        "apply failed:",
        applyResponse.status,
        await applyResponse.text(),
      );
    }
    assert.equal(applyResponse.status, 200);
    const applyBody = await applyResponse.json();
    assert.equal(applyBody.status, "ok");
    assert.equal(applyBody.outcome.applied.length, 1);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].op, "apply");
    assert.equal(harness.calls[0].resourceName, "primary");

    // ---- Destroy ----
    const destroyResponse = await harness.created.app.request(
      "/v1/deployments",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...bearer(DEPLOY_TOKEN),
        },
        body: JSON.stringify({ mode: "destroy", manifest: manifestForS3() }),
      },
    );
    if (destroyResponse.status !== 200) {
      console.error(
        "destroy failed:",
        destroyResponse.status,
        await destroyResponse.text(),
      );
    }
    assert.equal(destroyResponse.status, 200);
    assert.equal(harness.calls.length, 2);
    assert.equal(harness.calls[1].op, "destroy");
    assert.equal(
      harness.calls[1].handle,
      "arn:aws:s3:::primary",
      "destroy must receive the persisted handle, not the resource name",
    );
  } finally {
    await harness.shutdown();
  }
});

Deno.test("e2e: mode=plan returns DAG without invoking provider.apply", async () => {
  const harness = await buildE2eHarness();
  try {
    const planResponse = await harness.created.app.request("/v1/deployments", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(DEPLOY_TOKEN) },
      body: JSON.stringify({ mode: "plan", manifest: manifestForS3() }),
    });
    if (planResponse.status !== 200) {
      console.error(
        "plan failed:",
        planResponse.status,
        await planResponse.text(),
      );
    }
    assert.equal(planResponse.status, 200);
    const body = await planResponse.json();
    assert.equal(body.status, "ok");
    assert.deepEqual(body.outcome.applied, []);
    assert.equal(body.outcome.status, "succeeded");
    // Critical: provider.apply MUST NOT be invoked in plan mode.
    assert.equal(
      harness.calls.length,
      0,
      "plan mode must not call connector.apply",
    );
  } finally {
    await harness.shutdown();
  }
});

Deno.test("e2e: GET /v1/deployments and /:name return persisted state", async () => {
  const harness = await buildE2eHarness();
  try {
    const applyResponse = await harness.created.app.request("/v1/deployments", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(DEPLOY_TOKEN) },
      body: JSON.stringify({ mode: "apply", manifest: manifestForS3() }),
    });
    assert.equal(applyResponse.status, 200);
    await applyResponse.json();

    // GET list
    const listResponse = await harness.created.app.request("/v1/deployments", {
      method: "GET",
      headers: bearer(DEPLOY_TOKEN),
    });
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.ok(Array.isArray(listBody.deployments));
    assert.equal(listBody.deployments.length, 1);
    assert.equal(listBody.deployments[0].name, "e2e-app");
    assert.equal(listBody.deployments[0].status, "applied");

    // GET single
    const oneResponse = await harness.created.app.request(
      "/v1/deployments/e2e-app",
      { method: "GET", headers: bearer(DEPLOY_TOKEN) },
    );
    assert.equal(oneResponse.status, 200);
    const one = await oneResponse.json();
    assert.equal(one.name, "e2e-app");
    assert.equal(one.status, "applied");
    assert.equal(one.resources.length, 1);
    assert.equal(one.resources[0].name, "primary");
    assert.equal(one.resources[0].provider, PROVIDER_ID);
    assert.equal(one.resources[0].handle, "arn:aws:s3:::primary");

    // 401 with bad auth
    const badAuth = await harness.created.app.request(
      "/v1/deployments/e2e-app",
      { method: "GET", headers: bearer("not-the-real-token") },
    );
    assert.equal(badAuth.status, 401);
  } finally {
    await harness.shutdown();
  }
});

Deno.test("e2e: artifact upload + worker apply via @takos/cloudflare-workers", async () => {
  const workerCalls: Array<{
    resourceName: string;
    bytes: Uint8Array;
    artifactKind: string;
  }> = [];
  const workerConnector: Connector = {
    provider: WORKER_PROVIDER_ID,
    shape: WORKER_SHAPE_ID,
    acceptedArtifactKinds: ["js-bundle"],
    async apply(req, ctx) {
      if (!ctx.fetcher) {
        throw new Error(
          "fake cloudflare-workers connector requires ctx.fetcher",
        );
      }
      const spec = req.spec as {
        artifact: { kind: string; hash: string };
        compatibilityDate: string;
      };
      const fetched = await ctx.fetcher.fetch(spec.artifact.hash);
      workerCalls.push({
        resourceName: req.resourceName,
        bytes: fetched.bytes,
        artifactKind: fetched.kind,
      });
      return {
        handle: `cf-account/${req.resourceName}`,
        outputs: {
          url: `https://${req.resourceName}.workers.dev`,
          scriptName: req.resourceName,
        },
      };
    },
    destroy() {
      return Promise.resolve({ ok: true });
    },
    describe() {
      return Promise.resolve({ status: "missing" as const });
    },
  };

  const harness = await buildE2eHarness({
    serveKernel: true,
    extraConnectors: [workerConnector],
  });
  try {
    assert.ok(harness.kernelUrl, "expected kernel HTTP listener");
    const bundleBytes = new TextEncoder().encode(
      "export default { fetch() { return new Response('hi'); } };",
    );

    // Upload artifact via the kernel HTTP endpoint.
    const form = new FormData();
    form.set("kind", "js-bundle");
    form.set(
      "body",
      new Blob([bundleBytes as BlobPart], { type: "application/javascript" }),
      "worker.js",
    );
    const uploadRes = await fetch(`${harness.kernelUrl}/v1/artifacts`, {
      method: "POST",
      headers: bearer(DEPLOY_TOKEN),
      body: form,
    });
    if (uploadRes.status !== 200) {
      console.error(
        "artifact upload failed:",
        uploadRes.status,
        await uploadRes.text(),
      );
    }
    assert.equal(uploadRes.status, 200);
    const { hash } = await uploadRes.json() as { hash: string };
    assert.ok(hash.startsWith("sha256:"), `unexpected hash: ${hash}`);

    // Now POST a deployment that references the artifact by hash.
    const deployRes = await fetch(`${harness.kernelUrl}/v1/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(DEPLOY_TOKEN) },
      body: JSON.stringify({
        mode: "apply",
        manifest: {
          metadata: { name: "e2e-worker" },
          resources: [{
            shape: WORKER_SHAPE_ID,
            name: "edge-fn",
            provider: WORKER_PROVIDER_ID,
            spec: {
              // The factory `pickResourceName` reads `spec.name` to forward
              // it to the runtime-agent connector as `resourceName`; without
              // it the connector receives an empty string. The worker shape
              // does not validate extra fields, so this is safe.
              name: "edge-fn",
              artifact: { kind: "js-bundle", hash },
              compatibilityDate: "2025-01-01",
            },
          }],
        },
      }),
    });
    if (deployRes.status !== 200) {
      console.error(
        "worker deploy failed:",
        deployRes.status,
        await deployRes.text(),
      );
    }
    assert.equal(deployRes.status, 200);
    const deployBody = await deployRes.json() as { status: string };
    assert.equal(deployBody.status, "ok");

    // Connector should have been called once with the fetched bytes intact.
    assert.equal(workerCalls.length, 1);
    assert.equal(workerCalls[0].resourceName, "edge-fn");
    assert.equal(workerCalls[0].artifactKind, "js-bundle");
    assert.equal(
      workerCalls[0].bytes.length,
      bundleBytes.length,
      "connector must receive the full uploaded payload",
    );
    // Byte-for-byte comparison so we know the kernel did not corrupt the
    // bundle on the way through.
    for (let i = 0; i < bundleBytes.length; i++) {
      assert.equal(workerCalls[0].bytes[i], bundleBytes[i]);
    }
  } finally {
    await harness.shutdown();
  }
});

Deno.test("e2e: POST /v1/lifecycle/verify returns connector ok", async () => {
  const harness = await buildE2eHarness();
  try {
    const res = await fetch(`${harness.agent.url}/v1/lifecycle/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(AGENT_TOKEN) },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      results: Array<
        { shape: string; provider: string; ok: boolean; note?: string }
      >;
    };
    assert.ok(Array.isArray(body.results));
    const found = body.results.find((r) =>
      r.shape === SHAPE_ID && r.provider === PROVIDER_ID
    );
    assert.ok(found, "expected aws-s3 connector in verify results");
    assert.equal(found.ok, true);
    assert.equal(found.note, "verified");
  } finally {
    await harness.shutdown();
  }
});
