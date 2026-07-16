import assert from "node:assert/strict";
import { test } from "bun:test";
import type {
  CloudflareWorkerEnv,
  R2Bucket,
  R2ListOptions,
  R2Object,
  R2ObjectBody,
  R2Objects,
  R2PutOptions,
} from "../../../worker/src/bindings.ts";
import {
  type ContainerRequestFetcher,
  OpenTofuRunnerObject,
} from "../../../worker/src/durable/OpenTofuRunnerObject.ts";
import { StateArtifactCrypto } from "../../../worker/src/state_crypto.ts";

const TEST_PASSPHRASE = "takosumi-runner-r2-state-test-passphrase-0123456789";
const PLAN_BYTES = new TextEncoder().encode("reviewed tfplan bytes");
const PLAN_DIGEST =
  "sha256:0fd9817656d95201f5c8073b9b4b4c2d5bfe8468b69e7bf771e5311b122a90e7";
const NEW_STATE_BYTES = new TextEncoder().encode('{"version":4,"serial":2}');

const STATE_PREFIX =
  "workspaces/spc_1/capsules/inst_1/environments/production/state-versions";
const NEXT_STATE_KEY = `${STATE_PREFIX}/00000002.tfstate.enc`;
const CURRENT_KEY = `${STATE_PREFIX}/current.json`;
const RAW_OUTPUT_REF =
  "workspaces/spc_1/capsules/inst_1/runs/plan_1/outputs.raw.json.enc";
const SCOPE = {
  workspaceId: "spc_1",
  subject: { kind: "capsule", id: "inst_1" },
  environment: "production",
  generation: 2,
  stateRef: NEXT_STATE_KEY,
} as const;
const RESOURCE_STATE_PREFIX =
  "workspaces/spc_1/resources/tkrn_spc_1_EdgeWorker_api/environments/production/state-versions";
const RESOURCE_NEXT_STATE_KEY = `${RESOURCE_STATE_PREFIX}/00000002.tfstate.enc`;
const RESOURCE_CURRENT_KEY = `${RESOURCE_STATE_PREFIX}/current.json`;
const RESOURCE_RAW_OUTPUT_REF =
  "workspaces/spc_1/resources/tkrn_spc_1_EdgeWorker_api/runs/plan_1/outputs.raw.json.enc";
const RESOURCE_SCOPE = {
  workspaceId: "spc_1",
  subject: { kind: "resource", id: "tkrn:spc_1:EdgeWorker:api" },
  environment: "production",
  generation: 2,
  stateRef: RESOURCE_NEXT_STATE_KEY,
} as const;
const LEGACY_ADOPTION_PREFIX =
  "spaces/spc_1/installations/cap_legacy_edge_api/envs/resource-shape/states";
const LEGACY_ADOPTION_KEY = `${LEGACY_ADOPTION_PREFIX}/00000007.tfstate.enc`;

function legacyStateAdoption(digest: string) {
  return {
    kind: "legacy_backing_capsule_state",
    sourceWorkspaceId: "spc_1",
    sourceCapsuleId: "cap_legacy_edge_api",
    sourceEnvironment: "resource-shape",
    sourceStateVersionId: "state_legacy_7",
    stateGeneration: 7,
    stateRef: LEGACY_ADOPTION_KEY,
    stateDigest: digest,
    confirmedBy: "operator_1",
    confirmedAt: "2026-07-13T00:00:00.000Z",
  };
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

test("apply with a Resource stateScope persists under the Resource R2_STATE prefix", async () => {
  const calls: string[] = [];
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  // The plan binary is stored encrypted at `.enc`; plaintext plan objects are
  // not valid restore sources.
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await artifacts.put(
    "opentofu-plan-runs/plan_1/tfplan.enc",
    sealedPlan.ciphertext,
  );

  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfplan"
      ) {
        assert.deepEqual(
          new Uint8Array(await request.arrayBuffer()),
          PLAN_BYTES,
        );
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          planArtifact: {
            kind: "runner-local",
            ref: "runner-local://plan_1/tfplan",
            digest: PLAN_DIGEST,
            contentType: "application/vnd.opentofu.plan",
          },
        });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_1/artifacts/tfstate"
      ) {
        return new Response(NEW_STATE_BYTES, {
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_1",
        request: {
          stateScope: RESOURCE_SCOPE,
          rawOutputRef: RESOURCE_RAW_OUTPUT_REF,
          planArtifact: {
            kind: "object-storage",
            ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
            digest: PLAN_DIGEST,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  // No existing current.json, so restore is a no-op; apply runs, then the DO
  // pulls the new state and persists it encrypted, then writes current.json.
  assert.deepEqual(calls, [
    "PUT /runs/plan_1/artifacts/tfplan",
    "POST /runs/plan_1",
    "GET /runs/plan_1/artifacts/tfstate",
  ]);

  // State object is encrypted at rest (not the plaintext).
  const stored = state.body(RESOURCE_NEXT_STATE_KEY);
  assert.ok(stored && stored.byteLength > 0);
  assert.notDeepEqual(stored, NEW_STATE_BYTES);

  // current.json points at the generation object with the PLAINTEXT digest.
  const currentBytes = state.body(RESOURCE_CURRENT_KEY);
  assert.ok(currentBytes);
  const current = JSON.parse(new TextDecoder().decode(currentBytes)) as {
    generation: number;
    objectKey: string;
    digest: string;
  };
  assert.equal(current.generation, 2);
  assert.equal(current.objectKey, RESOURCE_NEXT_STATE_KEY);
  assert.equal(current.digest, await digestOf(NEW_STATE_BYTES));

  // The stored ciphertext decrypts back to the plaintext (digest verified).
  const opened = await crypto.open(stored!, current.digest);
  assert.deepEqual(opened, NEW_STATE_BYTES);

  // The response surfaces the state pointer for the controller's ledger.
  const payload = (await response.json()) as Record<string, unknown>;
  const stateField = payload.state as Record<string, unknown>;
  assert.equal(stateField.generation, 2);
  assert.equal(stateField.stateRef, RESOURCE_NEXT_STATE_KEY);
  assert.equal(stateField.digest, current.digest);
});

test("apply validates rawOutputRef against the Apply Run when the plan container is reused", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const applyRawOutputRef = RESOURCE_RAW_OUTPUT_REF.replace(
    "/runs/plan_1/",
    "/runs/apply_1/",
  );
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await artifacts.put(
    "opentofu-plan-runs/plan_1/tfplan.enc",
    sealedPlan.ciphertext,
  );
  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT") return Response.json({ ok: true });
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({ status: "succeeded", outputs: {} });
      }
      if (request.method === "GET" && path.endsWith("/artifacts/tfstate")) {
        return new Response(NEW_STATE_BYTES);
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_1",
        request: {
          applyRun: { id: "apply_1" },
          stateScope: RESOURCE_SCOPE,
          rawOutputRef: applyRawOutputRef,
          planArtifact: {
            kind: "object-storage",
            ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
            digest: PLAN_DIGEST,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(
    ((await response.json()) as Record<string, unknown>).rawOutputRef,
    applyRawOutputRef,
  );
});

test("confirmed adoption restores only the exact legacy state and writes the next state under the Resource prefix", async () => {
  const calls: string[] = [];
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const legacyState = new TextEncoder().encode('{"version":4,"serial":7}');
  const sealedLegacy = await crypto.seal(legacyState);
  await state.put(LEGACY_ADOPTION_KEY, sealedLegacy.ciphertext, {
    customMetadata: {
      "takosumi-content-digest": sealedLegacy.contentDigest,
      "takosumi-run-id": "run_legacy_apply",
    },
  });
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await artifacts.put(
    "opentofu-plan-runs/plan_adopt/tfplan.enc",
    sealedPlan.ciphertext,
  );
  const canonicalKey = `${RESOURCE_STATE_PREFIX}/00000008.tfstate.enc`;
  const resourceScope = {
    ...RESOURCE_SCOPE,
    generation: 8,
    stateRef: canonicalKey,
  };

  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (
        request.method === "PUT" &&
        path === "/runs/plan_adopt/artifacts/tfplan"
      ) {
        return Response.json({ ok: true });
      }
      if (
        request.method === "PUT" &&
        path === "/runs/plan_adopt/artifacts/tfstate"
      ) {
        assert.deepEqual(
          new Uint8Array(await request.arrayBuffer()),
          legacyState,
        );
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_adopt") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_adopt/artifacts/tfstate"
      ) {
        return new Response(NEW_STATE_BYTES);
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_adopt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_adopt",
        request: {
          stateScope: resourceScope,
          rawOutputRef:
            "workspaces/spc_1/resources/tkrn_spc_1_EdgeWorker_api/runs/plan_adopt/outputs.raw.json.enc",
          stateAdoption: legacyStateAdoption(sealedLegacy.contentDigest),
          planArtifact: {
            kind: "object-storage",
            ref: "r2://takos-artifacts/opentofu-plan-runs/plan_adopt/tfplan",
            digest: PLAN_DIGEST,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "PUT /runs/plan_adopt/artifacts/tfplan",
    "PUT /runs/plan_adopt/artifacts/tfstate",
    "POST /runs/plan_adopt",
    "GET /runs/plan_adopt/artifacts/tfstate",
  ]);
  assert.ok(state.body(LEGACY_ADOPTION_KEY));
  assert.ok(state.body(canonicalKey));
  const currentBytes = state.body(RESOURCE_CURRENT_KEY);
  assert.ok(currentBytes);
  const current = JSON.parse(new TextDecoder().decode(currentBytes)) as {
    generation: number;
    objectKey: string;
  };
  assert.equal(current.generation, 8);
  assert.equal(current.objectKey, canonicalKey);
});

test("confirmed adoption is refused when canonical Resource state already exists", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const legacyState = new TextEncoder().encode('{"version":4,"serial":7}');
  const sealedLegacy = await crypto.seal(legacyState);
  await state.put(LEGACY_ADOPTION_KEY, sealedLegacy.ciphertext, {
    customMetadata: {
      "takosumi-content-digest": sealedLegacy.contentDigest,
    },
  });
  const canonicalKey = `${RESOURCE_STATE_PREFIX}/00000007.tfstate.enc`;
  const canonicalState = new TextEncoder().encode('{"version":4,"serial":700}');
  const sealedCanonical = await crypto.seal(canonicalState);
  await state.put(canonicalKey, sealedCanonical.ciphertext, {
    customMetadata: {
      "takosumi-content-digest": sealedCanonical.contentDigest,
    },
  });
  await state.put(
    RESOURCE_CURRENT_KEY,
    JSON.stringify({
      generation: 7,
      objectKey: canonicalKey,
      digest: sealedCanonical.contentDigest,
    }),
  );
  let containerCalled = false;
  const runner = runnerWithContainer(artifacts, state, {
    containerFetch() {
      containerCalled = true;
      return Promise.resolve(Response.json({ ok: true }));
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_adopt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_adopt",
        request: {
          stateScope: {
            ...RESOURCE_SCOPE,
            generation: 7,
            stateRef: canonicalKey,
          },
          stateAdoption: legacyStateAdoption(sealedLegacy.contentDigest),
        },
      }),
    }),
  );

  assert.equal(response.status, 500);
  assert.equal(containerCalled, false);
  assert.deepEqual(state.body(canonicalKey), sealedCanonical.ciphertext);
});

test("apply with stateScope encrypts the raw outputs envelope to R2_ARTIFACTS and echoes rawOutputRef", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await artifacts.put(
    "opentofu-plan-runs/plan_1/tfplan.enc",
    sealedPlan.ciphertext,
  );

  // The raw `tofu output -json` envelope the runner returns: carries the
  // per-output sensitive flags. The DO seals this verbatim (no projection — the
  // controller projects spaceOutputs/publicOutputs from the same envelope).
  const outputsEnvelope = {
    launch_url: { sensitive: false, value: "https://x.example" },
    admin_token: { sensitive: true, value: "super-secret" },
  };

  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfplan"
      ) {
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          outputs: outputsEnvelope,
        });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_1/artifacts/tfstate"
      ) {
        return new Response(NEW_STATE_BYTES);
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_1",
        request: {
          stateScope: RESOURCE_SCOPE,
          rawOutputRef: RESOURCE_RAW_OUTPUT_REF,
          planArtifact: {
            kind: "object-storage",
            ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
            digest: PLAN_DIGEST,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  const rawOutputRef = payload.rawOutputRef as string;
  assert.equal(rawOutputRef, RESOURCE_RAW_OUTPUT_REF);

  // The object is encrypted at rest (not the plaintext JSON).
  const stored = artifacts.body(rawOutputRef);
  assert.ok(stored && stored.byteLength > 0);
  const plaintextJson = new TextEncoder().encode(
    JSON.stringify(outputsEnvelope),
  );
  assert.notDeepEqual(stored, plaintextJson);

  // It decrypts back to the EXACT raw envelope (sensitive flags intact).
  const opened = await crypto.open(stored!);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(opened)),
    outputsEnvelope,
  );
});

test("apply rejects a rawOutputRef outside the canonical subject and Run path", async () => {
  let containerCalled = false;
  const runner = runnerWithContainer(new FakeR2Bucket(), new FakeR2Bucket(), {
    containerFetch() {
      containerCalled = true;
      return Promise.resolve(Response.json({ ok: true }));
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_1",
        request: {
          stateScope: RESOURCE_SCOPE,
          rawOutputRef:
            "workspaces/spc_1/capsules/other/runs/plan_1/outputs.raw.json.enc",
        },
      }),
    }),
  );

  assert.equal(response.status, 500);
  assert.equal(containerCalled, false);
});

test("apply with stateScope adopts same-run completed state without reapplying", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const targetStateKey = `${STATE_PREFIX}/00000001.tfstate.enc`;
  const targetScope = {
    ...SCOPE,
    generation: 1,
    stateRef: targetStateKey,
  };
  const completedState = new TextEncoder().encode('{"version":4,"serial":1}');
  const sealedState = await crypto.seal(completedState);
  await state.put(targetStateKey, sealedState.ciphertext, {
    customMetadata: {
      "takosumi-run-id": "plan_1",
      "takosumi-content-digest": sealedState.contentDigest,
      "takosumi-ciphertext-length": String(sealedState.ciphertextLength),
    },
  });
  await state.put(
    CURRENT_KEY,
    JSON.stringify({
      generation: 1,
      objectKey: targetStateKey,
      digest: sealedState.contentDigest,
      runId: "plan_1",
      ciphertextLength: sealedState.ciphertextLength,
    }),
    {
      customMetadata: { "takosumi-run-id": "plan_1" },
    },
  );
  const outputsEnvelope = {
    launch_url: { sensitive: false, value: "https://x.example" },
  };
  const sealedOutputs = await crypto.seal(
    new TextEncoder().encode(JSON.stringify(outputsEnvelope)),
  );
  await artifacts.put(RAW_OUTPUT_REF, sealedOutputs.ciphertext, {
    customMetadata: {
      "takosumi-run-id": "plan_1",
      "takosumi-content-digest": sealedOutputs.contentDigest,
      "takosumi-ciphertext-length": String(sealedOutputs.ciphertextLength),
    },
  });

  let containerCalled = false;
  const runner = runnerWithContainer(artifacts, state, {
    containerFetch() {
      containerCalled = true;
      return Promise.resolve(
        Response.json({ error: "should not reapply" }, { status: 500 }),
      );
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_1",
        request: {
          stateScope: targetScope,
          rawOutputRef: RAW_OUTPUT_REF,
          planArtifact: {
            kind: "object-storage",
            ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
            digest: PLAN_DIGEST,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(containerCalled, false);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(payload.outputs, outputsEnvelope);
  assert.equal(payload.rawOutputRef, RAW_OUTPUT_REF);
  const stateField = payload.state as Record<string, unknown>;
  assert.equal(stateField.generation, 1);
  assert.equal(stateField.stateRef, targetStateKey);
  assert.equal(stateField.digest, sealedState.contentDigest);
});

test("apply with stateScope does not adopt another run's target generation", async () => {
  const calls: string[] = [];
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const targetStateKey = `${STATE_PREFIX}/00000001.tfstate.enc`;
  const completedState = new TextEncoder().encode('{"version":4,"serial":1}');
  const sealedState = await crypto.seal(completedState);
  await state.put(targetStateKey, sealedState.ciphertext, {
    customMetadata: {
      "takosumi-run-id": "other_apply",
      "takosumi-content-digest": sealedState.contentDigest,
    },
  });
  await state.put(
    CURRENT_KEY,
    JSON.stringify({
      generation: 1,
      objectKey: targetStateKey,
      digest: sealedState.contentDigest,
      runId: "other_apply",
    }),
  );
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await artifacts.put(
    "opentofu-plan-runs/plan_1/tfplan.enc",
    sealedPlan.ciphertext,
  );

  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfplan"
      ) {
        return Response.json({ ok: true });
      }
      return Response.json({ error: "should not run" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_1",
        request: {
          stateScope: {
            ...SCOPE,
            generation: 1,
            stateRef: targetStateKey,
          },
          rawOutputRef: RAW_OUTPUT_REF,
          planArtifact: {
            kind: "object-storage",
            ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
            digest: PLAN_DIGEST,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 500);
  assert.deepEqual(calls, ["PUT /runs/plan_1/artifacts/tfplan"]);
});

test("apply with stateScope restores the encrypted current state before apply", async () => {
  const calls: string[] = [];
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  // Seed generation 1 as the current state.
  const priorState = new TextEncoder().encode('{"version":4,"serial":1}');
  const priorKey = `${STATE_PREFIX}/00000001.tfstate.enc`;
  const sealedPrior = await crypto.seal(priorState);
  await state.put(priorKey, sealedPrior.ciphertext);
  await state.put(
    CURRENT_KEY,
    JSON.stringify({
      generation: 1,
      objectKey: priorKey,
      digest: sealedPrior.contentDigest,
    }),
  );

  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await artifacts.put(
    "opentofu-plan-runs/plan_1/tfplan.enc",
    sealedPlan.ciphertext,
  );

  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfplan"
      ) {
        return Response.json({ ok: true });
      }
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfstate"
      ) {
        // The DO must hand the container the DECRYPTED prior state.
        assert.deepEqual(
          new Uint8Array(await request.arrayBuffer()),
          priorState,
        );
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          planArtifact: {
            kind: "runner-local",
            ref: "runner-local://plan_1/tfplan",
            digest: PLAN_DIGEST,
            contentType: "application/vnd.opentofu.plan",
          },
        });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_1/artifacts/tfstate"
      ) {
        return new Response(NEW_STATE_BYTES);
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_1",
        request: {
          stateScope: SCOPE,
          rawOutputRef: RAW_OUTPUT_REF,
          planArtifact: {
            kind: "object-storage",
            ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
            digest: PLAN_DIGEST,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "PUT /runs/plan_1/artifacts/tfplan",
    "PUT /runs/plan_1/artifacts/tfstate",
    "POST /runs/plan_1",
    "GET /runs/plan_1/artifacts/tfstate",
  ]);
});

test("plan with stateScope reconciles missing current.json from the latest sealed generation object", async () => {
  const calls: string[] = [];
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const generationOne = new TextEncoder().encode('{"version":4,"serial":1}');
  const generationTwo = new TextEncoder().encode('{"version":4,"serial":2}');
  const sealedOne = await crypto.seal(generationOne);
  const sealedTwo = await crypto.seal(generationTwo);
  await state.put(
    `${STATE_PREFIX}/00000001.tfstate.enc`,
    sealedOne.ciphertext,
    {
      customMetadata: { "takosumi-content-digest": sealedOne.contentDigest },
    },
  );
  await state.put(
    `${STATE_PREFIX}/00000002.tfstate.enc`,
    sealedTwo.ciphertext,
    {
      customMetadata: { "takosumi-content-digest": sealedTwo.contentDigest },
    },
  );

  let restoredState: Uint8Array | undefined;
  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfstate"
      ) {
        restoredState = new Uint8Array(await request.arrayBuffer());
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          planArtifact: {
            kind: "runner-local",
            ref: "runner-local://plan_1/tfplan",
            digest: PLAN_DIGEST,
            contentType: "application/vnd.opentofu.plan",
          },
        });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_1/artifacts/tfplan"
      ) {
        return new Response(PLAN_BYTES);
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_1/artifacts/tfplan-json"
      ) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: { stateScope: { ...SCOPE, generation: 2 } },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(restoredState, generationTwo);
  assert.deepEqual(calls, [
    "PUT /runs/plan_1/artifacts/tfstate",
    "POST /runs/plan_1",
    "GET /runs/plan_1/artifacts/tfplan",
    "GET /runs/plan_1/artifacts/tfplan-json",
  ]);
  const payload = (await response.json()) as Record<string, unknown>;
  const artifact = payload.planArtifact as Record<string, unknown>;
  assert.equal(
    artifact.ref,
    "r2://takos-artifacts/workspaces/spc_1/capsules/inst_1/runs/plan_1/plan.bin",
  );
  assert.ok(
    artifacts.body("workspaces/spc_1/capsules/inst_1/runs/plan_1/plan.bin.enc"),
  );
  const currentBytes = state.body(CURRENT_KEY);
  assert.ok(currentBytes);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(currentBytes)), {
    generation: 2,
    objectKey: `${STATE_PREFIX}/00000002.tfstate.enc`,
    digest: sealedTwo.contentDigest,
  });
});

test("apply with stateScope reconciles only the previous generation before writing a new state", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const generationOne = new TextEncoder().encode('{"version":4,"serial":1}');
  const generationTwo = new TextEncoder().encode('{"version":4,"serial":2}');
  const sealedOne = await crypto.seal(generationOne);
  const sealedTwo = await crypto.seal(generationTwo);
  await state.put(
    `${STATE_PREFIX}/00000001.tfstate.enc`,
    sealedOne.ciphertext,
    {
      customMetadata: { "takosumi-content-digest": sealedOne.contentDigest },
    },
  );
  // Simulate a previous failed write that left the target generation object
  // behind. Apply generation 2 must NOT restore this as the prior state.
  await state.put(
    `${STATE_PREFIX}/00000002.tfstate.enc`,
    sealedTwo.ciphertext,
    {
      customMetadata: { "takosumi-content-digest": sealedTwo.contentDigest },
    },
  );
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await artifacts.put(
    "opentofu-plan-runs/plan_1/tfplan.enc",
    sealedPlan.ciphertext,
  );

  let restoredState: Uint8Array | undefined;
  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfplan"
      ) {
        return Response.json({ ok: true });
      }
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfstate"
      ) {
        restoredState = new Uint8Array(await request.arrayBuffer());
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_1/artifacts/tfstate"
      ) {
        return new Response(NEW_STATE_BYTES);
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_1",
        request: {
          stateScope: { ...SCOPE, generation: 2 },
          rawOutputRef: RAW_OUTPUT_REF,
          planArtifact: {
            kind: "object-storage",
            ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
            digest: PLAN_DIGEST,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(restoredState, generationOne);
});

test("state restore fails closed when the stored ciphertext is tampered", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const priorState = new TextEncoder().encode('{"version":4,"serial":1}');
  const priorKey = `${STATE_PREFIX}/00000001.tfstate.enc`;
  const sealedPrior = await crypto.seal(priorState);
  // Flip a byte in the persisted ciphertext.
  const tampered = new Uint8Array(sealedPrior.ciphertext);
  tampered[tampered.length - 1] ^= 0x01;
  await state.put(priorKey, tampered);
  await state.put(
    CURRENT_KEY,
    JSON.stringify({
      generation: 1,
      objectKey: priorKey,
      digest: sealedPrior.contentDigest,
    }),
  );
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await artifacts.put(
    "opentofu-plan-runs/plan_1/tfplan.enc",
    sealedPlan.ciphertext,
  );

  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfplan"
      ) {
        return Response.json({ ok: true });
      }
      // The state restore must fail before any state PUT reaches the container.
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_1",
        request: {
          stateScope: SCOPE,
          rawOutputRef: RAW_OUTPUT_REF,
          planArtifact: {
            kind: "object-storage",
            ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
            digest: PLAN_DIGEST,
          },
        },
      }),
    }),
  );

  // The DO surfaces the failure as a 500 (fail closed); no new state written.
  assert.equal(response.status, 500);
  assert.equal(state.body(NEXT_STATE_KEY), undefined);
});

test("plan with depStates fetches + decrypts the producer state into /work/deps", async () => {
  const calls: string[] = [];
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  // The PRODUCER state (another Installation) sealed in R2_STATE at gen 3.
  const producerState = new TextEncoder().encode(
    '{"version":4,"serial":3,"outputs":{"base_domain":{"value":"x"}}}',
  );
  const producerPrefix =
    "workspaces/spc_1/capsules/inst_producer/environments/production/state-versions";
  const producerKey = `${producerPrefix}/00000003.tfstate.enc`;
  const sealedProducer = await crypto.seal(producerState);
  await state.put(producerKey, sealedProducer.ciphertext);

  let restoredDep: Uint8Array | undefined;
  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/deps/producer/restore"
      ) {
        // The DO must hand the container the DECRYPTED producer state.
        restoredDep = new Uint8Array(await request.arrayBuffer());
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {
          // The consumer's own env state scope (gen 1).
          stateScope: {
            ...SCOPE,
            generation: 1,
            stateRef: `${STATE_PREFIX}/00000001.tfstate.enc`,
          },
          // One remote_state dependency on the producer Installation.
          depStates: [
            {
              name: "producer",
              capsuleId: "inst_producer",
              environment: "production",
              generation: 3,
              stateRef: producerKey,
              digest: sealedProducer.contentDigest,
            },
          ],
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  // The dep state is restored BEFORE the run POST.
  assert.deepEqual(calls, [
    "PUT /runs/plan_1/deps/producer/restore",
    "POST /runs/plan_1",
  ]);
  // The bytes handed to the container decrypt-match the producer plaintext.
  assert.ok(restoredDep);
  assert.deepEqual(restoredDep, producerState);
});

test("depStates restore fails closed when the producer ciphertext is tampered", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const producerState = new TextEncoder().encode('{"version":4,"serial":3}');
  const producerKey =
    "workspaces/spc_1/capsules/inst_producer/environments/production/state-versions/00000003.tfstate.enc";
  const sealedProducer = await crypto.seal(producerState);
  const tampered = new Uint8Array(sealedProducer.ciphertext);
  tampered[tampered.length - 1] ^= 0x01;
  await state.put(producerKey, tampered);

  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      // The dep restore must fail before the run POST reaches the container.
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({ error: "should not run" }, { status: 500 });
      }
      return Response.json({ ok: true });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {
          stateScope: {
            ...SCOPE,
            generation: 1,
            stateRef: `${STATE_PREFIX}/00000001.tfstate.enc`,
          },
          depStates: [
            {
              name: "producer",
              capsuleId: "inst_producer",
              environment: "production",
              generation: 3,
              stateRef: producerKey,
              digest: sealedProducer.contentDigest,
            },
          ],
        },
      }),
    }),
  );

  // Fail closed: the DO surfaces a 500 and never reaches the run POST.
  assert.equal(response.status, 500);
});

test("depStates restore rejects a stateRef that escapes the producer prefix", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const producerState = new TextEncoder().encode('{"version":4,"serial":3}');
  // A key that does NOT match the descriptor's installationId/environment prefix.
  const crossTenantKey =
    "workspaces/spc_1/capsules/inst_other/environments/production/state-versions/00000003.tfstate.enc";
  const sealedProducer = await crypto.seal(producerState);
  await state.put(crossTenantKey, sealedProducer.ciphertext);

  const runner = runnerWithContainer(artifacts, state, {
    containerFetch() {
      return Promise.resolve(
        Response.json({ error: "should not run" }, { status: 500 }),
      );
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {
          stateScope: {
            ...SCOPE,
            generation: 1,
            stateRef: `${STATE_PREFIX}/00000001.tfstate.enc`,
          },
          depStates: [
            {
              name: "producer",
              capsuleId: "inst_producer",
              environment: "production",
              generation: 3,
              stateRef: crossTenantKey,
              digest: sealedProducer.contentDigest,
            },
          ],
        },
      }),
    }),
  );

  // The path-jail rejects the mismatched stateRef -> 500, no container call.
  assert.equal(response.status, 500);
});

test("legacy apply without stateScope keeps using the R2_ARTIFACTS state path", async () => {
  const calls: string[] = [];
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const stateBackendRef = "state://takosumi/opentofu-default";
  const legacyStateKey = `${await legacyBackendPrefix(stateBackendRef)}/capsules/inst_1/terraform.tfstate`;
  const priorState = new TextEncoder().encode('{"serial":1}');
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const sealedPriorState = await crypto.seal(priorState);
  await artifacts.put(`${legacyStateKey}.enc`, sealedPriorState.ciphertext, {
    customMetadata: {
      "takosumi-content-digest": sealedPriorState.contentDigest,
    },
  });
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await artifacts.put(
    "opentofu-plan-runs/plan_1/tfplan.enc",
    sealedPlan.ciphertext,
    {
      customMetadata: { "takosumi-content-digest": sealedPlan.contentDigest },
    },
  );

  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfplan"
      ) {
        return Response.json({ ok: true });
      }
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfstate"
      ) {
        assert.deepEqual(
          new Uint8Array(await request.arrayBuffer()),
          priorState,
        );
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_1/artifacts/tfstate"
      ) {
        return new Response(NEW_STATE_BYTES);
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_1",
        request: {
          planRun: {
            id: "plan_1",
            capsuleId: "inst_1",
            workspaceId: "spc_1",
            runnerProfileId: "opentofu-default",
            source: {
              kind: "git",
              url: "https://github.com/example/app.git",
              ref: "main",
            },
          },
          runnerProfile: {
            id: "opentofu-default",
            stateBackend: { kind: "operator-managed", ref: stateBackendRef },
          },
          planArtifact: {
            kind: "object-storage",
            ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
            digest: PLAN_DIGEST,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  // Legacy path also persists encrypted state in R2_ARTIFACTS, and never
  // touches R2_STATE.
  assert.equal(artifacts.body(legacyStateKey), undefined);
  const encryptedLegacyState = artifacts.body(`${legacyStateKey}.enc`);
  assert.ok(encryptedLegacyState);
  assert.deepEqual(
    await crypto.open(encryptedLegacyState, await digestOf(NEW_STATE_BYTES)),
    NEW_STATE_BYTES,
  );
  assert.equal(state.body(NEXT_STATE_KEY), undefined);
  assert.equal(state.body(CURRENT_KEY), undefined);
});

async function legacyBackendPrefix(ref: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ref),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `opentofu-state/backends/${hex}`;
}

function runnerWithContainer(
  artifacts: R2Bucket,
  stateBucket: R2Bucket,
  container: ContainerRequestFetcher,
): OpenTofuRunnerObject {
  const runner = new OpenTofuRunnerObject({ storage: new FakeDoStorage() }, {
    TAKOSUMI_CONTROL_DB: {} as CloudflareWorkerEnv["TAKOSUMI_CONTROL_DB"],
    R2_ARTIFACTS: artifacts,
    R2_STATE: stateBucket,
    COORDINATION: {} as CloudflareWorkerEnv["COORDINATION"],
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  } as CloudflareWorkerEnv);
  Object.defineProperty(runner, "containerFetch", {
    value(request: Request, _port?: number) {
      if (new URL(request.url).pathname === "/healthz") {
        return Response.json({ ok: true });
      }
      return container.containerFetch(request);
    },
  });
  return runner;
}

class FakeDoStorage {
  #values = new Map<string, unknown>();

  get<T = unknown>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.#values.get(key) as T | undefined);
  }

  put<T = unknown>(key: string, value: T): Promise<void> {
    this.#values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.#values.delete(key));
  }
}

class FakeR2Bucket implements R2Bucket {
  readonly #objects = new Map<string, FakeR2ObjectBody>();

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const bytes = await bytesFromR2PutValue(value);
    const object = new FakeR2ObjectBody(key, bytes, options);
    this.#objects.set(key, object);
    return object;
  }

  get(key: string): Promise<R2ObjectBody | null> {
    return Promise.resolve(this.#objects.get(key) ?? null);
  }

  head(key: string): Promise<R2Object | null> {
    return Promise.resolve(this.#objects.get(key) ?? null);
  }

  list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    return Promise.resolve({
      objects: Array.from(this.#objects.values()).filter((object) =>
        object.key.startsWith(prefix),
      ),
      truncated: false,
    });
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }

  body(key: string): Uint8Array | undefined {
    return this.#objects.get(key)?.bytes;
  }
}

class FakeR2ObjectBody implements R2ObjectBody {
  readonly size: number;
  readonly etag = "etag";
  readonly uploaded = new Date("2026-06-06T00:00:00.000Z");
  readonly httpMetadata?: R2Object["httpMetadata"];
  readonly customMetadata?: Record<string, string>;

  constructor(
    readonly key: string,
    readonly bytes: Uint8Array,
    options?: R2PutOptions,
  ) {
    this.size = bytes.byteLength;
    this.httpMetadata = options?.httpMetadata;
    this.customMetadata = options?.customMetadata;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    const copy = new Uint8Array(this.bytes);
    return Promise.resolve(copy.buffer);
  }
}

async function bytesFromR2PutValue(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}
