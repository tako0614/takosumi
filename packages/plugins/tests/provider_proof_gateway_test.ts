import assert from "node:assert/strict";
import { createAwsHttpGatewayHandler } from "../src/providers/aws/mod.ts";
import { createCloudflareHttpGatewayHandler } from "../src/providers/cloudflare/mod.ts";
import { createGcpHttpGatewayHandler } from "../src/providers/gcp/mod.ts";
import { createKubernetesHttpGatewayHandler } from "../src/providers/kubernetes/mod.ts";

const now = "2026-04-30T00:00:00.000Z";

Deno.test("provider proof gateways expose canonical materialize verify and teardown routes", async () => {
  for (
    const { provider, handler } of [
      {
        provider: "aws",
        handler: createAwsHttpGatewayHandler(proofServices("aws")),
      },
      {
        provider: "gcp",
        handler: createGcpHttpGatewayHandler(proofServices("gcp")),
      },
      {
        provider: "kubernetes",
        handler: createKubernetesHttpGatewayHandler(
          proofServices("kubernetes"),
        ),
      },
      {
        provider: "cloudflare",
        handler: createCloudflareHttpGatewayHandler(
          proofServices("cloudflare"),
        ),
      },
    ]
  ) {
    const materialized = await post(
      handler,
      "provider/materialize-desired-state",
    );
    assert.equal(materialized.provider, provider);
    assert.equal(materialized.desiredStateId, "desired_1");

    const verified = await post(handler, "provider/verify-desired-state");
    assert.equal(verified.provider, provider);
    assert.equal(verified.ok, true);

    const tornDown = await post(handler, "provider/teardown-desired-state");
    assert.equal(tornDown.provider, provider);
    assert.equal(tornDown.ok, true);

    assert.deepEqual(await post(handler, "provider/list-operations", {}), []);
    assert.equal(
      await post(handler, "provider/clear-operations", {}),
      undefined,
    );
  }
});

Deno.test("gcp and kubernetes proof gateways keep reconcile alias", async () => {
  for (
    const { provider, handler } of [
      {
        provider: "gcp",
        handler: createGcpHttpGatewayHandler(reconcileOnlyServices("gcp")),
      },
      {
        provider: "kubernetes",
        handler: createKubernetesHttpGatewayHandler(
          reconcileOnlyServices("kubernetes"),
        ),
      },
    ]
  ) {
    const canonical = await post(handler, "provider/materialize-desired-state");
    assert.equal(canonical.provider, provider);
    assert.equal(canonical.desiredStateId, "desired_1");

    const alias = await post(handler, "provider/reconcile-desired-state");
    assert.equal(alias.provider, provider);
    assert.equal(alias.desiredStateId, "desired_1");
  }
});

function proofServices(provider: string) {
  return {
    materializeDesiredState(input: ReturnType<typeof desiredState>) {
      return Promise.resolve(materializationPlan(provider, input.id));
    },
    verifyDesiredState(input: ReturnType<typeof desiredState>) {
      return Promise.resolve({
        provider,
        desiredStateId: input.id,
        verifiedAt: now,
        ok: true,
        checks: [{ name: "proof", status: "passed" }],
      });
    },
    teardownDesiredState(input: ReturnType<typeof desiredState>) {
      return Promise.resolve({
        ...materializationPlan(provider, input.id),
        tornDownAt: now,
        ok: true,
        checks: [{ name: "teardown", status: "passed" }],
      });
    },
    listOperations() {
      return Promise.resolve([]);
    },
    clearOperations() {
      return Promise.resolve();
    },
  };
}

function reconcileOnlyServices(provider: string) {
  return {
    reconcileDesiredState(input: ReturnType<typeof desiredState>) {
      return Promise.resolve(materializationPlan(provider, input.id));
    },
  };
}

function materializationPlan(provider: string, desiredStateId: string) {
  return {
    id: `plan_${provider}`,
    provider,
    desiredStateId,
    recordedAt: now,
    operations: [],
  };
}

async function post(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown = desiredState(),
): Promise<Record<string, unknown>> {
  const response = await handler(
    new Request(`https://gateway.example.test/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const json = text ? JSON.parse(text) : {};
  return json.result as Record<string, unknown>;
}

function desiredState() {
  return {
    id: "desired_1",
    spaceId: "space_1",
    groupId: "group_1",
    activationId: "activation_1",
    appName: "docs",
    materializedAt: now,
    workloads: [],
    resources: [],
    routes: [],
  };
}
