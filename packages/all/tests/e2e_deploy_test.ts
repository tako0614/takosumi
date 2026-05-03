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
import { serveRuntimeAgent } from "@takos/takosumi-runtime-agent/server";
import {
  type LifecycleApplyRequest,
  type LifecycleApplyResponse,
  type LifecycleDescribeRequest,
  type LifecycleDescribeResponse,
  type LifecycleDestroyRequest,
  type LifecycleDestroyResponse,
} from "takosumi-contract";
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";

const SHAPE_ID = "object-store@v1";
const PROVIDER_ID = "@takos/aws-s3";
const DEPLOY_TOKEN = "e2e-deploy-token";
const AGENT_TOKEN = "e2e-agent-token";

interface RecordedCall {
  readonly op: "apply" | "destroy" | "describe";
  readonly resourceName?: string;
  readonly handle?: string;
}

function buildTestConnector(): { connector: Connector; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const handles = new Map<string, { name: string; outputs: { bucket: string } }>();
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
  };
  return { connector, calls };
}

Deno.test("e2e: kernel + agent + apply + destroy via @takos/aws-s3", async () => {
  const { connector, calls } = buildTestConnector();
  const registry = new ConnectorRegistry();
  registry.register(connector);

  const agentHandle = serveRuntimeAgent({
    port: 0,
    registry,
    token: AGENT_TOKEN,
  });

  const previousEnv: Record<string, string | undefined> = {
    TAKOSUMI_AGENT_URL: Deno.env.get("TAKOSUMI_AGENT_URL"),
    TAKOSUMI_AGENT_TOKEN: Deno.env.get("TAKOSUMI_AGENT_TOKEN"),
    TAKOSUMI_DEPLOY_TOKEN: Deno.env.get("TAKOSUMI_DEPLOY_TOKEN"),
    TAKOSUMI_DEV_MODE: Deno.env.get("TAKOSUMI_DEV_MODE"),
    TAKOSUMI_LOG_LEVEL: Deno.env.get("TAKOSUMI_LOG_LEVEL"),
  };

  try {
    Deno.env.set("TAKOSUMI_AGENT_URL", agentHandle.url);
    Deno.env.set("TAKOSUMI_AGENT_TOKEN", AGENT_TOKEN);
    Deno.env.set("TAKOSUMI_DEPLOY_TOKEN", DEPLOY_TOKEN);
    Deno.env.set("TAKOSUMI_DEV_MODE", "1");
    Deno.env.set("TAKOSUMI_LOG_LEVEL", "warn"); // suppress dev fallback notice

    const created = await createPaaSApp({
      runtimeEnv: { ...Deno.env.toObject() },
    });

    // ---- Apply ----
    const applyResponse = await created.app.request("/v1/deployments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DEPLOY_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "apply",
        manifest: {
          metadata: { name: "e2e-app" },
          resources: [{
            shape: SHAPE_ID,
            name: "primary",
            provider: PROVIDER_ID,
            spec: { name: "primary" },
          }],
        },
      }),
    });
    if (applyResponse.status !== 200) {
      console.error("apply failed:", applyResponse.status, await applyResponse.text());
    }
    assert.equal(applyResponse.status, 200);
    const applyBody = await applyResponse.json();
    assert.equal(applyBody.status, "ok");
    assert.equal(applyBody.outcome.applied.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].op, "apply");
    assert.equal(calls[0].resourceName, "primary");

    // ---- Destroy ----
    const destroyResponse = await created.app.request("/v1/deployments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DEPLOY_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "destroy",
        manifest: {
          metadata: { name: "e2e-app" },
          resources: [{
            shape: SHAPE_ID,
            name: "primary",
            provider: PROVIDER_ID,
            spec: { name: "primary" },
          }],
        },
      }),
    });
    if (destroyResponse.status !== 200) {
      console.error("destroy failed:", destroyResponse.status, await destroyResponse.text());
    }
    assert.equal(destroyResponse.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].op, "destroy");
    assert.equal(
      calls[1].handle,
      "arn:aws:s3:::primary",
      "destroy must receive the persisted handle, not the resource name",
    );
  } finally {
    await agentHandle.shutdown();
    for (const [k, v] of Object.entries(previousEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
