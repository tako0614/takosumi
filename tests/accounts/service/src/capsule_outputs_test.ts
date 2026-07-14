import { expect, test } from "bun:test";

import type { Capsule } from "takosumi-contract/capsules";
import type { Output } from "takosumi-contract/outputs";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { handleCapsules } from "../../../../accounts/service/src/control/capsules.ts";
import type { ControlDispatchContext } from "../../../../accounts/service/src/control/shared.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

const WORKSPACE_ID = "ws_output";
const CAPSULE_ID = "cap_output0001";
const OUTPUT_ID = "out_output0001";

const workspace = {
  id: WORKSPACE_ID,
  handle: "output",
  displayName: "Output",
  type: "personal" as const,
  ownerUserId: "subject_owner",
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
};

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
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    ...overrides,
  };
}

function output(overrides: Partial<Output> = {}): Output {
  return {
    id: OUTPUT_ID,
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    stateGeneration: 1,
    rawArtifactRef: "encrypted/session-secret-output.json",
    publicOutputs: { endpoint: "https://example.test" },
    workspaceOutputs: { endpoint: "https://example.test" },
    outputDigest: "sha256:output",
    createdAt: "2026-07-13T00:00:01.000Z",
    ...overrides,
  };
}

function operationsFixture(input: {
  readonly capsule: Capsule;
  readonly output?: Output;
  readonly onGetOutput?: () => void;
}): ControlPlaneOperations {
  return {
    workspaces: {
      getWorkspace: async () => workspace,
    },
    members: {
      listMembers: async () => [],
    },
    capsules: {
      getCapsule: async () => input.capsule,
    },
    getOutput: async () => {
      input.onGetOutput?.();
      return input.output;
    },
  } as unknown as ControlPlaneOperations;
}

function context(
  operations: ControlPlaneOperations,
  method = "GET",
  subject = "subject_owner",
): ControlDispatchContext {
  const request = new Request(
    `https://app.example.test/api/v1/capsules/${CAPSULE_ID}/outputs`,
    { method },
  );
  return {
    request,
    url: new URL(request.url),
    operations,
    store: new InMemoryAccountsStore(),
    session: { subject },
  };
}

async function readOutput(
  operations: ControlPlaneOperations,
  method = "GET",
  subject = "subject_owner",
): Promise<Response> {
  const response = await handleCapsules(
    context(operations, method, subject),
    ["capsules", CAPSULE_ID, "outputs"],
    method,
  );
  if (!response) throw new Error("Capsule Output route did not match");
  return response;
}

test("session Capsule Output read returns null before apply", async () => {
  const response = await readOutput(
    operationsFixture({ capsule: capsule({ currentStateGeneration: 0 }) }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ output: null });
});

test("session Capsule Output read strips the raw artifact coordinate", async () => {
  const response = await readOutput(
    operationsFixture({
      capsule: capsule({ currentOutputId: OUTPUT_ID }),
      output: output(),
    }),
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
  expect(JSON.stringify(body)).not.toContain("session-secret");
  expect(JSON.stringify(body)).not.toContain("currentOutputId");
});

test("session Capsule Output read fails closed for missing and mismatched rows", async () => {
  for (const candidate of [
    undefined,
    output({ workspaceId: "ws_other" }),
    output({ capsuleId: "cap_other0001" }),
    output({ stateGeneration: 2 }),
  ]) {
    const response = await readOutput(
      operationsFixture({
        capsule: capsule({ currentOutputId: OUTPUT_ID }),
        ...(candidate ? { output: candidate } : {}),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "failed_precondition",
        details: { reason: "current_output_inconsistent" },
      },
    });
  }
});

test("session Capsule Output read authorizes the exact Workspace before reading Output", async () => {
  let reads = 0;
  const response = await readOutput(
    operationsFixture({
      capsule: capsule({ currentOutputId: OUTPUT_ID }),
      onGetOutput: () => {
        reads += 1;
      },
    }),
    "GET",
    "subject_other",
  );

  expect(response.status).toBe(403);
  expect(reads).toBe(0);
});

test("session Capsule Output route rejects non-GET methods", async () => {
  const response = await readOutput(
    operationsFixture({ capsule: capsule() }),
    "POST",
  );

  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET");
});

test("public Capsule Output route requires an account session", async () => {
  const store = new InMemoryAccountsStore();
  const request = new Request(
    `https://app.example.test/api/v1/capsules/${CAPSULE_ID}/outputs`,
  );
  const response = await handleControlRoute({
    request,
    url: new URL(request.url),
    store,
    operations: operationsFixture({ capsule: capsule() }),
  });

  expect(response?.status).toBe(401);
});
