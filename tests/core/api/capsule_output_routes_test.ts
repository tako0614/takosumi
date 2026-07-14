import { expect, test } from "bun:test";

import type { Capsule } from "takosumi-contract/capsules";
import type { Output } from "takosumi-contract/outputs";
import { createApiApp } from "../../../core/api/app.ts";
import { OpenTofuController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";

const TOKEN = "capsule-output-token";
const CAPSULE_ID = "cap_output0001";
const WORKSPACE_ID = "ws_output";
const OUTPUT_ID = "out_output0001";

function capsule(overrides: Partial<Capsule> = {}): Capsule {
  return {
    id: CAPSULE_ID,
    workspaceId: WORKSPACE_ID,
    projectId: "prj_output",
    name: "output-test",
    slug: "output-test",
    sourceId: "src_output",
    installConfigId: "cfg_output",
    environment: "production",
    currentStateGeneration: 1,
    status: "active",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function output(overrides: Partial<Output> = {}): Output {
  return {
    id: OUTPUT_ID,
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    stateGeneration: 1,
    rawArtifactRef: "encrypted/raw-secret-output.json",
    publicOutputs: { endpoint: "https://example.test" },
    workspaceOutputs: { endpoint: "https://example.test" },
    outputDigest: "sha256:output",
    createdAt: "2026-07-13T00:00:01.000Z",
    ...overrides,
  };
}

async function outputApp(
  store: InMemoryOpenTofuControlStore,
  workspaceIds: readonly string[] = [WORKSPACE_ID],
) {
  return await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller: new OpenTofuController({ store }),
      authorizeDeployControlBearer: ({ token }) =>
        token === TOKEN
          ? {
              actor: "output-test",
              workspaceIds,
              operations: "*",
              runnerProfileIds: "*",
            }
          : undefined,
    },
  });
}

function auth(): HeadersInit {
  return { authorization: `Bearer ${TOKEN}` };
}

test("Capsule Output read returns null before the first current Output", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putCapsule(capsule({ currentStateGeneration: 0 }));
  const app = await outputApp(store);

  const response = await app.request(
    `/internal/v1/capsules/${CAPSULE_ID}/outputs`,
    { headers: auth() },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ output: null });
});

test("Capsule Output read returns only the public Output projection", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putCapsule(capsule({ currentOutputId: OUTPUT_ID }));
  await store.putOutput(output());
  const app = await outputApp(store);

  const response = await app.request(
    `/internal/v1/capsules/${CAPSULE_ID}/outputs`,
    { headers: auth() },
  );
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.output).toMatchObject({
    id: OUTPUT_ID,
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    publicOutputs: { endpoint: "https://example.test" },
  });
  expect(body.output.rawArtifactRef).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("raw-secret");
  expect(JSON.stringify(body)).not.toContain("currentOutputId");
});

test("Capsule Output read fails closed for a dangling current cursor", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putCapsule(capsule({ currentOutputId: OUTPUT_ID }));
  const app = await outputApp(store);

  const response = await app.request(
    `/internal/v1/capsules/${CAPSULE_ID}/outputs`,
    { headers: auth() },
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: {
      code: "failed_precondition",
      details: { reason: "current_output_inconsistent" },
    },
  });
});

test("Capsule Output read fails closed for a mismatched Output row", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putCapsule(capsule({ currentOutputId: OUTPUT_ID }));
  await store.putOutput(output({ capsuleId: "cap_other0001" }));
  const app = await outputApp(store);

  const response = await app.request(
    `/internal/v1/capsules/${CAPSULE_ID}/outputs`,
    { headers: auth() },
  );

  expect(response.status).toBe(409);
  expect((await response.json()).error.details.reason).toBe(
    "current_output_inconsistent",
  );
});

test("Capsule Output read authorizes the Capsule Workspace before following its cursor", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putCapsule(capsule({ currentOutputId: OUTPUT_ID }));
  const app = await outputApp(store, ["ws_other"]);

  const response = await app.request(
    `/internal/v1/capsules/${CAPSULE_ID}/outputs`,
    { headers: auth() },
  );

  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("permission_denied");
});

test("Capsule Output read requires a deploy-control bearer", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putCapsule(capsule());
  const app = await outputApp(store);

  const response = await app.request(
    `/internal/v1/capsules/${CAPSULE_ID}/outputs`,
  );

  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe("unauthenticated");
});
