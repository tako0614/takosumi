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

async function seedCanonicalPriorState(
  bucket: FakeR2Bucket,
  scope: {
    readonly generation: number;
    readonly stateRef: string;
  },
  plaintext = new TextEncoder().encode('{"version":4,"serial":1}'),
  createdByRunId = "apply_prior",
) {
  const generation = scope.generation - 1;
  assert.ok(generation > 0);
  const stateRef = scope.stateRef.replace(
    /\d{8}\.tfstate\.enc$/,
    `${String(generation).padStart(8, "0")}.tfstate.enc`,
  );
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const sealed = await crypto.seal(plaintext);
  await bucket.put(stateRef, sealed.ciphertext, {
    customMetadata: {
      "takosumi-content-digest": sealed.contentDigest,
      "takosumi-run-id": createdByRunId,
      "takosumi-generation": String(generation),
      "takosumi-ciphertext-length": String(sealed.ciphertextLength),
    },
  });
  return {
    generation,
    stateRef,
    digest: sealed.contentDigest,
    createdByRunId,
  };
}

test("apply with a Resource stateScope persists under the Resource R2_STATE prefix", async () => {
  const calls: string[] = [];
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket(1);
  // The plan binary is stored encrypted at `.enc`; plaintext plan objects are
  // not valid restore sources.
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  const priorState = await seedCanonicalPriorState(state, RESOURCE_SCOPE);
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
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfstate"
      ) {
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
          applyRun: { id: "plan_1" },
          stateScope: { ...RESOURCE_SCOPE, priorState },
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
    "PUT /runs/plan_1/artifacts/tfstate",
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

test("oversized chunked state with a forged Content-Length fails with no partial persistence", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  const priorState = await seedCanonicalPriorState(state, RESOURCE_SCOPE);
  await artifacts.put(
    "opentofu-plan-runs/plan_1/tfplan.enc",
    sealedPlan.ciphertext,
  );
  const stateLimit = 32;
  const oversizedState = new Uint8Array(stateLimit + 1).fill(0x61);
  const runner = runnerWithContainer(
    artifacts,
    state,
    {
      async containerFetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === "PUT") return Response.json({ ok: true });
        if (request.method === "POST" && path === "/runs/plan_1") {
          return Response.json({ status: "succeeded", exitCode: 0 });
        }
        if (
          request.method === "GET" &&
          path === "/runs/plan_1/artifacts/tfstate"
        ) {
          let offset = 0;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (offset >= oversizedState.byteLength) {
                  controller.close();
                  return;
                }
                const end = Math.min(offset + 17, oversizedState.byteLength);
                controller.enqueue(oversizedState.slice(offset, end));
                offset = end;
              },
            }),
            {
              // Deliberately forged smaller than the real chunked body. The
              // streaming count, not this header, must enforce the limit.
              headers: { "content-length": "1" },
            },
          );
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    },
    { TAKOSUMI_RUNNER_STATE_ARTIFACT_MAX_BYTES: String(stateLimit) },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_1",
        request: {
          applyRun: { id: "plan_1" },
          stateScope: { ...RESOURCE_SCOPE, priorState },
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

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: "OpenTofu runner artifact exceeds configured byte limit",
    errorCode: "artifact_size_limit_exceeded",
    artifact: "state",
    maxBytes: stateLimit,
    observedBytes: stateLimit + 1,
  });
  assert.equal(state.body(RESOURCE_NEXT_STATE_KEY), undefined);
  assert.equal(state.body(RESOURCE_CURRENT_KEY), undefined);
  assert.equal(artifacts.body(RESOURCE_RAW_OUTPUT_REF), undefined);
});

test("oversized raw outputs fail before state, pointer, or output persistence", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  const priorState = await seedCanonicalPriorState(state, RESOURCE_SCOPE);
  await artifacts.put(
    "opentofu-plan-runs/plan_1/tfplan.enc",
    sealedPlan.ciphertext,
  );
  const outputLimit = 32;
  const runner = runnerWithContainer(
    artifacts,
    state,
    {
      async containerFetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === "PUT") return Response.json({ ok: true });
        if (request.method === "POST" && path === "/runs/plan_1") {
          return Response.json({
            status: "succeeded",
            exitCode: 0,
            outputs: {
              endpoint: { sensitive: false, value: "x".repeat(64) },
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
    },
    { TAKOSUMI_RUNNER_OUTPUT_ARTIFACT_MAX_BYTES: String(outputLimit) },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_1",
        request: {
          applyRun: { id: "plan_1" },
          stateScope: { ...RESOURCE_SCOPE, priorState },
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

  assert.equal(response.status, 413);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.errorCode, "artifact_size_limit_exceeded");
  assert.equal(payload.artifact, "output");
  assert.equal(state.body(RESOURCE_NEXT_STATE_KEY), undefined);
  assert.equal(state.body(RESOURCE_CURRENT_KEY), undefined);
  assert.equal(artifacts.body(RESOURCE_RAW_OUTPUT_REF), undefined);
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
  const priorState = await seedCanonicalPriorState(state, RESOURCE_SCOPE);
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
          stateScope: { ...RESOURCE_SCOPE, priorState },
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
          applyRun: { id: "plan_adopt" },
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
  const priorState = await seedCanonicalPriorState(state, RESOURCE_SCOPE);
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
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfstate"
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
          applyRun: { id: "plan_1" },
          stateScope: { ...RESOURCE_SCOPE, priorState },
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
  assert.equal(
    state.metadata(RESOURCE_NEXT_STATE_KEY)?.["takosumi-action"],
    "apply",
  );
  assert.equal(
    artifacts.metadata(rawOutputRef)?.["takosumi-action"],
    "apply",
  );

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
          applyRun: { id: "plan_1" },
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
      "takosumi-action": "apply",
      "takosumi-content-digest": sealedState.contentDigest,
      "takosumi-generation": "1",
      "takosumi-raw-output-ref": RAW_OUTPUT_REF,
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
      "takosumi-action": "apply",
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
          applyRun: { id: "plan_1" },
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

test("apply redelivery adopts the exact ApplyRun artifacts after R2 responses are lost", async () => {
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
  const applyRunId = "apply_1";
  const targetStateRef = `${STATE_PREFIX}/00000001.tfstate.enc`;
  state.failNextPutResponse(
    targetStateRef,
    new Error("injected ambiguous target put response"),
  );
  const rawOutputRef = RAW_OUTPUT_REF.replace("/runs/plan_1/", `/runs/${applyRunId}/`);
  artifacts.failNextPutResponse(
    rawOutputRef,
    new Error("injected ambiguous raw-output put response"),
  );
  let providerPosts = 0;
  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT") return Response.json({ ok: true });
      if (request.method === "POST" && path === "/runs/plan_1") {
        providerPosts += 1;
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          outputs: {
            launch_url: { sensitive: false, value: "https://x.example" },
          },
        });
      }
      if (request.method === "GET" && path.endsWith("/artifacts/tfstate")) {
        return new Response(NEW_STATE_BYTES);
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });
  const requestBody = JSON.stringify({
    kind: "takosumi.opentofu-run@v1",
    action: "apply",
    runId: "plan_1",
    request: {
      applyRun: { id: applyRunId },
      stateScope: { ...SCOPE, generation: 1, stateRef: targetStateRef },
      rawOutputRef,
      planArtifact: {
        kind: "object-storage",
        ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
        digest: PLAN_DIGEST,
      },
    },
  });

  const first = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }),
  );
  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), {
    error:
      "OpenTofu runner artifact durability acknowledgement is ambiguous",
    errorCode: "runner_artifact_relay_ambiguous",
    retryable: true,
    detail:
      "redeliver the same ApplyRun; its immutable target will be adopted if the write committed",
  });

  const second = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }),
  );
  assert.equal(second.status, 200);
  assert.equal(providerPosts, 1);
  assert.equal(
    state.metadata(`${STATE_PREFIX}/00000001.tfstate.enc`)?.[
      "takosumi-run-id"
    ],
    applyRunId,
  );
  assert.equal(state.listCalls.length, 0);
});

test("destroy with stateScope adopts same-run completed state without destroying twice", async () => {
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
  const completedState = new TextEncoder().encode(
    '{"version":4,"serial":2,"resources":[]}',
  );
  const sealedState = await crypto.seal(completedState);
  await state.put(targetStateKey, sealedState.ciphertext, {
    customMetadata: {
      "takosumi-run-id": "plan_1",
      "takosumi-action": "destroy",
      "takosumi-content-digest": sealedState.contentDigest,
      "takosumi-generation": "1",
      "takosumi-raw-output-status": "none",
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

  let containerCalled = false;
  const runner = runnerWithContainer(artifacts, state, {
    containerFetch() {
      containerCalled = true;
      return Promise.resolve(
        Response.json({ error: "should not destroy twice" }, { status: 500 }),
      );
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "destroy",
        runId: "plan_1",
        request: {
          applyRun: { id: "plan_1" },
          stateScope: targetScope,
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
  assert.equal(payload.status, "succeeded");
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.outputs, undefined);
  assert.equal(payload.rawOutputRef, undefined);
  const stateField = payload.state as Record<string, unknown>;
  assert.equal(stateField.generation, 1);
  assert.equal(stateField.stateRef, targetStateKey);
  assert.equal(stateField.digest, sealedState.contentDigest);
});

test("same-run replay rejects a completed state written for the opposite action before provider I/O", async () => {
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
  const sealedState = await crypto.seal(
    new TextEncoder().encode('{"version":4,"serial":2,"resources":[]}'),
  );
  await state.put(targetStateKey, sealedState.ciphertext, {
    customMetadata: {
      "takosumi-run-id": "plan_1",
      "takosumi-action": "destroy",
      "takosumi-content-digest": sealedState.contentDigest,
      "takosumi-generation": "1",
      "takosumi-raw-output-status": "none",
      "takosumi-ciphertext-length": String(sealedState.ciphertextLength),
    },
  });

  let containerCalled = false;
  const runner = runnerWithContainer(artifacts, state, {
    containerFetch() {
      containerCalled = true;
      return Promise.resolve(
        Response.json({ error: "should not apply" }, { status: 500 }),
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
          applyRun: { id: "plan_1" },
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

  assert.equal(response.status, 500);
  assert.equal(containerCalled, false);
  assert.equal(state.body(CURRENT_KEY), undefined);
});

test("same-run apply replay rejects raw output written for the opposite action before provider I/O", async () => {
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
  const sealedState = await crypto.seal(
    new TextEncoder().encode('{"version":4,"serial":1}'),
  );
  await state.put(targetStateKey, sealedState.ciphertext, {
    customMetadata: {
      "takosumi-run-id": "plan_1",
      "takosumi-action": "apply",
      "takosumi-content-digest": sealedState.contentDigest,
      "takosumi-generation": "1",
      "takosumi-raw-output-ref": RAW_OUTPUT_REF,
      "takosumi-ciphertext-length": String(sealedState.ciphertextLength),
    },
  });
  const sealedOutputs = await crypto.seal(
    new TextEncoder().encode(
      JSON.stringify({
        launch_url: { sensitive: false, value: "https://x.example" },
      }),
    ),
  );
  await artifacts.put(RAW_OUTPUT_REF, sealedOutputs.ciphertext, {
    customMetadata: {
      "takosumi-run-id": "plan_1",
      "takosumi-action": "destroy",
      "takosumi-content-digest": sealedOutputs.contentDigest,
      "takosumi-ciphertext-length": String(sealedOutputs.ciphertextLength),
    },
  });

  let containerCalled = false;
  const runner = runnerWithContainer(artifacts, state, {
    containerFetch() {
      containerCalled = true;
      return Promise.resolve(
        Response.json({ error: "should not apply" }, { status: 500 }),
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
          applyRun: { id: "plan_1" },
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

  assert.equal(response.status, 500);
  assert.equal(containerCalled, false);
  assert.equal(state.body(CURRENT_KEY), undefined);
});

test("destroy succeeds when the best-effort current-state cache write fails", async () => {
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
  state.failNextPut(CURRENT_KEY, new Error("injected pointer persistence failure"));

  const applyRunId = "apply_destroy_1";
  let providerPosts = 0;
  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT") return Response.json({ ok: true });
      if (request.method === "POST" && path === "/runs/plan_1") {
        providerPosts += 1;
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (request.method === "GET" && path.endsWith("/artifacts/tfstate")) {
        return new Response(NEW_STATE_BYTES);
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });
  const requestBody = JSON.stringify({
    kind: "takosumi.opentofu-run@v1",
    action: "destroy",
    runId: "plan_1",
    request: {
      applyRun: { id: applyRunId },
      stateScope: { ...SCOPE, generation: 1, stateRef: `${STATE_PREFIX}/00000001.tfstate.enc` },
      planArtifact: {
        kind: "object-storage",
        ref: "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
        digest: PLAN_DIGEST,
      },
    },
  });

  const first = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }),
  );
  assert.equal(first.status, 200);
  const second = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    }),
  );

  assert.equal(second.status, 200);
  assert.equal(providerPosts, 1);
  assert.equal(
    state.metadata(`${STATE_PREFIX}/00000001.tfstate.enc`)?.[
      "takosumi-action"
    ],
    "destroy",
  );
  assert.equal(
    state.metadata(`${STATE_PREFIX}/00000001.tfstate.enc`)?.[
      "takosumi-run-id"
    ],
    applyRunId,
  );
  assert.equal(state.listCalls.length, 0);
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
          applyRun: { id: "plan_1" },
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
  assert.deepEqual(calls, []);
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
  await state.put(priorKey, sealedPrior.ciphertext, {
    customMetadata: {
      "takosumi-run-id": "apply_prior",
      "takosumi-content-digest": sealedPrior.contentDigest,
      "takosumi-generation": "1",
    },
  });
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
          applyRun: { id: "plan_1" },
          stateScope: {
            ...SCOPE,
            priorState: {
              generation: 1,
              stateRef: priorKey,
              digest: sealedPrior.contentDigest,
              createdByRunId: "apply_prior",
            },
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

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "PUT /runs/plan_1/artifacts/tfplan",
    "PUT /runs/plan_1/artifacts/tfstate",
    "POST /runs/plan_1",
    "GET /runs/plan_1/artifacts/tfstate",
  ]);
});

test("plan restores only the exact canonical prior descriptor and ignores an orphan next generation", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const canonicalBytes = new TextEncoder().encode('{"version":4,"serial":2}');
  const orphanBytes = new TextEncoder().encode('{"version":4,"serial":3}');
  const canonical = await crypto.seal(canonicalBytes);
  const orphan = await crypto.seal(orphanBytes);
  const canonicalKey = `${STATE_PREFIX}/00000002.tfstate.enc`;
  await state.put(canonicalKey, canonical.ciphertext, {
    customMetadata: {
      "takosumi-run-id": "apply_2",
      "takosumi-content-digest": canonical.contentDigest,
      "takosumi-generation": "2",
    },
  });
  await state.put(`${STATE_PREFIX}/00000003.tfstate.enc`, orphan.ciphertext, {
    customMetadata: {
      "takosumi-run-id": "orphan_apply_3",
      "takosumi-content-digest": orphan.contentDigest,
      "takosumi-generation": "3",
    },
  });

  let restored: Uint8Array | undefined;
  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT" && path.endsWith("/artifacts/tfstate")) {
        restored = new Uint8Array(await request.arrayBuffer());
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_3") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_3", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_3",
        request: {
          stateScope: {
            ...SCOPE,
            generation: 2,
            stateRef: canonicalKey,
            priorState: {
              generation: 2,
              stateRef: canonicalKey,
              digest: canonical.contentDigest,
              createdByRunId: "apply_2",
            },
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(restored, canonicalBytes);
  assert.equal(state.listCalls.length, 0);
});

test("plan restores a legacy digest-missing Resource only from its exact stateRef", async () => {
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const priorBytes = new TextEncoder().encode('{"version":4,"serial":2}');
  const sealed = await crypto.seal(priorBytes);
  const exactKey = `${STATE_PREFIX}/00000002.tfstate.enc`;
  // Pre-transition objects may also predate the current custom metadata. The
  // exact ledger ref plus authenticated ciphertext is sufficient to restore;
  // no prefix/current-pointer discovery is allowed.
  await state.put(exactKey, sealed.ciphertext);
  let restored: Uint8Array | undefined;
  const runner = runnerWithContainer(new FakeR2Bucket(), state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT" && path.endsWith("/artifacts/tfstate")) {
        restored = new Uint8Array(await request.arrayBuffer());
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/runs/plan_legacy") {
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_legacy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_legacy",
        request: {
          stateScope: {
            ...SCOPE,
            generation: 2,
            stateRef: exactKey,
            priorState: {
              generation: 2,
              stateRef: exactKey,
              legacyDigestMissing: true,
              createdByRunId: "apply_legacy_2",
            },
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(restored, priorBytes);
  assert.equal(state.listCalls.length, 0);
});

test("missing exact canonical generation fails even when a lower generation remains", async () => {
  const state = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const lower = await crypto.seal(
    new TextEncoder().encode('{"version":4,"serial":1}'),
  );
  await state.put(`${STATE_PREFIX}/00000001.tfstate.enc`, lower.ciphertext, {
    customMetadata: {
      "takosumi-run-id": "apply_1",
      "takosumi-content-digest": lower.contentDigest,
    },
  });
  let containerCalled = false;
  const runner = runnerWithContainer(new FakeR2Bucket(), state, {
    containerFetch() {
      containerCalled = true;
      return Promise.resolve(Response.json({ status: "succeeded" }));
    },
  });
  const exactKey = `${STATE_PREFIX}/00000002.tfstate.enc`;

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_3", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_3",
        request: {
          stateScope: {
            ...SCOPE,
            generation: 2,
            stateRef: exactKey,
            priorState: {
              generation: 2,
              stateRef: exactKey,
              legacyDigestMissing: true,
              createdByRunId: "apply_2",
            },
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 500);
  assert.equal(containerCalled, false);
  assert.equal(state.listCalls.length, 0);
});

test("canonical prior descriptor fails closed on ref, digest, or creator mismatch", async () => {
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const bytes = new TextEncoder().encode('{"version":4,"serial":2}');
  const sealed = await crypto.seal(bytes);
  const exactKey = `${STATE_PREFIX}/00000002.tfstate.enc`;
  const valid = {
    generation: 2,
    stateRef: exactKey,
    digest: sealed.contentDigest,
    createdByRunId: "apply_2",
  };
  const cases = [
    {
      name: "ref",
      descriptor: {
        ...valid,
        stateRef: `${STATE_PREFIX}/00000001.tfstate.enc`,
      },
      objectRunId: valid.createdByRunId,
    },
    {
      name: "digest",
      descriptor: { ...valid, digest: `sha256:${"f".repeat(64)}` },
      objectRunId: valid.createdByRunId,
    },
    {
      name: "createdByRunId",
      descriptor: { ...valid, createdByRunId: "apply_other" },
      objectRunId: valid.createdByRunId,
    },
  ] as const;

  for (const mismatch of cases) {
    const state = new FakeR2Bucket();
    await state.put(exactKey, sealed.ciphertext, {
      customMetadata: {
        "takosumi-run-id": mismatch.objectRunId,
        "takosumi-content-digest": sealed.contentDigest,
        "takosumi-generation": "2",
      },
    });
    let containerCalled = false;
    const runner = runnerWithContainer(new FakeR2Bucket(), state, {
      containerFetch() {
        containerCalled = true;
        return Promise.resolve(Response.json({ status: "succeeded" }));
      },
    });
    const response = await runner.fetch(
      new Request(`https://runner/runs/plan_${mismatch.name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "plan",
          runId: `plan_${mismatch.name}`,
          request: {
            stateScope: {
              ...SCOPE,
              generation: 2,
              stateRef: exactKey,
              priorState: mismatch.descriptor,
            },
          },
        }),
      }),
    );
    assert.equal(response.status, 500, mismatch.name);
    assert.equal(containerCalled, false, mismatch.name);
    assert.equal(state.listCalls.length, 0, mismatch.name);
  }
});

test("exact prior restore performs zero R2 list calls with a large state history", async () => {
  const state = new FakeR2Bucket(7);
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const bytes = new TextEncoder().encode('{"version":4,"serial":250}');
  const sealed = await crypto.seal(bytes);
  for (let generation = 1; generation <= 250; generation += 1) {
    await state.put(
      `${STATE_PREFIX}/${String(generation).padStart(8, "0")}.tfstate.enc`,
      sealed.ciphertext,
      {
        customMetadata: {
          "takosumi-run-id": `apply_${generation}`,
          "takosumi-content-digest": sealed.contentDigest,
          "takosumi-generation": String(generation),
        },
      },
    );
  }
  const exactKey = `${STATE_PREFIX}/00000250.tfstate.enc`;
  const runner = runnerWithContainer(new FakeR2Bucket(), state, {
    containerFetch(request) {
      if (request.method === "PUT") return Promise.resolve(Response.json({ ok: true }));
      return Promise.resolve(Response.json({ status: "succeeded", exitCode: 0 }));
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_250", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_250",
        request: {
          stateScope: {
            ...SCOPE,
            generation: 250,
            stateRef: exactKey,
            priorState: {
              generation: 250,
              stateRef: exactKey,
              digest: sealed.contentDigest,
              createdByRunId: "apply_250",
            },
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(state.listCalls.length, 0);
});

test("an existing target owned by another ApplyRun is never overwritten", async () => {
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
  const targetKey = `${STATE_PREFIX}/00000001.tfstate.enc`;
  const staleBytes = new TextEncoder().encode('{"version":4,"serial":99}');
  const stale = await crypto.seal(staleBytes);
  await state.put(targetKey, stale.ciphertext, {
    customMetadata: {
      "takosumi-run-id": "apply_stale",
      "takosumi-content-digest": stale.contentDigest,
    },
  });
  let providerPosts = 0;
  const runner = runnerWithContainer(artifacts, state, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT") return Response.json({ ok: true });
      if (request.method === "POST" && path === "/runs/plan_1") {
        providerPosts += 1;
        return Response.json({ status: "succeeded", outputs: {} });
      }
      if (request.method === "GET" && path.endsWith("/artifacts/tfstate")) {
        return new Response(NEW_STATE_BYTES);
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });
  const applyRunId = "apply_current";

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId: "plan_1",
        request: {
          applyRun: { id: applyRunId },
          stateScope: {
            ...SCOPE,
            generation: 1,
            stateRef: targetKey,
          },
          rawOutputRef: RAW_OUTPUT_REF.replace(
            "/runs/plan_1/",
            `/runs/${applyRunId}/`,
          ),
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
  assert.equal(providerPosts, 0);
  assert.deepEqual(state.body(targetKey), stale.ciphertext);
  assert.equal(state.listCalls.length, 0);
});

test("plan never discovers prior state from object history when the ledger descriptor is absent", async () => {
  const calls: string[] = [];
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket(1);
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

  assert.equal(response.status, 500);
  assert.equal(restoredState, undefined);
  assert.deepEqual(calls, []);
  assert.equal(state.body(CURRENT_KEY), undefined);
  assert.equal(state.listCalls.length, 0);
});

test("apply restores the exact prior descriptor instead of lower object history", async () => {
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
      customMetadata: {
        "takosumi-content-digest": sealedOne.contentDigest,
        "takosumi-run-id": "apply_1",
        "takosumi-generation": "1",
      },
    },
  );
  // Simulate a previous failed write that left the target generation object
  // behind. Apply generation 2 must NOT restore this as the prior state.
  await state.put(
    `${STATE_PREFIX}/00000002.tfstate.enc`,
    sealedTwo.ciphertext,
    {
      customMetadata: {
        "takosumi-content-digest": sealedTwo.contentDigest,
        "takosumi-run-id": "apply_2",
        "takosumi-generation": "2",
      },
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
          applyRun: { id: "plan_1" },
          stateScope: {
            ...SCOPE,
            generation: 3,
            stateRef: `${STATE_PREFIX}/00000003.tfstate.enc`,
            priorState: {
              generation: 2,
              stateRef: `${STATE_PREFIX}/00000002.tfstate.enc`,
              digest: sealedTwo.contentDigest,
              createdByRunId: "apply_2",
            },
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

  assert.equal(response.status, 200);
  assert.deepEqual(restoredState, generationTwo);
  assert.equal(state.listCalls.length, 0);
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
  await state.put(priorKey, tampered, {
    customMetadata: {
      "takosumi-content-digest": sealedPrior.contentDigest,
      "takosumi-run-id": "apply_prior",
      "takosumi-generation": "1",
    },
  });
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
          applyRun: { id: "plan_1" },
          stateScope: {
            ...SCOPE,
            priorState: {
              generation: 1,
              stateRef: priorKey,
              digest: sealedPrior.contentDigest,
              createdByRunId: "apply_prior",
            },
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
          // The consumer is a first-create plan with no prior state.
          stateScope: {
            ...SCOPE,
            generation: 0,
            stateRef: `${STATE_PREFIX}/00000000.tfstate.enc`,
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
  envOverrides: Readonly<Record<string, unknown>> = {},
): OpenTofuRunnerObject {
  const runner = new OpenTofuRunnerObject({ storage: new FakeDoStorage() }, {
    TAKOSUMI_CONTROL_DB: {} as CloudflareWorkerEnv["TAKOSUMI_CONTROL_DB"],
    R2_ARTIFACTS: artifacts,
    R2_STATE: stateBucket,
    COORDINATION: {} as CloudflareWorkerEnv["COORDINATION"],
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
    ...envOverrides,
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
  readonly #nextPutFailures = new Map<string, Error>();
  readonly #nextPutResponseFailures = new Map<string, Error>();
  readonly listCalls: R2ListOptions[] = [];

  constructor(
    private readonly listPageSize = Number.POSITIVE_INFINITY,
  ) {}

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    const failure = this.#nextPutFailures.get(key);
    if (failure) {
      this.#nextPutFailures.delete(key);
      throw failure;
    }
    if (
      options?.onlyIf?.etagDoesNotMatch === "*" &&
      this.#objects.has(key)
    ) {
      return null;
    }
    const bytes = await bytesFromR2PutValue(value);
    const object = new FakeR2ObjectBody(key, bytes, options);
    this.#objects.set(key, object);
    const responseFailure = this.#nextPutResponseFailures.get(key);
    if (responseFailure) {
      this.#nextPutResponseFailures.delete(key);
      throw responseFailure;
    }
    return object;
  }

  get(key: string): Promise<R2ObjectBody | null> {
    return Promise.resolve(this.#objects.get(key) ?? null);
  }

  head(key: string): Promise<R2Object | null> {
    return Promise.resolve(this.#objects.get(key) ?? null);
  }

  list(options?: R2ListOptions): Promise<R2Objects> {
    this.listCalls.push(options ?? {});
    const prefix = options?.prefix ?? "";
    const all = Array.from(this.#objects.values())
      .filter((object) => object.key.startsWith(prefix))
      .sort((left, right) => left.key.localeCompare(right.key));
    const offset = options?.cursor ? Number(options.cursor) : 0;
    const requestedLimit = options?.limit ?? Number.POSITIVE_INFINITY;
    const limit = Math.min(this.listPageSize, requestedLimit);
    const end = Math.min(all.length, offset + limit);
    const includeCustomMetadata =
      options?.include?.includes("customMetadata") === true;
    const objects = all.slice(offset, end).map((object): R2Object => {
      if (includeCustomMetadata) return object;
      return {
        key: object.key,
        size: object.size,
        etag: object.etag,
        uploaded: object.uploaded,
      };
    });
    const truncated = end < all.length;
    return Promise.resolve({
      objects,
      truncated,
      ...(truncated ? { cursor: String(end) } : {}),
    });
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }

  body(key: string): Uint8Array | undefined {
    return this.#objects.get(key)?.bytes;
  }

  metadata(key: string): Readonly<Record<string, string>> | undefined {
    return this.#objects.get(key)?.customMetadata;
  }

  failNextPut(key: string, error: Error): void {
    this.#nextPutFailures.set(key, error);
  }

  failNextPutResponse(key: string, error: Error): void {
    this.#nextPutResponseFailures.set(key, error);
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
