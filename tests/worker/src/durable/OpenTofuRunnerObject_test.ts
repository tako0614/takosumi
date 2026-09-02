import assert from "node:assert/strict";
import { test } from "bun:test";
import type {
  CloudflareWorkerEnv,
  D1Database,
  D1PreparedStatement,
  D1Result,
  R2Bucket,
  R2ListOptions,
  R2Object,
  R2ObjectBody,
  R2Objects,
  R2PutOptions,
} from "../../../../worker/src/bindings.ts";
import {
  type ContainerRequestFetcher,
  localOpenTofuRunnerProxyUrl,
  LocalSubstrateOpenTofuRunnerProxyObject,
  OpenTofuRunnerObject,
  proxyLocalOpenTofuRunnerRequest,
} from "../../../../worker/src/durable/OpenTofuRunnerObject.ts";
import {
  digestBytes,
  StateArtifactCrypto,
} from "../../../../worker/src/state_crypto.ts";
import { createRunCredentialToken } from "../../../../core/shared/run_credential_tokens.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";

const PLAN_BYTES = new TextEncoder().encode("reviewed tfplan bytes");
const PLAN_DIGEST =
  "sha256:0fd9817656d95201f5c8073b9b4b4c2d5bfe8468b69e7bf771e5311b122a90e7";
const STATE_BYTES = new TextEncoder().encode('{"serial":1}');
const UPDATED_STATE_BYTES = new TextEncoder().encode('{"serial":2}');
const RUN_CREDENTIAL_SIGNING_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef";
const RUN_CREDENTIAL_PROVIDER =
  "registry.opentofu.org/example/ephemeral";
const RESTORE_STATE_PREFIX =
  "workspaces/space_1/capsules/inst_1/environments/production/state-versions";
const RESTORE_TARGET_KEY = `${RESTORE_STATE_PREFIX}/00000002.tfstate.enc`;
const RESTORE_CURRENT_KEY = `${RESTORE_STATE_PREFIX}/current.json`;

interface RestoreSourceDescriptor {
  readonly stateVersionId: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly generation: number;
  readonly stateRef: string;
  readonly digest: string;
  readonly createdByRunId: string;
}

test("local runner proxy Durable Object refuses non-local composition", () => {
  assert.throws(
    () =>
      new LocalSubstrateOpenTofuRunnerProxyObject(
        { storage: new FakeDoStorage() },
        {} as CloudflareWorkerEnv,
      ),
    /local-substrate-only/,
  );
});

test("local runner proxy is test-bed gated and preserves the runner path", async () => {
  assert.equal(localOpenTofuRunnerProxyUrl({}), undefined);
  assert.throws(
    () =>
      localOpenTofuRunnerProxyUrl({
        TAKOSUMI_LOCAL_OPENTOFU_RUNNER_URL: "http://opentofu-runner:8080",
      }),
    /requires LOCAL_SUBSTRATE_TEST_BED=1/,
  );
  const baseUrl = localOpenTofuRunnerProxyUrl({
    LOCAL_SUBSTRATE_TEST_BED: "1",
    TAKOSUMI_LOCAL_OPENTOFU_RUNNER_URL: "http://opentofu-runner:8080",
  });
  assert.equal(baseUrl?.href, "http://opentofu-runner:8080/");

  const calls: string[] = [];
  const response = await proxyLocalOpenTofuRunnerRequest(
    new Request("https://opentofu-runner.internal/runs/run_1?mode=plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    baseUrl!,
    async (request) => {
      calls.push(
        `${request.method} ${request.url} ${await request.clone().text()}`,
      );
      return Response.json({ ok: true });
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "POST http://opentofu-runner:8080/runs/run_1?mode=plan {}",
  ]);
});

test("OpenTofu runner Durable Object promotes runner-local plan artifact to R2", async () => {
  const calls: string[] = [];
  const r2 = new FakeR2Bucket();
  const runner = runnerWithContainer(r2, {
    async containerFetch(request) {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/runs/plan_1") {
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          planDigest: PLAN_DIGEST,
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
        return new Response(PLAN_BYTES, {
          headers: { "content-type": "application/vnd.opentofu.plan" },
        });
      }
      // No plan JSON produced in this mock; 404 means "skip plan-json promotion".
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
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "POST /runs/plan_1",
    "GET /runs/plan_1/artifacts/tfplan",
    "GET /runs/plan_1/artifacts/tfplan-json",
  ]);
  const payload = (await response.json()) as Record<string, unknown>;
  const artifact = payload.planArtifact as Record<string, unknown>;
  assert.equal(artifact.kind, "object-storage");
  // The object-storage ref still names the plaintext key (the DO maps it to the
  // `.enc` object transparently on restore); the stored object is encrypted.
  assert.equal(
    artifact.ref,
    "r2://takos-artifacts/opentofu-plan-runs/plan_1/tfplan",
  );
  assert.equal(artifact.digest, PLAN_DIGEST);
  // The plaintext plan binary is NOT stored; only the `.enc` ciphertext exists.
  assert.equal(r2.body("opentofu-plan-runs/plan_1/tfplan"), undefined);
  const encrypted = r2.body("opentofu-plan-runs/plan_1/tfplan.enc");
  assert.ok(encrypted && encrypted.byteLength > 0);
  assert.notDeepEqual(encrypted, PLAN_BYTES);
});

test("OpenTofu runner rejects one-byte-oversized plans before R2 persistence", async () => {
  const r2 = new FakeR2Bucket();
  const runner = runnerWithContainer(
    r2,
    {
      async containerFetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === "/runs/plan_limit") {
          return Response.json({
            status: "succeeded",
            exitCode: 0,
            planDigest: PLAN_DIGEST,
            planArtifact: {
              kind: "runner-local",
              ref: "runner-local://plan_limit/tfplan",
              digest: PLAN_DIGEST,
            },
          });
        }
        if (
          request.method === "GET" &&
          path === "/runs/plan_limit/artifacts/tfplan"
        ) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(PLAN_BYTES.slice(0, 5));
                controller.enqueue(PLAN_BYTES.slice(5));
                controller.close();
              },
            }),
          );
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    },
    {
      env: {
        TAKOSUMI_RUNNER_PLAN_ARTIFACT_MAX_BYTES: String(
          PLAN_BYTES.byteLength - 1,
        ),
      } as unknown as Partial<CloudflareWorkerEnv>,
    },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_limit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_limit",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 413);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.errorCode, "artifact_size_limit_exceeded");
  assert.equal(payload.artifact, "plan");
  assert.equal(r2.body("opentofu-plan-runs/plan_limit/tfplan.enc"), undefined);
});

test("OpenTofu runner Durable Object retries transient R2 put errors", async () => {
  const sensitiveFailure =
    "timeout arbitrary-marker-7QZ9 Authorization: Bearer relay-token cookie=session-secret body={secret:true}";
  const warnCalls: unknown[][] = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  const r2 = new FlakyR2Bucket({
    failKey: "opentofu-plan-runs/plan_retry/tfplan.enc",
    failTimes: 2,
    message: sensitiveFailure,
  });
  const runner = runnerWithContainer(r2, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/runs/plan_retry") {
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          planDigest: PLAN_DIGEST,
          planArtifact: {
            kind: "runner-local",
            ref: "runner-local://plan_retry/tfplan",
            digest: PLAN_DIGEST,
            contentType: "application/vnd.opentofu.plan",
          },
        });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_retry/artifacts/tfplan"
      ) {
        return new Response(PLAN_BYTES, {
          headers: { "content-type": "application/vnd.opentofu.plan" },
        });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_retry/artifacts/tfplan-json"
      ) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  let response: Response;
  try {
    response = await runner.fetch(
      new Request("https://runner/runs/plan_retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "plan",
          runId: "plan_retry",
          request: {},
        }),
      }),
    );
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.equal(response.status, 200);
  assert.equal(r2.putAttempts("opentofu-plan-runs/plan_retry/tfplan.enc"), 3);
  assert.ok(r2.body("opentofu-plan-runs/plan_retry/tfplan.enc"));
  const logged = JSON.stringify(warnCalls);
  for (const forbidden of [
    "arbitrary-marker-7QZ9",
    "Authorization",
    "Bearer",
    "relay-token",
    "cookie",
    "session-secret",
    "body",
    "secret:true",
    "stack",
  ]) {
    assert.equal(logged.includes(forbidden), false, `logged ${forbidden}`);
  }
  assert.deepEqual(warnCalls, [
    [
      "OpenTofu runner R2 put failed; retrying",
      {
        artifact: "plan_artifact",
        attempt: 1,
        maxAttempts: 8,
        reason: "r2_put_retryable",
        errorName: "Error",
      },
    ],
    [
      "OpenTofu runner R2 put failed; retrying",
      {
        artifact: "plan_artifact",
        attempt: 2,
        maxAttempts: 8,
        reason: "r2_put_retryable",
        errorName: "Error",
      },
    ],
  ]);
});

test("OpenTofu runner Durable Object returns finite R2 put failure details", async () => {
  const runId = "plan_r2_denied-raw-key-marker-2L6";
  const sensitiveFailure =
    "permission denied arbitrary-marker-final-9K2 Authorization: Bearer final-token cookie=final-session body={secret:true}";
  const errorCalls: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };
  const r2 = new FailingR2Bucket(sensitiveFailure);
  const runner = runnerWithContainer(r2, {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === `/runs/${runId}`) {
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          planDigest: PLAN_DIGEST,
          planArtifact: {
            kind: "runner-local",
            ref: `runner-local://${runId}/tfplan`,
            digest: PLAN_DIGEST,
            contentType: "application/vnd.opentofu.plan",
          },
        });
      }
      if (
        request.method === "GET" &&
        path === `/runs/${runId}/artifacts/tfplan`
      ) {
        return new Response(PLAN_BYTES, {
          headers: { "content-type": "application/vnd.opentofu.plan" },
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  let response: Response;
  try {
    response = await runner.fetch(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "plan",
          runId,
          request: {},
        }),
      }),
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 500);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.error, "OpenTofu runner artifact relay failed");
  assert.equal(body.errorCode, "runner_artifact_relay_failed");
  assert.equal(body.reason, "relay_failure");
  assert.equal(body.detail, "runner artifact relay failed");
  const responseText = JSON.stringify(body);
  for (const forbidden of [
    runId,
    "arbitrary-marker-final-9K2",
    "Authorization",
    "Bearer",
    "final-token",
    "cookie",
    "final-session",
    "body",
    "secret:true",
    "stack",
  ]) {
    assert.equal(responseText.includes(forbidden), false, `response ${forbidden}`);
  }
  const logged = JSON.stringify(errorCalls);
  for (const forbidden of [
    runId,
    "arbitrary-marker-final-9K2",
    "Authorization",
    "Bearer",
    "final-token",
    "cookie",
    "final-session",
    "body",
    "secret:true",
    "stack",
  ]) {
    assert.equal(logged.includes(forbidden), false, `logged ${forbidden}`);
  }
  assert.deepEqual(errorCalls, [
    [
      "OpenTofu runner artifact relay failed",
      {
        operation: "run_dispatch",
        reason: "relay_failure",
        errorName: "Error",
      },
    ],
  ]);
});

test("OpenTofu runner keeps raw-output immutable-put failures out of logs", async () => {
  const planRunId = "apply_raw_output_r2_failure";
  const rawOutputRef = rawOutputRefFor(planRunId);
  const sensitiveFailure =
    "permission denied arbitrary-marker-raw-output-4M7 Authorization: Bearer raw-output-token cookie=raw-output-session body={raw:true}";
  const artifacts = new FlakyR2Bucket({
    failKey: rawOutputRef,
    failTimes: 1,
    message: sensitiveFailure,
  });
  await seedEncryptedPlan(artifacts, planRunId);
  const state = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  let providerCalls = 0;
  const token = await signedMutationToken(planRunId, {
    jti: "raw-output-r2-failure",
  });
  const errorCalls: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };

  let response: Response;
  try {
    response = await runnerWithContainer(
      artifacts,
      mutationSuccessContainer(planRunId, () => {
        providerCalls += 1;
      }),
      {
        storage,
        stateBucket: state,
        env: {
          TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET:
            RUN_CREDENTIAL_SIGNING_SECRET,
        },
      },
    ).fetch(
      signedMutationRequest(planRunId, token, {
        rawOutputRef,
        stateScope: capsuleStateScope(),
      }),
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 500);
  assert.equal(providerCalls, 1);
  assert.equal(artifacts.body(rawOutputRef), undefined);
  assertNoSensitiveR2LogSerialization(errorCalls, sensitiveFailure);
  assert.deepEqual(errorCalls, [
    [
      "OpenTofu runner artifact relay failed",
      {
        operation: "run_dispatch",
        reason: "relay_failure",
        errorName: "Error",
      },
    ],
  ]);
});

test("OpenTofu runner keeps immutable state-put failures out of logs", async () => {
  const planRunId = "apply_state_r2_failure";
  const stateScope = capsuleStateScope();
  const sensitiveFailure =
    "permission denied arbitrary-marker-state-object-6N8 Authorization: Bearer state-object-token cookie=state-object-session body={state:true}";
  const artifacts = new FakeR2Bucket();
  await seedEncryptedPlan(artifacts, planRunId);
  const state = new FlakyR2Bucket({
    failKey: stateScope.stateRef,
    failTimes: 1,
    message: sensitiveFailure,
  });
  const storage = new FakeDoStorage();
  let providerCalls = 0;
  const token = await signedMutationToken(planRunId, {
    jti: "state-object-r2-failure",
  });
  const errorCalls: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };

  let response: Response;
  try {
    response = await runnerWithContainer(
      artifacts,
      mutationSuccessContainer(planRunId, () => {
        providerCalls += 1;
      }),
      {
        storage,
        stateBucket: state,
        env: {
          TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET:
            RUN_CREDENTIAL_SIGNING_SECRET,
        },
      },
    ).fetch(
      signedMutationRequest(planRunId, token, {
        rawOutputRef: rawOutputRefFor(planRunId),
        stateScope,
      }),
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 503);
  assert.equal(providerCalls, 1);
  assert.equal(state.body(stateScope.stateRef), undefined);
  assertNoSensitiveR2LogSerialization(errorCalls, sensitiveFailure);
  assert.deepEqual(errorCalls, [
    [
      "OpenTofu runner artifact relay failed",
      {
        operation: "run_dispatch",
        reason: "artifact_durability_ambiguous",
        errorName: "Error",
      },
    ],
  ]);
});

test("OpenTofu runner keeps current-state pointer retry logs finite", async () => {
  const planRunId = "apply_current_pointer_retry";
  const stateScope = capsuleStateScope();
  const currentKey = stateScope.stateRef.replace(
    /[0-9]{8}\.tfstate\.enc$/u,
    "current.json",
  );
  const sensitiveFailure =
    "timeout arbitrary-marker-current-pointer-retry-2P9 Authorization: Bearer pointer-retry-token cookie=pointer-retry-session body={pointer:true}";
  const artifacts = new FakeR2Bucket();
  await seedEncryptedPlan(artifacts, planRunId);
  const state = new FlakyR2Bucket({
    failKey: currentKey,
    failTimes: 2,
    message: sensitiveFailure,
  });
  const storage = new FakeDoStorage();
  const token = await signedMutationToken(planRunId, {
    jti: "current-pointer-retry",
  });
  const warnCalls: unknown[][] = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };

  let response: Response;
  try {
    response = await runnerWithContainer(
      artifacts,
      mutationSuccessContainer(planRunId, () => undefined),
      {
        storage,
        stateBucket: state,
        env: {
          TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET:
            RUN_CREDENTIAL_SIGNING_SECRET,
        },
      },
    ).fetch(
      signedMutationRequest(planRunId, token, {
        rawOutputRef: rawOutputRefFor(planRunId),
        stateScope,
      }),
    );
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.equal(response.status, 200);
  assert.ok(state.body(currentKey));
  assertNoSensitiveR2LogSerialization(warnCalls, sensitiveFailure);
  assert.deepEqual(warnCalls, [
    [
      "OpenTofu runner R2 put failed; retrying",
      {
        artifact: "state_pointer",
        attempt: 1,
        maxAttempts: 8,
        reason: "r2_put_retryable",
        errorName: "Error",
      },
    ],
    [
      "OpenTofu runner R2 put failed; retrying",
      {
        artifact: "state_pointer",
        attempt: 2,
        maxAttempts: 8,
        reason: "r2_put_retryable",
        errorName: "Error",
      },
    ],
  ]);
});

test("OpenTofu runner keeps current-state pointer final-failure logs finite", async () => {
  const planRunId = "apply_current_pointer_failure";
  const stateScope = capsuleStateScope();
  const currentKey = stateScope.stateRef.replace(
    /[0-9]{8}\.tfstate\.enc$/u,
    "current.json",
  );
  const sensitiveFailure =
    "permission denied arbitrary-marker-current-pointer-final-8R1 Authorization: Bearer pointer-final-token cookie=pointer-final-session body={pointer:true}";
  const artifacts = new FakeR2Bucket();
  await seedEncryptedPlan(artifacts, planRunId);
  const state = new FlakyR2Bucket({
    failKey: currentKey,
    failTimes: 1,
    message: sensitiveFailure,
  });
  const storage = new FakeDoStorage();
  const token = await signedMutationToken(planRunId, {
    jti: "current-pointer-final",
  });
  const warnCalls: unknown[][] = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };

  let response: Response;
  try {
    response = await runnerWithContainer(
      artifacts,
      mutationSuccessContainer(planRunId, () => undefined),
      {
        storage,
        stateBucket: state,
        env: {
          TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET:
            RUN_CREDENTIAL_SIGNING_SECRET,
        },
      },
    ).fetch(
      signedMutationRequest(planRunId, token, {
        rawOutputRef: rawOutputRefFor(planRunId),
        stateScope,
      }),
    );
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.equal(response.status, 200);
  assert.equal(state.body(currentKey), undefined);
  assertNoSensitiveR2LogSerialization(warnCalls, sensitiveFailure);
  assert.deepEqual(warnCalls, [
    [
      "OpenTofu runner current-state cache write failed",
      {
        generation: stateScope.generation,
        reason: "current_state_cache_write_failed",
        errorName: "Error",
      },
    ],
  ]);
});

test("OpenTofu runner Durable Object skips oversized plan JSON artifacts", async () => {
  const calls: string[] = [];
  const r2 = new FakeR2Bucket();
  const runner = runnerWithContainer(r2, {
    async containerFetch(request) {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/runs/plan_large_json") {
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          planDigest: PLAN_DIGEST,
          planArtifact: {
            kind: "runner-local",
            ref: "runner-local://plan_large_json/tfplan",
            digest: PLAN_DIGEST,
            contentType: "application/vnd.opentofu.plan",
          },
        });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_large_json/artifacts/tfplan"
      ) {
        return new Response(PLAN_BYTES, {
          headers: { "content-type": "application/vnd.opentofu.plan" },
        });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_large_json/artifacts/tfplan-json"
      ) {
        return new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(2 * 1024 * 1024 + 1),
          },
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_large_json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_large_json",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "POST /runs/plan_large_json",
    "GET /runs/plan_large_json/artifacts/tfplan",
    "GET /runs/plan_large_json/artifacts/tfplan-json",
  ]);
  assert.ok(r2.body("opentofu-plan-runs/plan_large_json/tfplan.enc"));
  assert.equal(
    r2.body("opentofu-plan-runs/plan_large_json/tfplan.json.enc"),
    undefined,
  );
});

test("OpenTofu runner Durable Object strips caller credentials before container dispatch", async () => {
  const capturedHeaders: Headers[] = [];
  const r2 = new FakeR2Bucket();
  const runner = runnerWithContainer(r2, {
    async containerFetch(request) {
      capturedHeaders.push(new Headers(request.headers));
      return Response.json({ status: "succeeded" });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: {
        authorization: "Bearer must-not-reach-container",
        cookie: "sid=must-not-reach-container",
        "content-type": "application/json",
        "x-takosumi-provider-credential": "must-not-reach-container",
      },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(capturedHeaders.length, 1);
  assert.equal(capturedHeaders[0]!.get("content-type"), "application/json");
  assert.equal(capturedHeaders[0]!.get("authorization"), null);
  assert.equal(capturedHeaders[0]!.get("cookie"), null);
  assert.equal(capturedHeaders[0]!.get("x-takosumi-provider-credential"), null);
});

test("OpenTofu runner Durable Object starts the container before dispatch", async () => {
  const calls: string[] = [];
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    {
      async containerFetch(request) {
        calls.push(`fetch ${request.method} ${new URL(request.url).pathname}`);
        return Response.json({ status: "succeeded" });
      },
    },
    {
      async startAndWaitForPorts(ports) {
        calls.push(`start ${JSON.stringify(ports)}`);
      },
    },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["start [8080]", "fetch POST /runs/plan_1"]);
});

test("OpenTofu runner Durable Object retries when health check races a stopped container", async () => {
  const calls: string[] = [];
  let healthAttempts = 0;
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    {
      async containerFetch(request) {
        calls.push(`fetch ${request.method} ${new URL(request.url).pathname}`);
        return Response.json({ status: "succeeded" });
      },
    },
    {
      async startAndWaitForPorts(ports) {
        calls.push(`start ${JSON.stringify(ports)}`);
      },
      async healthFetch() {
        healthAttempts += 1;
        calls.push(`health ${healthAttempts}`);
        if (healthAttempts === 1) {
          throw new Error(
            "The container is not running, consider calling start()",
          );
        }
        return Response.json({ ok: true });
      },
    },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "start [8080]",
    "health 1",
    "start [8080]",
    "health 2",
    "fetch POST /runs/plan_1",
  ]);
});

test("OpenTofu runner Durable Object forwards non-secret performance env to the container", () => {
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    {
      async containerFetch() {
        return Response.json({ status: "succeeded" });
      },
    },
    {
      env: {
        TAKOSUMI_RUNNER_KEEPALIVE_SECONDS: "300",
        TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR: "/cache/providers",
        TAKOSUMI_SOURCE_ARCHIVE_ZSTD_LEVEL: "1",
      },
    },
  );

  assert.equal(runner.sleepAfter, "300s");
  assert.equal(
    runner.envVars.TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR,
    "/cache/providers",
  );
  assert.equal(runner.envVars.TAKOSUMI_SOURCE_ARCHIVE_ZSTD_LEVEL, "1");
});

test("OpenTofu runner Durable Object keeps a minimum activity grace while startup is in flight", () => {
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    {
      async containerFetch() {
        return Response.json({ status: "succeeded" });
      },
    },
    {
      env: {
        TAKOSUMI_RUNNER_KEEPALIVE_SECONDS: "5",
      },
    },
  );

  assert.equal(runner.sleepAfter, "30s");
});

test("OpenTofu runner Durable Object destroys successful plan containers even when legacy keepalive is enabled", async () => {
  const calls: string[] = [];
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    {
      async containerFetch(request) {
        calls.push(`fetch ${request.method} ${new URL(request.url).pathname}`);
        return Response.json({
          status: "succeeded",
          planArtifact: {
            kind: "object-storage",
            ref: "r2://takos-artifacts/opentofu-plan-runs/plan_warm/tfplan",
            digest: PLAN_DIGEST,
          },
        });
      },
    },
    {
      env: { TAKOSUMI_RUNNER_KEEPALIVE_SECONDS: "120" },
      async destroy() {
        calls.push("destroy");
      },
    },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_warm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_warm",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["fetch POST /runs/plan_warm", "destroy"]);
});

test("OpenTofu runner Durable Object destroys non-plan containers even when keepalive is enabled", async () => {
  const calls: string[] = [];
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    {
      async containerFetch(request) {
        calls.push(`fetch ${request.method} ${new URL(request.url).pathname}`);
        return Response.json({ status: "succeeded", files: [] });
      },
    },
    {
      env: { TAKOSUMI_RUNNER_KEEPALIVE_SECONDS: "120" },
      async destroy() {
        calls.push("destroy");
      },
    },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/compatibility_snap_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "compatibility_check",
        runId: "compatibility_snap_1",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["fetch POST /runs/compatibility_snap_1", "destroy"]);
});

test("OpenTofu runner Durable Object labels compatibility failures with a finite phase", async () => {
  const marker = "compatibility-failure-marker-7J3";
  const runner = runnerWithContainer(new FakeR2Bucket(), {
    async containerFetch() {
      return Response.json(
        {
          error: `path=/work/${marker}`,
          detail: `Authorization: Bearer ${marker}`,
          stderr: `cookie=${marker}`,
          stdout: `body=${marker}`,
          runId: marker,
        },
        { status: 502 },
      );
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/compatibility_failure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "compatibility_check",
        runId: "compatibility_failure",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 502);
  const body = JSON.stringify(await response.json());
  assert.equal(
    body,
    JSON.stringify({
      status: "failed",
      errorCode: "runner_rejected",
      phase: "compatibility_check",
    }),
  );
  assert.equal(body.includes(marker), false);
});

test("OpenTofu runner Durable Object preserves source ref-not-found without runner detail", async () => {
  const marker = "source-ref-failure-marker-7K4";
  const runner = runnerWithContainer(new FakeR2Bucket(), {
    async containerFetch() {
      return Response.json(
        {
          status: "failed",
          errorCode: "source_ref_not_found",
          stderr: `source ref did not resolve password=${marker}`,
          stdout: `git output token=${marker}`,
        },
        { status: 500 },
      );
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/source_ref_missing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "source_sync",
        runId: "source_ref_missing",
        request: {
          action: "source_sync",
          archiveRef:
            "workspaces/workspace_1/sources/source_1/snapshots/snapshot_1/source.tar.zst",
        },
      }),
    }),
  );

  assert.equal(response.status, 500);
  const body = JSON.stringify(await response.json());
  assert.equal(
    body,
    JSON.stringify({
      status: "failed",
      errorCode: "source_ref_not_found",
      phase: "source_sync",
    }),
  );
  assert.equal(body.includes(marker), false);
});

test("OpenTofu runner Durable Object destroys a successful run container by default", async () => {
  const calls: string[] = [];
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    {
      async containerFetch(request) {
        calls.push(`fetch ${request.method} ${new URL(request.url).pathname}`);
        return Response.json({ status: "succeeded", run: "plan_1" });
      },
    },
    {
      async destroy() {
        calls.push("destroy");
      },
    },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "succeeded",
    run: "plan_1",
  });
  assert.equal(runner.sleepAfter, "30s");
  assert.deepEqual(calls, ["fetch POST /runs/plan_1", "destroy"]);
});

test("OpenTofu runner Durable Object destroys after a successful run when keepalive is disabled", async () => {
  const calls: string[] = [];
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    {
      async containerFetch(request) {
        calls.push(`fetch ${request.method} ${new URL(request.url).pathname}`);
        return Response.json({ status: "succeeded", run: "plan_1" });
      },
    },
    {
      env: { TAKOSUMI_RUNNER_KEEPALIVE_SECONDS: "0" },
      async destroy() {
        calls.push("destroy");
      },
    },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "succeeded",
    run: "plan_1",
  });
  assert.equal(runner.sleepAfter, "30s");
  assert.deepEqual(calls, ["fetch POST /runs/plan_1", "destroy"]);
});

test("OpenTofu runner Durable Object falls back to stop when keepalive is disabled and destroy is unavailable", async () => {
  const calls: string[] = [];
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    {
      async containerFetch(request) {
        calls.push(`fetch ${request.method} ${new URL(request.url).pathname}`);
        return Response.json({ status: "succeeded", run: "plan_1" });
      },
    },
    {
      env: { TAKOSUMI_RUNNER_KEEPALIVE_SECONDS: "0" },
      async stop() {
        calls.push("stop");
      },
    },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "succeeded",
    run: "plan_1",
  });
  assert.deepEqual(calls, ["fetch POST /runs/plan_1", "stop"]);
});

test("OpenTofu runner Durable Object destroys a failed run container", async () => {
  const calls: string[] = [];
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    {
      async containerFetch(request) {
        calls.push(`fetch ${request.method} ${new URL(request.url).pathname}`);
        return Response.json({ status: "failed" }, { status: 500 });
      },
    },
    {
      async destroy() {
        calls.push("destroy");
      },
    },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 500);
  assert.deepEqual(calls, ["fetch POST /runs/plan_1", "destroy"]);
});

test("OpenTofu runner Durable Object destroys the container when activity expires", async () => {
  const calls: string[] = [];
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    {
      async containerFetch() {
        throw new Error("unused");
      },
    },
    {
      async destroy() {
        calls.push("destroy");
      },
    },
  );

  await runner.onActivityExpired();

  assert.equal(runner.sleepAfter, "30s");
  assert.deepEqual(calls, ["destroy"]);
});

test("OpenTofu runner Durable Object does not echo or log relay failure details", async () => {
  const relayMarker = "arbitrary-marker-relay-path-5V8";
  const errorCalls: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    {
      containerFetch() {
        throw new Error(
          `Authorization: Bearer relay-secret-token cookie=relay-session body={secret:true} ${relayMarker}`,
        );
      },
    },
    {
      async destroy() {
        throw new Error(
          `Authorization: Bearer cleanup-secret-token cookie=cleanup-session body={secret:true} ${relayMarker}`,
        );
      },
    },
  );

  let response: Response;
  try {
    response = await runner.fetch(
      new Request(`https://runner/runs/plan_1-${relayMarker}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "plan",
          runId: `plan_1-${relayMarker}`,
          request: {},
        }),
      }),
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 500);
  const text = await response.text();
  assert.equal(text.includes("relay-secret-token"), false);
  assert.equal(text.includes(relayMarker), false);
  assert.equal(text.includes("Authorization"), false);
  assert.equal(text.includes("Bearer"), false);
  assert.equal(text.includes("relay-session"), false);
  assert.equal(text.includes("body"), false);
  assert.equal(text.includes("OpenTofu runner artifact relay failed"), true);
  const logged = JSON.stringify(errorCalls);
  assert.equal(logged.includes("relay-secret-token"), false);
  assert.equal(logged.includes("cleanup-secret-token"), false);
  assert.equal(logged.includes("Authorization"), false);
  assert.equal(logged.includes("Bearer"), false);
  assert.equal(logged.includes("stack"), false);
  assert.deepEqual(errorCalls, [
    [
      "OpenTofu runner artifact relay failed",
      {
        operation: "run_dispatch",
        reason: "relay_failure",
        errorName: "Error",
      },
    ],
    [
      "OpenTofu runner container destroy failed",
      { errorName: "Error" },
    ],
  ]);
});

test("OpenTofu runner Durable Object normalizes arbitrary non-2xx runner payloads", async () => {
  const marker = "arbitrary-runner-response-marker-8H4";
  const runner = runnerWithContainer(new FakeR2Bucket(), {
    async containerFetch(request) {
      if (request.method === "GET") return Response.json({ status: "ok" });
      return Response.json(
        {
          errorCode: "provider-raw-code",
          error: `provider path=/work/${marker}`,
          detail: `Authorization: Bearer ${marker}`,
          stderr: `cookie=${marker}`,
          stdout: `body=${marker}`,
          runId: marker,
        },
        { status: 502 },
      );
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_arbitrary_response", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_arbitrary_response",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    status: "failed",
    errorCode: "runner_rejected",
    phase: "plan",
  });
});

test("OpenTofu runner Durable Object preserves finite plan execution failures", async () => {
  const marker = "provider-init-marker-9K2";
  const runner = runnerWithContainer(new FakeR2Bucket(), {
    async containerFetch(request) {
      if (request.method === "GET") return Response.json({ status: "ok" });
      return Response.json(
        {
          errorCode: "provider_package_unavailable",
          stderr: `token=${marker}`,
          detail: marker,
        },
        { status: 500 },
      );
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_provider_unavailable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_provider_unavailable",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 500);
  const body = JSON.stringify(await response.json());
  assert.equal(
    body,
    JSON.stringify({
      status: "failed",
      errorCode: "provider_package_unavailable",
      phase: "plan",
      detail: "token=[redacted]",
    }),
  );
  assert.equal(body.includes(marker), false);
});

test("OpenTofu runner Durable Object preserves bounded redacted terminal release diagnostics", async () => {
  const applyRunId = "apply_release_diagnostic_preservation";
  const releaseRunId = `release_${applyRunId}`;
  const secret = "release-command-diagnostic-secret";
  const materializerFailure = JSON.stringify({
    stage: "runtime_secret_materialization",
    code: "runtime_secret_file_failed",
  });
  const r2 = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  let releaseCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === `/runs/${releaseRunId}`
      ) {
        releaseCalls += 1;
        return Response.json(
          {
            runId: releaseRunId,
            action: "release",
            status: "failed",
            exitCode: 17,
            phase: "release",
            failedCommandId: "activate",
            stderr: [
              materializerFailure,
              `token=${secret}`,
              `Authorization: Bearer ${secret}`,
              "E".repeat(5_000),
            ].join("\n"),
            stdout: `release stdout password=${secret}`,
          },
          { status: 500 },
        );
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };

  const first = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );
  assert.equal(first.status, 500);
  const firstPayload = (await first.json()) as Record<string, unknown>;
  assert.equal(firstPayload.errorCode, "release_command_failed");
  assert.equal(firstPayload.phase, "release");
  assert.equal(firstPayload.detail?.toString().includes(materializerFailure), true);
  assert.equal(firstPayload.detail?.toString().includes(secret), false);
  assert.equal(firstPayload.detail?.toString().includes("[redacted]"), true);
  assert.equal(firstPayload.detail?.toString().includes("diagnostics omitted"), true);
  assert.ok(typeof firstPayload.detail === "string");
  assert.ok((firstPayload.detail as string).length <= 4_096);

  const replay = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );
  assert.equal(replay.status, 500);
  const replayText = await replay.text();
  assert.equal(releaseCalls, 1);
  assert.equal(replayText.includes(secret), false);
  assert.match(replayText, /release_command_failed/);
  assert.match(replayText, /runtime_secret_file_failed/);
  assert.match(replayText, /automatic redispatch is blocked/);
  assert.equal(JSON.stringify(storage.entries()).includes(secret), false);
});

test("OpenTofu runner Durable Object keeps generic release setup failures on the runner_rejected fallback", async () => {
  const applyRunId = "apply_release_generic_failure";
  const releaseRunId = `release_${applyRunId}`;
  const secret = "generic-release-setup-secret-must-not-persist";
  const r2 = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  let releaseCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === `/runs/${releaseRunId}`
      ) {
        releaseCalls += 1;
        return Response.json(
          {
            runId: releaseRunId,
            action: "release",
            status: "failed",
            exitCode: 1,
            errorCode: "runtime_secret_file_failed",
            stderr: `release setup token=${secret}`,
            stdout: `runtime secret setup failed password=${secret}`,
          },
          { status: 500 },
        );
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };

  const first = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );
  assert.equal(first.status, 500);
  const firstPayload = (await first.json()) as Record<string, unknown>;
  assert.equal(firstPayload.errorCode, "runner_rejected");
  assert.equal(firstPayload.phase, "release");
  assert.equal(firstPayload.detail, undefined);
  assert.equal(JSON.stringify(firstPayload).includes(secret), false);

  const replay = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );
  assert.equal(replay.status, 500);
  const replayText = await replay.text();
  assert.equal(releaseCalls, 1);
  assert.equal(replayText.includes("release_command_failed"), false);
  assert.equal(replayText.includes(secret), false);
  assert.match(replayText, /automatic redispatch is blocked/);
  assert.equal(JSON.stringify(storage.entries()).includes(secret), false);
});

test("OpenTofu runner Durable Object rejects an unknown release command id from the terminal diagnostic envelope", async () => {
  const applyRunId = "apply_release_unknown_command_failure";
  const releaseRunId = `release_${applyRunId}`;
  const secret = "unknown-release-command-secret-must-not-persist";
  const r2 = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  let releaseCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === `/runs/${releaseRunId}`
      ) {
        releaseCalls += 1;
        return Response.json(
          {
            runId: releaseRunId,
            action: "release",
            status: "failed",
            exitCode: 17,
            phase: "release",
            failedCommandId: "unknown-command",
            errorCode: "release_command_failed",
            stderr: `release failed token=${secret}`,
          },
          { status: 500 },
        );
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };

  const first = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );
  assert.equal(first.status, 500);
  const firstPayload = (await first.json()) as Record<string, unknown>;
  assert.equal(firstPayload.errorCode, "runner_rejected");
  assert.equal(firstPayload.phase, "release");
  assert.equal(firstPayload.detail, undefined);
  assert.equal(JSON.stringify(firstPayload).includes(secret), false);

  const replay = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );
  assert.equal(replay.status, 500);
  const replayText = await replay.text();
  assert.equal(releaseCalls, 1);
  assert.equal(replayText.includes("release_command_failed"), false);
  assert.equal(replayText.includes("unknown-command"), false);
  assert.equal(replayText.includes(secret), false);
  assert.match(replayText, /automatic redispatch is blocked/);
  assert.equal(JSON.stringify(storage.entries()).includes(secret), false);
});

test("OpenTofu runner Durable Object restores reviewed R2 plan artifact before apply", async () => {
  const calls: string[] = [];
  const r2 = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await r2.put("opentofu-plan-runs/plan_1/tfplan.enc", sealedPlan.ciphertext, {
    httpMetadata: { contentType: "application/vnd.opentofu.plan" },
    customMetadata: { "takosumi-content-digest": sealedPlan.contentDigest },
  });
  const runner = runnerWithContainer(r2, {
    async containerFetch(request) {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      const path = new URL(request.url).pathname;
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
        action: "apply",
        runId: "plan_1",
        request: {
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
    "POST /runs/plan_1",
  ]);
});

for (const mutation of [
  {
    action: "apply" as const,
    runId: "apply_transport_lost",
    transportError: new Error(
      "The container is not running after provider token=apply-raw-secret was accepted",
    ),
  },
  {
    action: "destroy" as const,
    runId: "destroy_transport_lost",
    transportError: new TypeError(
      "transport lost after provider password=destroy-raw-secret was accepted",
    ),
  },
]) {
  test(`OpenTofu runner Durable Object makes ${mutation.action} transport loss durably indeterminate without provider replay`, async () => {
    const r2 = new FakeR2Bucket();
    await seedEncryptedPlan(r2, mutation.runId);
    const storage = new FakeDoStorage();
    let providerCalls = 0;
    let destroyCalls = 0;
    const container: ContainerRequestFetcher = {
      async containerFetch(request) {
        const path = new URL(request.url).pathname;
        if (
          request.method === "PUT" &&
          path === `/runs/${mutation.runId}/artifacts/tfplan`
        ) {
          return Response.json({ ok: true });
        }
        if (
          request.method === "POST" &&
          path === `/runs/${mutation.runId}`
        ) {
          providerCalls += 1;
          throw mutation.transportError;
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    };
    const request = (input: {
      readonly requestedAt?: string;
      readonly providerToken?: string;
    } = {}) =>
      new Request(`https://runner/runs/${mutation.runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: mutation.action,
          runId: mutation.runId,
          requestedAt:
            input.requestedAt ?? "2026-08-13T00:00:00.000Z",
          request: {
            planArtifact: {
              kind: "object-storage",
              ref: `r2://takos-artifacts/opentofu-plan-runs/${mutation.runId}/tfplan`,
              digest: PLAN_DIGEST,
            },
            env: {
              PROVIDER_TOKEN:
                input.providerToken ??
                `${mutation.action}-request-raw-secret`,
            },
          },
        }),
      });

    const runnerOptions = {
      storage,
      async destroy() {
        destroyCalls += 1;
      },
    };
    const firstRunner = runnerWithContainer(r2, container, runnerOptions);
    const firstResponse = await firstRunner.fetch(request());
    assert.equal(firstResponse.status, 409);
    const firstText = await firstResponse.text();
    assertMutationIndeterminateResponse(firstText, mutation.action);
    assert.equal(firstText.includes(`${mutation.action}-raw-secret`), false);
    assert.equal(
      firstText.includes(`${mutation.action}-request-raw-secret`),
      false,
    );
    assert.equal(providerCalls, 1);
    const storedEvidence = JSON.stringify(storage.entries());
    assert.equal(storedEvidence.includes(`${mutation.action}-raw-secret`), false);
    assert.equal(
      storedEvidence.includes(`${mutation.action}-request-raw-secret`),
      false,
    );
    assert.match(storedEvidence, /takosumi\.runner-mutation-dispatch@v2/);
    assert.match(storedEvidence, /sha256:[0-9a-f]{64}/);
    assert.match(storedEvidence, /"phase":"indeterminate"/);
    assert.equal(destroyCalls, 0);

    // Recreate the Durable Object around the same persistent storage to prove
    // the no-replay fence survives isolate eviction/restart.
    const restartedRunner = runnerWithContainer(r2, container, runnerOptions);
    const replayResponse = await restartedRunner.fetch(
      request({ requestedAt: "2026-08-13T00:01:00.000Z" }),
    );
    assert.equal(replayResponse.status, 409);
    const replayText = await replayResponse.text();
    assertMutationIndeterminateResponse(replayText, mutation.action);
    assert.equal(replayText.includes(`${mutation.action}-raw-secret`), false);
    assert.equal(
      replayText.includes(`${mutation.action}-request-raw-secret`),
      false,
    );
    assert.equal(providerCalls, 1);
    assert.equal(destroyCalls, 0);

    // The run-level authority fence also rejects request-digest drift instead
    // of treating a changed payload as fresh mutation authority.
    const driftedReplay = await restartedRunner.fetch(
      request({ providerToken: `${mutation.action}-changed-raw-secret` }),
    );
    assert.equal(driftedReplay.status, 409);
    assert.equal(
      (await driftedReplay.text()).includes(
        `${mutation.action}-changed-raw-secret`,
      ),
      false,
    );
    assert.equal(providerCalls, 1);
    assert.equal(destroyCalls, 0);
  });
}

test("OpenTofu runner resumes a durable pre-dispatch claim with an equivalent freshly minted credential", async () => {
  const planRunId = "plan_preparing_resume";
  const r2 = new FakeR2Bucket();
  await seedEncryptedPlan(r2, planRunId);
  const storage = new FakeDoStorage();
  storage.failPutAfterCommit(1);
  let providerCalls = 0;
  const container = mutationSuccessContainer(planRunId, () => {
    providerCalls += 1;
  });
  const issuanceNow = Date.now();
  const firstToken = await signedMutationToken(planRunId, {
    jti: "first-ephemeral-jti",
    nowMs: issuanceNow - 60_000,
  });
  const first = await runnerWithContainer(r2, container, {
    storage,
    env: {
      TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET:
        RUN_CREDENTIAL_SIGNING_SECRET,
    },
  }).fetch(signedMutationRequest(planRunId, firstToken));
  assert.equal(first.status, 500);
  assert.equal(providerCalls, 0);
  const preparingEvidence = JSON.stringify(storage.entries());
  assert.match(preparingEvidence, /"phase":"preparing"/);
  assert.equal(preparingEvidence.includes(firstToken), false);
  assert.equal(preparingEvidence.includes("first-ephemeral-jti"), false);
  assert.equal(
    preparingEvidence.includes(RUN_CREDENTIAL_SIGNING_SECRET),
    false,
  );
  assert.equal(storage.entries().length, 2);

  const remintedToken = await signedMutationToken(planRunId, {
    jti: "second-ephemeral-jti",
    nowMs: issuanceNow,
  });
  assert.notEqual(firstToken, remintedToken);
  const resumed = await runnerWithContainer(r2, container, {
    storage,
    env: {
      TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET:
        RUN_CREDENTIAL_SIGNING_SECRET,
    },
  }).fetch(
    signedMutationRequest(planRunId, remintedToken, {
      heartbeatAt: 2,
      requestedAt: "2026-08-13T00:01:00.000Z",
    }),
  );
  assert.equal(resumed.status, 200);
  assert.equal(providerCalls, 1);
  const dispatchedEvidence = JSON.stringify(storage.entries());
  assert.match(dispatchedEvidence, /"phase":"dispatched"/);
  assert.equal(dispatchedEvidence.includes(remintedToken), false);
  assert.equal(dispatchedEvidence.includes("second-ephemeral-jti"), false);
});

test("OpenTofu runner rejects changed credential authority or immutable mutation inputs while preparing", async () => {
  const planRunId = "plan_preparing_semantic_mismatch";
  const r2 = new FakeR2Bucket();
  await seedEncryptedPlan(r2, planRunId);
  const storage = new FakeDoStorage();
  storage.failPutAfterCommit(1);
  let providerCalls = 0;
  const container = mutationSuccessContainer(planRunId, () => {
    providerCalls += 1;
  });
  const options = {
    storage,
    env: {
      TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET:
        RUN_CREDENTIAL_SIGNING_SECRET,
    },
  };
  const firstToken = await signedMutationToken(planRunId, {
    jti: "semantic-original",
  });
  const first = await runnerWithContainer(r2, container, options).fetch(
    signedMutationRequest(planRunId, firstToken),
  );
  assert.equal(first.status, 500);
  assert.equal(providerCalls, 0);

  const changedScope = await signedMutationToken(planRunId, {
    jti: "semantic-scope",
    scopes: ["provider:apply", "provider:admin"],
  });
  const changedScopeResponse = await runnerWithContainer(
    r2,
    container,
    options,
  ).fetch(signedMutationRequest(planRunId, changedScope));
  assert.equal(changedScopeResponse.status, 409);

  const changedSubject = await signedMutationToken(planRunId, {
    jti: "semantic-subject",
    subject: "principal_changed",
  });
  const changedSubjectResponse = await runnerWithContainer(
    r2,
    container,
    options,
  ).fetch(signedMutationRequest(planRunId, changedSubject));
  assert.equal(changedSubjectResponse.status, 409);

  const changedRun = await signedMutationToken(planRunId, {
    jti: "semantic-run",
    runId: "apply_different",
  });
  const changedRunResponse = await runnerWithContainer(
    r2,
    container,
    options,
  ).fetch(signedMutationRequest(planRunId, changedRun));
  assert.equal(changedRunResponse.status, 409);
  assertMutationIndeterminateResponse(
    await changedRunResponse.text(),
    "apply",
  );

  const currentToken = await signedMutationToken(planRunId, {
    jti: "semantic-input",
  });
  const changedInputResponse = await runnerWithContainer(
    r2,
    container,
    options,
  ).fetch(
    signedMutationRequest(planRunId, currentToken, {
      sourceRef: "fedcba9876543210fedcba9876543210fedcba98",
    }),
  );
  assert.equal(changedInputResponse.status, 409);
  assert.equal(providerCalls, 0);

  const resumed = await runnerWithContainer(r2, container, options).fetch(
    signedMutationRequest(planRunId, currentToken),
  );
  assert.equal(resumed.status, 200);
  assert.equal(providerCalls, 1);
});

test("run-scoped sensitive input values change mutation identity without ever being stored", async () => {
  const planRunId = "plan_runtime_input_semantics";
  const r2 = new FakeR2Bucket();
  await seedEncryptedPlan(r2, planRunId);
  const storage = new FakeDoStorage();
  storage.failPutAfterCommit(1);
  let providerCalls = 0;
  const container = mutationSuccessContainer(planRunId, () => {
    providerCalls += 1;
  });
  const options = {
    storage,
    env: {
      TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: RUN_CREDENTIAL_SIGNING_SECRET,
    },
  };
  const token = await signedMutationToken(planRunId, {
    jti: "runtime-input-semantics",
  });
  const first = await runnerWithContainer(r2, container, options).fetch(
    signedMutationRequest(planRunId, token, {
      runtimeInputValue: "runtime-input-original-value",
    }),
  );
  assert.equal(first.status, 500);
  assert.equal(providerCalls, 0);

  // The durable record carries a one-way digest only: no raw value, and no
  // serialized copy of the delivered map.
  const evidence = JSON.stringify(storage.entries());
  assert.equal(evidence.includes("runtime-input-original-value"), false);
  assert.match(evidence, /"semanticDigest":"sha256:[0-9a-f]{64}"/u);

  // A different value is a different mutation, so redelivery under the same
  // run must not silently reuse the earlier at-most-once identity.
  const changed = await runnerWithContainer(r2, container, options).fetch(
    signedMutationRequest(planRunId, token, {
      runtimeInputValue: "runtime-input-changed-value",
    }),
  );
  assert.equal(changed.status, 409);
  assert.equal(providerCalls, 0);

  // The value-free part participates too: the declared binding names are in
  // the semantics, so widening them is also a different mutation.
  const widened = await runnerWithContainer(r2, container, options).fetch(
    signedMutationRequest(planRunId, token, {
      runtimeInputValue: "runtime-input-original-value",
      runtimeInputNames: ["SESSION_KEY", "SIGNING_KEY"],
    }),
  );
  assert.equal(widened.status, 409);
  assert.equal(providerCalls, 0);

  // The identical dispatch resumes the same mutation.
  const resumed = await runnerWithContainer(r2, container, options).fetch(
    signedMutationRequest(planRunId, token, {
      runtimeInputValue: "runtime-input-original-value",
    }),
  );
  assert.equal(resumed.status, 200);
  assert.equal(providerCalls, 1);
});

test("OpenTofu runner never dispatches when the durable dispatched transition loses its acknowledgement", async () => {
  const planRunId = "plan_dispatched_ack_lost";
  const r2 = new FakeR2Bucket();
  await seedEncryptedPlan(r2, planRunId);
  const storage = new FakeDoStorage();
  // Calls 1-2 atomically persist `preparing`; calls 3-4 atomically persist
  // `dispatched`. Lose the first acknowledgement of the second batch.
  storage.failPutAfterCommit(3);
  let providerCalls = 0;
  const container = mutationSuccessContainer(planRunId, () => {
    providerCalls += 1;
  });
  const options = {
    storage,
    env: {
      TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET:
        RUN_CREDENTIAL_SIGNING_SECRET,
    },
  };
  const firstToken = await signedMutationToken(planRunId, {
    jti: "dispatched-first",
  });
  const first = await runnerWithContainer(r2, container, options).fetch(
    signedMutationRequest(planRunId, firstToken),
  );
  assert.equal(first.status, 500);
  assert.equal(providerCalls, 0);
  const dispatchedEvidence = JSON.stringify(storage.entries());
  assert.match(dispatchedEvidence, /"phase":"dispatched"/);
  assert.equal(storage.entries().length, 2);

  const remintedToken = await signedMutationToken(planRunId, {
    jti: "dispatched-second",
  });
  const replay = await runnerWithContainer(r2, container, options).fetch(
    signedMutationRequest(planRunId, remintedToken),
  );
  assert.equal(replay.status, 409);
  assertMutationIndeterminateResponse(await replay.text(), "apply");
  assert.equal(providerCalls, 0);
});

test("OpenTofu runner adopts completed state only after fresh exact mutation authority verification", async () => {
  const planRunId = "plan_completed_destroy_adoption";
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  await seedEncryptedPlan(artifacts, planRunId);
  const storage = new FakeDoStorage();
  let providerCalls = 0;
  const container = mutationSuccessContainer(planRunId, () => {
    providerCalls += 1;
  });
  const options = {
    storage,
    stateBucket: state,
    env: {
      TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET:
        RUN_CREDENTIAL_SIGNING_SECRET,
    },
  };
  const stateScope = {
    workspaceId: "workspace_semantic",
    subject: { kind: "capsule", id: "capsule_semantic" },
    environment: "production",
    generation: 1,
    stateRef:
      "workspaces/workspace_semantic/capsules/capsule_semantic/environments/production/state-versions/00000001.tfstate.enc",
  };
  const originalToken = await signedMutationToken(planRunId, {
    action: "destroy",
    jti: "completed-original",
  });
  const first = await runnerWithContainer(artifacts, container, options).fetch(
    signedMutationRequest(planRunId, originalToken, {
      action: "destroy",
      stateScope,
    }),
  );
  assert.equal(first.status, 200);
  assert.equal(providerCalls, 1);
  assert.match(JSON.stringify(storage.entries()), /"phase":"dispatched"/);

  const expiredToken = await signedMutationToken(planRunId, {
    action: "destroy",
    jti: "completed-expired",
    nowMs: Date.now() - 120_000,
    ttlSeconds: 60,
  });
  const expiredReplay = await runnerWithContainer(
    artifacts,
    container,
    options,
  ).fetch(
    signedMutationRequest(planRunId, expiredToken, {
      action: "destroy",
      stateScope,
    }),
  );
  assert.equal(expiredReplay.status, 409);
  assertMutationIndeterminateResponse(
    await expiredReplay.text(),
    "destroy",
  );
  assert.equal(providerCalls, 1);

  const changedAuthorityToken = await signedMutationToken(planRunId, {
    action: "destroy",
    jti: "completed-changed-scope",
    scopes: ["provider:destroy", "provider:admin"],
  });
  const changedAuthorityReplay = await runnerWithContainer(
    artifacts,
    container,
    options,
  ).fetch(
    signedMutationRequest(planRunId, changedAuthorityToken, {
      action: "destroy",
      stateScope,
    }),
  );
  assert.equal(changedAuthorityReplay.status, 409);
  assertMutationIndeterminateResponse(
    await changedAuthorityReplay.text(),
    "destroy",
  );
  assert.equal(providerCalls, 1);

  const changedSubjectToken = await signedMutationToken(planRunId, {
    action: "destroy",
    jti: "completed-changed-subject",
    subject: "principal_changed",
  });
  const changedSubjectReplay = await runnerWithContainer(
    artifacts,
    container,
    options,
  ).fetch(
    signedMutationRequest(planRunId, changedSubjectToken, {
      action: "destroy",
      stateScope,
    }),
  );
  assert.equal(changedSubjectReplay.status, 409);
  assertMutationIndeterminateResponse(
    await changedSubjectReplay.text(),
    "destroy",
  );
  assert.equal(providerCalls, 1);

  const changedRunToken = await signedMutationToken(planRunId, {
    action: "destroy",
    jti: "completed-changed-run",
    runId: "apply_different",
  });
  const changedRunReplay = await runnerWithContainer(
    artifacts,
    container,
    options,
  ).fetch(
    signedMutationRequest(planRunId, changedRunToken, {
      action: "destroy",
      stateScope,
    }),
  );
  assert.equal(changedRunReplay.status, 409);
  assertMutationIndeterminateResponse(
    await changedRunReplay.text(),
    "destroy",
  );
  assert.equal(providerCalls, 1);

  const freshToken = await signedMutationToken(planRunId, {
    action: "destroy",
    jti: "completed-fresh",
  });
  const changedInputReplay = await runnerWithContainer(
    artifacts,
    container,
    options,
  ).fetch(
    signedMutationRequest(planRunId, freshToken, {
      action: "destroy",
      stateScope,
      sourceRef: "fedcba9876543210fedcba9876543210fedcba98",
    }),
  );
  assert.equal(changedInputReplay.status, 409);
  assertMutationIndeterminateResponse(
    await changedInputReplay.text(),
    "destroy",
  );
  assert.equal(providerCalls, 1);

  const exactReplay = await runnerWithContainer(
    artifacts,
    container,
    options,
  ).fetch(
    signedMutationRequest(planRunId, freshToken, {
      action: "destroy",
      stateScope,
      heartbeatAt: 2,
      requestedAt: "2026-08-13T00:02:00.000Z",
    }),
  );
  assert.equal(exactReplay.status, 200);
  assert.equal(providerCalls, 1);
});

test("OpenTofu runner Durable Object grants one concurrent mutation dispatch authority", async () => {
  const runId = "apply_concurrent_redelivery";
  const r2 = new FakeR2Bucket();
  await seedEncryptedPlan(r2, runId);
  const storage = new FakeDoStorage();
  const claimGate = storage.deferNextGet();
  let providerCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT") return Response.json({ ok: true });
      if (request.method === "POST" && path === `/runs/${runId}`) {
        providerCalls += 1;
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };
  const runner = runnerWithContainer(r2, container, { storage });

  const first = runner.fetch(mutationRequest(runId, "apply"));
  await claimGate.entered;
  const redelivery = runner.fetch(mutationRequest(runId, "apply"));
  const redeliveryResponse = await redelivery;
  assert.equal(redeliveryResponse.status, 409);
  assertMutationIndeterminateResponse(
    await redeliveryResponse.text(),
    "apply",
  );
  assert.equal(providerCalls, 0);

  claimGate.release();
  assert.equal((await first).status, 200);
  assert.equal(providerCalls, 1);
});

test("OpenTofu runner Durable Object replays a completed release without invoking commands twice", async () => {
  const applyRunId = "apply_release_completed_replay";
  const releaseRunId = `release_${applyRunId}`;
  const r2 = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  let releaseCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === `/runs/${releaseRunId}`) {
        releaseCalls += 1;
        return Response.json({
          runId: releaseRunId,
          action: "release",
          status: "succeeded",
          exitCode: 0,
          commandCount: 1,
          stdout: "release command output that must not be persisted",
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };
  const request = () =>
    new Request(`https://runner/runs/${releaseRunId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "release",
        runId: releaseRunId,
        request: {
          release: {
            commands: [
              {
                id: "activate",
                command: ["bun", "run", "activate"],
              },
            ],
          },
          activation: {
            applyRunId,
            workspaceId: "workspace_release",
            capsuleId: "capsule_release",
            stateVersionId: "state_release_1",
            sourceSnapshotId: "snapshot_release_1",
            sourceCommit: "0123456789abcdef0123456789abcdef01234567",
          },
          providerConfigurations: {
            format: "takosumi.provider-configurations@v1",
            providers: [],
          },
        },
      }),
    });

  const first = await runnerWithContainer(r2, container, { storage }).fetch(
    request(),
  );
  assert.equal(first.status, 200);
  const replay = await runnerWithContainer(r2, container, { storage }).fetch(
    request(),
  );

  assert.equal(replay.status, 200);
  assert.equal(releaseCalls, 1);
  assert.deepEqual(await replay.json(), {
    runId: releaseRunId,
    action: "release",
    status: "succeeded",
    exitCode: 0,
    commandCount: 1,
  });
});

test("OpenTofu runner Durable Object resumes preparing release authority with rematerialized runtime values and identical opaque credentials", async () => {
  const applyRunId = "apply_release_preparing_resume";
  const releaseRunId = `release_${applyRunId}`;
  const firstSecret = "first-runtime-secret-value-must-not-persist";
  const rematerializedSecret =
    "rematerialized-runtime-secret-value-must-not-persist";
  const providerSecret = "same-provider-credential-must-not-persist";
  const r2 = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  storage.failPutAfterCommit(2);
  let releaseCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === `/runs/${releaseRunId}`) {
        releaseCalls += 1;
        return Response.json({
          runId: releaseRunId,
          action: "release",
          status: "succeeded",
          exitCode: 0,
          commandCount: 1,
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };

  const first = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId, {
      runtimeSecret: firstSecret,
      providerSecret,
    }),
  );
  assert.equal(first.status, 500);
  assert.equal(releaseCalls, 0);

  const resumed = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId, {
      runtimeSecret: rematerializedSecret,
      providerSecret,
    }),
  );

  assert.equal(resumed.status, 200);
  assert.equal(releaseCalls, 1);
  const durableEvidence = JSON.stringify(storage.entries());
  for (const forbidden of [
    firstSecret,
    rematerializedSecret,
    providerSecret,
    "private/runtime-secrets.json",
  ]) {
    assert.equal(durableEvidence.includes(forbidden), false);
  }
});

test("OpenTofu runner Durable Object rejects changed opaque provider credential material while preparing", async () => {
  const applyRunId = "apply_release_provider_digest_drift";
  const firstProviderSecret = "first-provider-credential-must-not-persist";
  const changedProviderSecret = "changed-provider-credential-must-not-persist";
  const r2 = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  storage.failPutAfterCommit(2);
  let releaseCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === `/runs/release_${applyRunId}`
      ) {
        releaseCalls += 1;
        return Response.json({
          runId: `release_${applyRunId}`,
          action: "release",
          status: "succeeded",
          exitCode: 0,
          commandCount: 1,
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };

  const first = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId, {
      providerSecret: firstProviderSecret,
    }),
  );
  assert.equal(first.status, 500);
  assert.equal(releaseCalls, 0);

  const drifted = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId, {
      providerSecret: changedProviderSecret,
    }),
  );

  assert.equal(drifted.status, 409);
  assert.equal(releaseCalls, 0);
  const durableEvidence = JSON.stringify(storage.entries());
  assert.equal(durableEvidence.includes(firstProviderSecret), false);
  assert.equal(durableEvidence.includes(changedProviderSecret), false);
});

test("OpenTofu runner Durable Object resumes preparing release authority with an equivalent freshly signed credential", async () => {
  const planRunId = "release_signed_preparing_resume";
  const applyRunId = `apply_${planRunId}`;
  const releaseRunId = `release_${applyRunId}`;
  const firstToken = await signedMutationToken(planRunId, {
    action: "apply",
    jti: "release-signed-first",
  });
  const remintedToken = await signedMutationToken(planRunId, {
    action: "apply",
    jti: "release-signed-second",
  });
  const r2 = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  storage.failPutAfterCommit(2);
  let releaseCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === `/runs/${releaseRunId}`
      ) {
        releaseCalls += 1;
        return Response.json({
          runId: releaseRunId,
          action: "release",
          status: "succeeded",
          exitCode: 0,
          commandCount: 1,
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };
  const env = {
    TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: RUN_CREDENTIAL_SIGNING_SECRET,
  };

  const first = await runnerWithContainer(r2, container, {
    storage,
    env,
  }).fetch(
    durableReleaseRequest(applyRunId, {
      providerSecret: firstToken,
      providerSource: RUN_CREDENTIAL_PROVIDER,
      providerConnectionId: "connection_semantic",
      workspaceId: "workspace_semantic",
      capsuleId: "capsule_semantic",
    }),
  );
  assert.equal(first.status, 500);
  assert.equal(releaseCalls, 0);

  const resumed = await runnerWithContainer(r2, container, {
    storage,
    env,
  }).fetch(
    durableReleaseRequest(applyRunId, {
      providerSecret: remintedToken,
      providerSource: RUN_CREDENTIAL_PROVIDER,
      providerConnectionId: "connection_semantic",
      workspaceId: "workspace_semantic",
      capsuleId: "capsule_semantic",
    }),
  );

  assert.equal(resumed.status, 200);
  assert.equal(releaseCalls, 1);
  const evidence = JSON.stringify(storage.entries());
  assert.equal(evidence.includes(firstToken), false);
  assert.equal(evidence.includes(remintedToken), false);
});

test("OpenTofu runner Durable Object adopts a completed release when the completion acknowledgement is lost", async () => {
  const applyRunId = "apply_release_completed_ack_lost";
  const releaseRunId = `release_${applyRunId}`;
  const r2 = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  storage.failPutAfterCommit(5);
  let releaseCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === `/runs/${releaseRunId}`
      ) {
        releaseCalls += 1;
        return Response.json({
          runId: releaseRunId,
          action: "release",
          status: "succeeded",
          exitCode: 0,
          commandCount: 1,
          stdout: "ack-lost-release-output-must-not-be-replayed",
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };

  const first = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );
  assert.equal(first.status, 200);
  assert.equal((await first.text()).includes("ack-lost-release-output"), false);

  const replay = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );
  assert.equal(replay.status, 200);
  assert.equal(releaseCalls, 1);
  assert.match(JSON.stringify(storage.entries()), /"phase":"completed"/);
});

test("OpenTofu runner Durable Object replays bounded shared-redacted failed release diagnostics without credentials or outputs", async () => {
  const applyRunId = "apply_release_failed_completed";
  const releaseRunId = `release_${applyRunId}`;
  const failureSecret = "failed-release-secret-must-not-persist";
  const r2 = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  let releaseCalls = 0;
  let cleanupCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === `/runs/${releaseRunId}`
      ) {
        releaseCalls += 1;
        cleanupCalls += 1;
        return Response.json(
          {
            runId: releaseRunId,
            action: "release",
            status: "failed",
            exitCode: 17,
            phase: "release",
            failedCommandId: "activate",
            stderr: `release failed token=${failureSecret}`,
          },
          { status: 500 },
        );
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };

  const first = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );
  assert.equal(first.status, 500);
  const replay = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );

  assert.equal(replay.status, 500);
  const replayText = await replay.text();
  assert.equal(releaseCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(replayText.includes(failureSecret), false);
  assert.equal(JSON.stringify(storage.entries()).includes(failureSecret), false);
  assert.match(replayText, /automatic redispatch is blocked/);
  assert.match(JSON.stringify(storage.entries()), /"phase":"completed"/);
});

test("OpenTofu runner Durable Object blocks release redispatch when completion persistence does not land", async () => {
  const applyRunId = "apply_release_completion_not_committed";
  const releaseRunId = `release_${applyRunId}`;
  const r2 = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  storage.failPutBeforeCommit(5);
  let releaseCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === `/runs/${releaseRunId}`
      ) {
        releaseCalls += 1;
        return Response.json({
          runId: releaseRunId,
          action: "release",
          status: "succeeded",
          exitCode: 0,
          commandCount: 1,
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };

  const first = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );
  assert.equal(first.status, 409);
  assertReleaseIndeterminateResponse(await first.text());

  const retry = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );
  assert.equal(retry.status, 409);
  assertReleaseIndeterminateResponse(await retry.text());
  assert.equal(releaseCalls, 1);
  assert.match(JSON.stringify(storage.entries()), /"phase":"indeterminate"/);
});

test("OpenTofu runner Durable Object never invokes a release after dispatched persistence loses acknowledgement", async () => {
  const applyRunId = "apply_release_dispatched_ack_lost";
  const releaseRunId = `release_${applyRunId}`;
  const r2 = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  storage.failPutAfterCommit(3);
  let releaseCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === `/runs/${releaseRunId}`
      ) {
        releaseCalls += 1;
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };

  const first = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );
  assert.equal(first.status, 500);

  const retry = await runnerWithContainer(r2, container, { storage }).fetch(
    durableReleaseRequest(applyRunId),
  );
  assert.equal(retry.status, 409);
  assertReleaseIndeterminateResponse(await retry.text());
  assert.equal(releaseCalls, 0);
  assert.match(JSON.stringify(storage.entries()), /"phase":"dispatched"/);
});

test("OpenTofu runner Durable Object makes release transport loss durably indeterminate without redispatch", async () => {
  const applyRunId = "apply_release_transport_indeterminate";
  const releaseRunId = `release_${applyRunId}`;
  const runtimeSecret = "transport-runtime-secret-must-not-persist";
  const providerSecret = "transport-provider-secret-must-not-persist";
  const r2 = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  let releaseCalls = 0;
  let cleanupCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === `/runs/${releaseRunId}`
      ) {
        releaseCalls += 1;
        try {
          throw new TypeError(
            `release transport lost token=${providerSecret} path=/private/runtime`,
          );
        } finally {
          cleanupCalls += 1;
        }
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };
  const request = () =>
    durableReleaseRequest(applyRunId, { runtimeSecret, providerSecret });

  const first = await runnerWithContainer(r2, container, { storage }).fetch(
    request(),
  );
  assert.equal(first.status, 409);
  const firstText = await first.text();
  assertReleaseIndeterminateResponse(firstText);
  const retry = await runnerWithContainer(r2, container, { storage }).fetch(
    request(),
  );
  assert.equal(retry.status, 409);
  assert.equal(releaseCalls, 1);
  assert.equal(cleanupCalls, 1);
  const evidence = `${firstText}\n${JSON.stringify(storage.entries())}`;
  for (const forbidden of [runtimeSecret, providerSecret, "/private/runtime"]) {
    assert.equal(evidence.includes(forbidden), false);
  }
  assert.match(evidence, /"phase":"indeterminate"/);
});

test("OpenTofu runner Durable Object rejects ordered action, ApplyRun, source, state, and runtime profile drift", async () => {
  const applyRunId = "apply_release_semantic_drift";
  const releaseRunId = `release_${applyRunId}`;
  const r2 = new FakeR2Bucket();
  const storage = new FakeDoStorage();
  let releaseCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === `/runs/${releaseRunId}`
      ) {
        releaseCalls += 1;
        return Response.json({
          runId: releaseRunId,
          action: "release",
          status: "succeeded",
          exitCode: 0,
          commandCount: 2,
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };
  const options = {
    storage,
  };

  const first = await runnerWithContainer(r2, container, options).fetch(
    durableReleaseRequest(applyRunId, {
      commandIds: ["prepare", "activate"],
      runtimeSecret: "stable-profile-value",
    }),
  );
  assert.equal(first.status, 200);

  const driftedRequests = [
    durableReleaseRequest(applyRunId, {
      commandIds: ["activate", "prepare"],
      runtimeSecret: "stable-profile-value",
    }),
    durableReleaseRequest(applyRunId, {
      activationApplyRunId: "apply_release_semantic_drift_other",
      commandIds: ["prepare", "activate"],
      runtimeSecret: "stable-profile-value",
    }),
    durableReleaseRequest(applyRunId, {
      commandIds: ["prepare", "activate"],
      runtimeSecret: "stable-profile-value",
      sourceCommit: "fedcba9876543210fedcba9876543210fedcba98",
    }),
    durableReleaseRequest(applyRunId, {
      commandIds: ["prepare", "activate"],
      runtimeSecret: "stable-profile-value",
      stateVersionId: "state_release_2",
    }),
    durableReleaseRequest(applyRunId, {
      commandIds: ["prepare", "activate"],
      runtimeSecret: "rotated-profile-value",
      runtimeProfileDigest: `sha256:${"b".repeat(64)}`,
    }),
  ];
  for (const drifted of driftedRequests) {
    const response = await runnerWithContainer(r2, container, options).fetch(
      drifted,
    );
    assert.equal(response.status, 409);
    assertReleaseIndeterminateResponse(await response.text());
  }
  assert.equal(releaseCalls, 1);
});

test("OpenTofu runner Durable Object treats a response-body transport loss after apply as indeterminate", async () => {
  const runId = "apply_response_stream_lost";
  const r2 = new FakeR2Bucket();
  await seedEncryptedPlan(r2, runId);
  const storage = new FakeDoStorage();
  let providerCalls = 0;
  let destroyCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT") return Response.json({ ok: true });
      if (request.method === "POST" && path === `/runs/${runId}`) {
        providerCalls += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('{"status":"succeeded"'),
              );
              controller.error(
                new Error("response stream token=stream-raw-secret lost"),
              );
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };
  const request = () => mutationRequest(runId, "apply");
  const options = {
    storage,
    async destroy() {
      destroyCalls += 1;
    },
  };

  const first = await runnerWithContainer(r2, container, options).fetch(
    request(),
  );
  assert.equal(first.status, 409);
  const firstText = await first.text();
  assertMutationIndeterminateResponse(firstText, "apply");
  assert.equal(firstText.includes("stream-raw-secret"), false);
  assert.equal(providerCalls, 1);
  assert.equal(destroyCalls, 0);

  const replay = await runnerWithContainer(r2, container, options).fetch(
    request(),
  );
  assert.equal(replay.status, 409);
  assert.equal(providerCalls, 1);
  assert.equal(destroyCalls, 0);
});

test("OpenTofu runner Durable Object treats post-apply state transport loss as indeterminate", async () => {
  const runId = "apply_state_transport_lost";
  const r2 = new FakeR2Bucket();
  await seedEncryptedPlan(r2, runId);
  const storage = new FakeDoStorage();
  let providerCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT") return Response.json({ ok: true });
      if (request.method === "POST" && path === `/runs/${runId}`) {
        providerCalls += 1;
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (
        request.method === "GET" &&
        path === `/runs/${runId}/artifacts/tfstate`
      ) {
        throw new TypeError(
          "state transport password=state-transport-raw-secret lost",
        );
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };
  const request = () =>
    mutationRequest(runId, "apply", {
      planRun: { id: runId, capsuleId: "capsule_state_transport" },
    });

  const first = await runnerWithContainer(r2, container, { storage }).fetch(
    request(),
  );
  assert.equal(first.status, 409);
  const firstText = await first.text();
  assertMutationIndeterminateResponse(firstText, "apply");
  assert.equal(firstText.includes("state-transport-raw-secret"), false);
  assert.equal(providerCalls, 1);

  const replay = await runnerWithContainer(r2, container, { storage }).fetch(
    request(),
  );
  assert.equal(replay.status, 409);
  assert.equal(providerCalls, 1);
});

test("OpenTofu runner Durable Object may redispatch read-only plan after a stopped-container race", async () => {
  let planCalls = 0;
  const runner = runnerWithContainer(new FakeR2Bucket(), {
    async containerFetch(request) {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === "/runs/plan_safe_retry"
      ) {
        planCalls += 1;
        if (planCalls === 1) {
          throw new Error(
            "The container is not running, consider calling start()",
          );
        }
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_safe_retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_safe_retry",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(planCalls, 2);
});

test("OpenTofu runner Durable Object releases a provable pre-dispatch preparation for safe retry", async () => {
  const runId = "apply_health_retry";
  const r2 = new FakeR2Bucket();
  await seedEncryptedPlan(r2, runId);
  const storage = new FakeDoStorage();
  let providerCalls = 0;
  const container: ContainerRequestFetcher = {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (
        request.method === "PUT" &&
        path === `/runs/${runId}/artifacts/tfplan`
      ) {
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === `/runs/${runId}`) {
        providerCalls += 1;
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };
  const request = () =>
    new Request(`https://runner/runs/${runId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId,
        request: {
          planArtifact: {
            kind: "object-storage",
            ref: `r2://takos-artifacts/opentofu-plan-runs/${runId}/tfplan`,
            digest: PLAN_DIGEST,
          },
        },
      }),
    });

  const unavailableRunner = runnerWithContainer(r2, container, {
    storage,
    async healthFetch() {
      throw new Error("container health unavailable before dispatch");
    },
  });
  const unavailable = await unavailableRunner.fetch(request());
  assert.equal(unavailable.status, 500);
  assert.equal(providerCalls, 0);
  assert.deepEqual(storage.entries(), []);

  const restartedRunner = runnerWithContainer(r2, container, { storage });
  const retried = await restartedRunner.fetch(request());
  assert.equal(retried.status, 200);
  assert.equal(providerCalls, 1);
});

test("OpenTofu runner Durable Object rejects plaintext-only R2 plan artifacts", async () => {
  const r2 = new FakeR2Bucket();
  await r2.put("opentofu-plan-runs/plan_1/tfplan", PLAN_BYTES, {
    httpMetadata: { contentType: "application/vnd.opentofu.plan" },
    customMetadata: { "takosumi-digest": PLAN_DIGEST },
  });
  const runner = runnerWithContainer(r2, {
    async containerFetch() {
      throw new Error("container should not be called");
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
  const text = await response.text();
  assert.match(text, /OpenTofu runner artifact relay failed/);
  assert.match(text, /runner_artifact_relay_failed/);
  assert.match(text, /relay_failure/);
  assert.equal(text.includes("plan artifact object not found"), false);
});

test("OpenTofu runner Durable Object restores and persists operator-managed state", async () => {
  const calls: string[] = [];
  const r2 = new FakeR2Bucket();
  const stateBackendRef = "state://takosumi/opentofu-default";
  const stateKey = `${await testStateBackendPrefix(stateBackendRef)}/capsules/inst_1/terraform.tfstate`;
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const sealedState = await crypto.seal(STATE_BYTES);
  await r2.put(`${stateKey}.enc`, sealedState.ciphertext, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { "takosumi-content-digest": sealedState.contentDigest },
  });
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await r2.put("opentofu-plan-runs/plan_1/tfplan.enc", sealedPlan.ciphertext, {
    httpMetadata: { contentType: "application/vnd.opentofu.plan" },
    customMetadata: { "takosumi-content-digest": sealedPlan.contentDigest },
  });
  const runner = runnerWithContainer(r2, {
    async containerFetch(request) {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      const path = new URL(request.url).pathname;
      if (
        request.method === "PUT" &&
        path === "/runs/plan_1/artifacts/tfstate"
      ) {
        assert.deepEqual(
          new Uint8Array(await request.arrayBuffer()),
          STATE_BYTES,
        );
        return Response.json({ ok: true });
      }
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
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_1/artifacts/tfstate"
      ) {
        return new Response(UPDATED_STATE_BYTES, {
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
          planRun: {
            id: "plan_1",
            capsuleId: "inst_1",
            workspaceId: "space_1",
            runnerProfileId: "opentofu-default",
            source: {
              kind: "git",
              url: "https://github.com/example/app.git",
              ref: "main",
            },
          },
          runnerProfile: {
            id: "opentofu-default",
            stateBackend: {
              kind: "operator-managed",
              ref: stateBackendRef,
            },
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
  assert.deepEqual(calls, [
    "PUT /runs/plan_1/artifacts/tfplan",
    "PUT /runs/plan_1/artifacts/tfstate",
    "POST /runs/plan_1",
    "GET /runs/plan_1/artifacts/tfstate",
  ]);
  assert.equal(r2.body(stateKey), undefined);
  const updatedEncrypted = r2.body(`${stateKey}.enc`);
  assert.ok(updatedEncrypted);
  assert.deepEqual(
    await crypto.open(updatedEncrypted, await digestBytes(UPDATED_STATE_BYTES)),
    UPDATED_STATE_BYTES,
  );
});

test("OpenTofu runner Durable Object restores a verified R2_STATE object into a new generation", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new FakeR2Bucket();
  const crypto = restoreTestCrypto();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const runner = runnerWithContainer(
    artifacts,
    {
      async containerFetch() {
        return Response.json(
          { error: "restore should not reach container" },
          {
            status: 500,
          },
        );
      },
    },
    { stateBucket: state },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/restore_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "restore",
        runId: "restore_1",
        request: {
          stateScope: {
            workspaceId: "space_1",
            subject: { kind: "capsule", id: "inst_1" },
            environment: "production",
            generation: 2,
            stateRef:
              "workspaces/space_1/capsules/inst_1/environments/production/state-versions/00000002.tfstate.enc",
          },
          restoreState: source,
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    state: {
      generation: number;
      stateRef: string;
      logicalTargetStateRef: string;
      digest: string;
      restoreAuthority: {
        kind: string;
        version: number;
        fence: number;
        operationId: string;
        stateEtag: string;
      };
    };
  };
  assert.equal(payload.state.generation, 2);
  assert.equal(
    payload.state.logicalTargetStateRef,
    "workspaces/space_1/capsules/inst_1/environments/production/state-versions/00000002.tfstate.enc",
  );
  assert.match(payload.state.stateRef, /\/restore-operations\//u);
  const restored = state.body(payload.state.stateRef);
  assert.ok(restored);
  assert.deepEqual(
    await crypto.open(restored, payload.state.digest),
    STATE_BYTES,
  );
  assert.equal(state.body(RESTORE_TARGET_KEY), undefined);
  assert.equal(state.body(RESTORE_CURRENT_KEY), undefined);
  assert.equal(
    payload.state.restoreAuthority.kind,
    "takosumi.runner-restore-ack@v1",
  );
  assert.equal(payload.state.restoreAuthority.version, 1);
  assert.equal(payload.state.restoreAuthority.fence, 1);
  assert.match(
    payload.state.restoreAuthority.operationId,
    /^00000001-/u,
  );
  assert.equal(
    payload.state.restoreAuthority.stateEtag,
    (await state.head(payload.state.stateRef))?.etag,
  );
});

test("OpenTofu runner Restore rejects an incomplete or mismatched canonical source StateVersion proof", async () => {
  const scenarios: readonly {
    readonly name: string;
    readonly change: (
      source: RestoreSourceDescriptor,
    ) => Readonly<Record<string, unknown>> | RestoreSourceDescriptor;
  }[] = [
    {
      name: "missing exact StateVersion identity",
      change: (source) => ({
        stateRef: source.stateRef,
        digest: source.digest,
      }),
    },
    {
      name: "wrong earlier generation",
      change: (source) => ({ ...source, generation: source.generation - 1 }),
    },
    {
      name: "wrong canonical StateVersion id",
      change: (source) => ({
        ...source,
        stateVersionId: "state_different_apply_authority",
      }),
    },
    {
      name: "wrong creator Run",
      change: (source) => ({
        ...source,
        createdByRunId: "apply_different_creator",
      }),
    },
    {
      name: "cross-workspace descriptor",
      change: (source) => ({ ...source, workspaceId: "space_2" }),
    },
    {
      name: "cross-capsule descriptor",
      change: (source) => ({ ...source, capsuleId: "inst_2" }),
    },
    {
      name: "cross-environment descriptor",
      change: (source) => ({ ...source, environment: "staging" }),
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const state = new HookedR2Bucket();
    const source = await seedRestoreSource(state, 1, STATE_BYTES);
    const runner = restoreRunner(state);

    const response = await runner.fetch(
      restoreRequest(
        `restore_canonical_proof_${index}`,
        scenario.change(source),
      ),
    );

    assert.notEqual(response.status, 200, scenario.name);
    assert.equal(state.restoreStageKeys().length, 0, scenario.name);
  }
});

test("OpenTofu runner Restore rejects a Restore-origin StateVersion id not bound to its object", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const ledger = new FakeRestoreLedgerDatabase();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const runner = restoreRunner(state, storage, ledger);
  const restored = await runner.fetch(
    restoreRequest("restore_origin_source", source),
  );
  assert.equal(restored.status, 200);
  const payload = (await restored.json()) as {
    state: { stateRef: string; digest: string; runId: string };
  };
  const exactRestoreOrigin: RestoreSourceDescriptor = {
    stateVersionId: "state_restore_origin_exact",
    workspaceId: "space_1",
    capsuleId: "inst_1",
    environment: "production",
    generation: 2,
    stateRef: payload.state.stateRef,
    digest: payload.state.digest,
    createdByRunId: payload.state.runId,
  };
  ledger.referenceExactStateVersion(exactRestoreOrigin);
  const forgedRestoreOrigin = {
    ...exactRestoreOrigin,
    stateVersionId: "state_restore_origin_forged",
  };
  const originObject = await state.head(payload.state.stateRef);
  assert.equal(
    originObject?.customMetadata?.["takosumi-restored-from-state-version-id"],
    source.stateVersionId,
  );
  assert.notEqual(
    originObject?.customMetadata?.["takosumi-restored-from-state-version-id"],
    exactRestoreOrigin.stateVersionId,
  );

  const replayed = await runner.fetch(
    restoreRequest("restore_from_origin", forgedRestoreOrigin, undefined, {
      generation: 3,
    }),
  );

  assert.notEqual(replayed.status, 200);
  assert.equal(state.restoreStageKeys().length, 1);
  assert.equal(ledger.sourceQueryCount, 1);
});

test("OpenTofu runner Restore accepts the exact ledger-bound Restore-origin StateVersion", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const ledger = new FakeRestoreLedgerDatabase();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const runner = restoreRunner(state, storage, ledger);
  const restored = await runner.fetch(
    restoreRequest("restore_origin_exact_source", source),
  );
  assert.equal(restored.status, 200);
  const payload = (await restored.json()) as {
    state: { stateRef: string; digest: string; runId: string };
  };
  const restoreOrigin: RestoreSourceDescriptor = {
    stateVersionId: "state_restore_origin_exact",
    workspaceId: "space_1",
    capsuleId: "inst_1",
    environment: "production",
    generation: 2,
    stateRef: payload.state.stateRef,
    digest: payload.state.digest,
    createdByRunId: payload.state.runId,
  };
  ledger.referenceExactStateVersion(restoreOrigin);

  const replayed = await runner.fetch(
    restoreRequest("restore_from_exact_origin", restoreOrigin, undefined, {
      generation: 3,
    }),
  );

  assert.equal(replayed.status, 200);
  assert.equal(state.restoreStageKeys().length, 2);
  assert.equal(ledger.sourceQueryCount, 1);
});

test("OpenTofu runner Restore rejects mismatched Restore-origin object authority proof", async () => {
  const scenarios = [
    ["takosumi-run-id", "restore_different_creator"],
    ["takosumi-generation", "1"],
    ["takosumi-workspace-id", "space_2"],
    ["takosumi-capsule-id", "inst_2"],
    ["takosumi-environment", "staging"],
    [
      "takosumi-logical-target-state-ref",
      `${RESTORE_STATE_PREFIX}/00000001.tfstate.enc`,
    ],
    ["takosumi-restore-fence", "999"],
    [
      "takosumi-restored-from-object",
      "workspaces/space_2/capsules/inst_1/environments/production/state-versions/00000001.tfstate.enc",
    ],
  ] as const;

  for (const [index, [metadataName, invalidValue]] of scenarios.entries()) {
    const state = new HookedR2Bucket();
    const storage = new FakeDoStorage();
    const ledger = new FakeRestoreLedgerDatabase();
    const canonical = await seedRestoreSource(state, 1, STATE_BYTES);
    const runner = restoreRunner(state, storage, ledger);
    const restored = await runner.fetch(
      restoreRequest(`restore_origin_seed_${index}`, canonical),
    );
    assert.equal(restored.status, 200);
    const payload = (await restored.json()) as {
      state: { stateRef: string; digest: string; runId: string };
    };
    const object = await state.get(payload.state.stateRef);
    assert.ok(object);
    await state.put(payload.state.stateRef, await object.arrayBuffer(), {
      httpMetadata: object.httpMetadata,
      customMetadata: {
        ...object.customMetadata,
        "takosumi-workspace-id": "space_1",
        "takosumi-capsule-id": "inst_1",
        "takosumi-environment": "production",
        [metadataName]: invalidValue,
      },
    });
    const restoreOrigin: RestoreSourceDescriptor = {
      stateVersionId: `state_restore_origin_${index}`,
      workspaceId: "space_1",
      capsuleId: "inst_1",
      environment: "production",
      generation: 2,
      stateRef: payload.state.stateRef,
      digest: payload.state.digest,
      createdByRunId: payload.state.runId,
    };
    ledger.referenceExactStateVersion(restoreOrigin);

    const response = await runner.fetch(
      restoreRequest(
        `restore_from_tampered_origin_${index}`,
        restoreOrigin,
        undefined,
        { generation: 3 },
      ),
    );

    assert.notEqual(response.status, 200, metadataName);
    assert.equal(ledger.sourceQueryCount, 1, metadataName);
  }
});

test("OpenTofu runner Restore fails closed on uncertain Restore-origin StateVersion authority", async () => {
  const scenarios = [
    {
      name: "missing",
      arrange: (_ledger: FakeRestoreLedgerDatabase) => {},
    },
    {
      name: "multiple",
      arrange: (ledger: FakeRestoreLedgerDatabase) => {
        ledger.exactStateVersionCountOverride = 2;
      },
    },
    {
      name: "malformed",
      arrange: (ledger: FakeRestoreLedgerDatabase) => {
        ledger.exactStateVersionCountOverride = "1";
      },
    },
    {
      name: "unavailable",
      arrange: (ledger: FakeRestoreLedgerDatabase) => {
        ledger.unavailable = true;
      },
    },
  ] as const;

  for (const [index, scenario] of scenarios.entries()) {
    const state = new HookedR2Bucket();
    const storage = new FakeDoStorage();
    const ledger = new FakeRestoreLedgerDatabase();
    const canonical = await seedRestoreSource(state, 1, STATE_BYTES);
    const runner = restoreRunner(state, storage, ledger);
    const restored = await runner.fetch(
      restoreRequest(`restore_uncertain_source_${index}`, canonical),
    );
    assert.equal(restored.status, 200, scenario.name);
    const payload = (await restored.json()) as {
      state: { stateRef: string; digest: string; runId: string };
    };
    const restoreOrigin: RestoreSourceDescriptor = {
      stateVersionId: `state_restore_uncertain_${index}`,
      workspaceId: "space_1",
      capsuleId: "inst_1",
      environment: "production",
      generation: 2,
      stateRef: payload.state.stateRef,
      digest: payload.state.digest,
      createdByRunId: payload.state.runId,
    };
    scenario.arrange(ledger);

    const response = await runner.fetch(
      restoreRequest(
        `restore_from_uncertain_origin_${index}`,
        restoreOrigin,
        undefined,
        { generation: 3 },
      ),
    );

    assert.notEqual(response.status, 200, scenario.name);
    assert.equal(state.restoreStageKeys().length, 1, scenario.name);
    assert.equal(ledger.sourceQueryCount, 1, scenario.name);
  }
});

test("OpenTofu runner uses the exact immutable Restore StateVersion ref for the next Plan", async () => {
  const artifacts = new FakeR2Bucket();
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const calls: string[] = [];
  const runner = runnerWithContainer(
    artifacts,
    {
      async containerFetch(request) {
        const path = new URL(request.url).pathname;
        calls.push(`${request.method} ${path}`);
        if (
          request.method === "PUT" &&
          path === "/runs/plan_after_restore/artifacts/tfstate"
        ) {
          assert.deepEqual(
            new Uint8Array(await request.arrayBuffer()),
            STATE_BYTES,
          );
          return Response.json({ ok: true });
        }
        if (
          request.method === "POST" &&
          path === "/runs/plan_after_restore"
        ) {
          return Response.json({
            status: "succeeded",
            exitCode: 0,
            planDigest: PLAN_DIGEST,
            planArtifact: {
              kind: "runner-local",
              ref: "runner-local://plan_after_restore/tfplan",
              digest: PLAN_DIGEST,
            },
          });
        }
        if (
          request.method === "GET" &&
          path === "/runs/plan_after_restore/artifacts/tfplan"
        ) {
          return new Response(PLAN_BYTES, {
            headers: { "content-type": "application/vnd.opentofu.plan" },
          });
        }
        if (
          request.method === "GET" &&
          path === "/runs/plan_after_restore/artifacts/tfplan-json"
        ) {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    },
    { stateBucket: state, storage },
  );
  const restored = await runner.fetch(
    restoreRequest("restore_then_plan", source),
  );
  assert.equal(restored.status, 200);
  const restorePayload = (await restored.json()) as {
    state: { stateRef: string; digest: string; runId: string };
  };

  const planned = await runner.fetch(
    planRequestWithPriorState("plan_after_restore", {
      generation: 2,
      stateRef: restorePayload.state.stateRef,
      digest: restorePayload.state.digest,
      createdByRunId: restorePayload.state.runId,
    }),
  );

  assert.equal(planned.status, 200);
  assert.deepEqual(calls, [
    "PUT /runs/plan_after_restore/artifacts/tfstate",
    "POST /runs/plan_after_restore",
    "GET /runs/plan_after_restore/artifacts/tfplan",
    "GET /runs/plan_after_restore/artifacts/tfplan-json",
  ]);
});

test("OpenTofu runner rejects an immutable Restore StateVersion ref outside its exact state scope", async () => {
  const state = new HookedR2Bucket();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  let containerCalls = 0;
  const runner = runnerWithContainer(
    new FakeR2Bucket(),
    {
      async containerFetch() {
        containerCalls += 1;
        return Response.json({ status: "succeeded", exitCode: 0 });
      },
    },
    { stateBucket: state },
  );
  const restored = await runner.fetch(
    restoreRequest("restore_scope_jail", source),
  );
  assert.equal(restored.status, 200);
  const restorePayload = (await restored.json()) as {
    state: { stateRef: string; digest: string; runId: string };
  };
  const exactObject = await state.get(restorePayload.state.stateRef);
  assert.ok(exactObject);
  const crossWorkspaceRef = restorePayload.state.stateRef.replace(
    "workspaces/space_1/",
    "workspaces/space_2/",
  );
  await state.put(crossWorkspaceRef, await exactObject.arrayBuffer(), {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: exactObject.customMetadata,
  });

  const planned = await runner.fetch(
    planRequestWithPriorState("plan_cross_scope_restore", {
      generation: 2,
      stateRef: crossWorkspaceRef,
      digest: restorePayload.state.digest,
      createdByRunId: restorePayload.state.runId,
    }),
  );

  assert.equal(planned.status, 500);
  assert.equal(containerCalls, 0);
});

test("OpenTofu runner Restore stops after the exact source read when its request is aborted", async () => {
  const controller = new AbortController();
  const state = new HookedR2Bucket();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  state.afterGet = (key) => {
    if (key === source.stateRef) controller.abort("capsule lease lost");
  };
  const runner = restoreRunner(state);

  const response = await runner.fetch(
    restoreRequest("restore_abort_after_read", source, controller.signal),
  );

  assert.notEqual(response.status, 200);
  assert.equal(state.body(RESTORE_TARGET_KEY), undefined);
  assert.equal(state.body(RESTORE_CURRENT_KEY), undefined);
  assert.deepEqual(state.restoreStageKeys(), []);
});

test("OpenTofu runner Restore does not retry an R2 state write after abort", async () => {
  const controller = new AbortController();
  const state = new HookedR2Bucket();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  state.beforePut = (key) => {
    if (!isRestoreStateWrite(key)) return;
    controller.abort("capsule lease lost");
    throw new Error("internal error after lease loss");
  };
  const runner = restoreRunner(state);

  const response = await runner.fetch(
    restoreRequest("restore_abort_during_put", source, controller.signal),
  );

  assert.notEqual(response.status, 200);
  assert.equal(state.restoreStatePutAttempts, 1);
  assert.equal(state.body(RESTORE_TARGET_KEY), undefined);
  assert.equal(state.body(RESTORE_CURRENT_KEY), undefined);
});

test("OpenTofu runner Restore leaves a late-completing aborted state stage harmless", async () => {
  const controller = new AbortController();
  const state = new HookedR2Bucket();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const statePutGate = deferredGate();
  state.beforePut = async (key) => {
    if (!isRestoreStateWrite(key)) return;
    statePutGate.enter();
    await statePutGate.wait;
  };
  const runner = restoreRunner(state);

  const pending = runner.fetch(
    restoreRequest("restore_abort_late_stage", source, controller.signal),
  );
  await statePutGate.entered;
  controller.abort("capsule lease lost");
  statePutGate.release();
  const response = await pending;

  assert.notEqual(response.status, 200);
  assert.equal(state.restoreStatePutAttempts, 1);
  assert.equal(state.body(RESTORE_TARGET_KEY), undefined);
  assert.equal(state.body(RESTORE_CURRENT_KEY), undefined);
  assert.equal(state.restoreStageKeys().length, 1);
});

test("OpenTofu runner Restore checks abort after the state write and before DO authority commit", async () => {
  const controller = new AbortController();
  const state = new HookedR2Bucket();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  state.afterPut = (key) => {
    if (key.includes("/restore-operations/")) {
      controller.abort("capsule lease lost");
    }
  };
  const runner = restoreRunner(state);

  const response = await runner.fetch(
    restoreRequest("restore_abort_before_pointer", source, controller.signal),
  );

  assert.notEqual(response.status, 200);
  assert.equal(state.body(RESTORE_CURRENT_KEY), undefined);
});

test("OpenTofu runner Restore keeps the prior ack when a stale PUT lands after an aborted successor claim", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const priorSource = await seedRestoreSource(state, 1, STATE_BYTES);
  const successorSource = await seedRestoreSource(state, 0, UPDATED_STATE_BYTES);
  const runner = restoreRunner(state, storage);
  const priorResponse = await runner.fetch(
    restoreRequest("restore_prior", priorSource),
  );
  assert.equal(priorResponse.status, 200);
  const priorPayload = (await priorResponse.json()) as {
    state: {
      stateRef: string;
      restoreAuthority: { version: number; fence: number };
    };
  };
  const oldPutGate = deferredGate();
  state.beforePut = async (key, options) => {
    if (
      key.includes("/restore-operations/") &&
      options?.customMetadata?.["takosumi-run-id"] === "restore_old"
    ) {
      oldPutGate.enter();
      await oldPutGate.wait;
    }
  };

  const old = runner.fetch(restoreRequest("restore_old", priorSource));
  await oldPutGate.entered;

  const successorController = new AbortController();
  state.afterGet = (key) => {
    if (key === successorSource.stateRef) {
      successorController.abort("successor lease lost");
    }
  };
  const successor = await runner.fetch(
    restoreRequest(
      "restore_successor",
      successorSource,
      successorController.signal,
    ),
  );
  assert.notEqual(successor.status, 200);

  oldPutGate.release();
  const oldResponse = await old;
  assert.notEqual(oldResponse.status, 200);

  const authority = storage.valueByPrefix(
    "runner-restore-authority@v2:",
  ) as {
    nextFence: number;
    claimant: { runId: string; phase: string; fence: number };
    lastCommitted: { runId: string; stateRef: string; version: number };
  };
  assert.equal(authority.nextFence, 3);
  assert.equal(authority.claimant.runId, "restore_successor");
  assert.equal(authority.claimant.phase, "abandoned");
  assert.equal(authority.claimant.fence, 3);
  assert.equal(authority.lastCommitted.runId, "restore_prior");
  assert.equal(authority.lastCommitted.stateRef, priorPayload.state.stateRef);
  assert.equal(authority.lastCommitted.version, 1);
  assert.equal(priorPayload.state.restoreAuthority.version, 1);
  assert.equal(priorPayload.state.restoreAuthority.fence, 1);
  assert.ok(state.body(priorPayload.state.stateRef));
  assert.equal(state.body(RESTORE_TARGET_KEY), undefined);
  assert.equal(state.body(RESTORE_CURRENT_KEY), undefined);
  assert.equal(state.restoreStageKeys().length, 2);
});

test("OpenTofu runner Restore refuses a committed ack after a successor claim reenters before response", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const oldSource = await seedRestoreSource(state, 1, STATE_BYTES);
  const successorSource = await seedRestoreSource(state, 0, UPDATED_STATE_BYTES);
  const runner = restoreRunner(state, storage);
  const successorController = new AbortController();
  state.afterGet = (key) => {
    if (key === successorSource.stateRef) {
      successorController.abort("successor lease lost");
    }
  };
  let successorResponse: Response | undefined;
  state.afterHead = async (_key, object) => {
    if (
      successorResponse ||
      object?.customMetadata?.["takosumi-run-id"] !== "restore_old_ack"
    ) {
      return;
    }
    state.afterHead = undefined;
    successorResponse = await runner.fetch(
      restoreRequest(
        "restore_successor_ack",
        successorSource,
        successorController.signal,
      ),
    );
  };

  const oldResponse = await runner.fetch(
    restoreRequest("restore_old_ack", oldSource),
  );

  assert.ok(successorResponse);
  assert.notEqual(successorResponse.status, 200);
  assert.notEqual(oldResponse.status, 200);
  const authority = storage.valueByPrefix(
    "runner-restore-authority@v2:",
  ) as {
    nextFence: number;
    claimant: { runId: string; phase: string; fence: number };
    lastCommitted: { runId: string; version: number; stateRef: string };
  };
  assert.equal(authority.nextFence, 2);
  assert.equal(authority.claimant.runId, "restore_successor_ack");
  assert.equal(authority.claimant.phase, "abandoned");
  assert.equal(authority.claimant.fence, 2);
  assert.equal(authority.lastCommitted.runId, "restore_old_ack");
  assert.equal(authority.lastCommitted.version, 1);
  assert.ok(state.body(authority.lastCommitted.stateRef));
  assert.equal(state.body(RESTORE_TARGET_KEY), undefined);
  assert.equal(state.body(RESTORE_CURRENT_KEY), undefined);
});

test("OpenTofu runner Restore replays the exact committed DO acknowledgement", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const runner = restoreRunner(state, storage);

  const first = await runner.fetch(restoreRequest("restore_replay", source));
  const second = await runner.fetch(restoreRequest("restore_replay", source));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstPayload = (await first.json()) as { state: unknown };
  const secondPayload = (await second.json()) as { state: unknown };
  assert.deepEqual(secondPayload.state, firstPayload.state);
  assert.equal(state.restoreStageKeys().length, 1);
  const authority = storage.valueByPrefix(
    "runner-restore-authority@v2:",
  ) as { nextFence: number };
  assert.equal(authority.nextFence, 1);
});

test("OpenTofu runner Restore rolls back a partial DO acknowledgement transaction", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  // Claim writes authority + collection record. Fail the second commit write
  // after the tentative authority update; the explicit transaction must roll
  // both back before abandonment is recorded.
  storage.failPutBeforeCommit(4);
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const runner = restoreRunner(state, storage);

  const failed = await runner.fetch(
    restoreRequest("restore_ack_transaction_failure", source),
  );

  assert.notEqual(failed.status, 200);
  const failedAuthority = storage.valueByPrefix(
    "runner-restore-authority@v2:",
  ) as {
    claimant: { phase: string; fence: number };
    lastCommitted?: unknown;
  };
  assert.equal(failedAuthority.claimant.phase, "abandoned");
  assert.equal(failedAuthority.claimant.fence, 1);
  assert.equal(failedAuthority.lastCommitted, undefined);

  const successor = await runner.fetch(
    restoreRequest("restore_after_ack_transaction_failure", source),
  );
  assert.equal(successor.status, 200);
  const payload = (await successor.json()) as {
    state: { restoreAuthority: { version: number; fence: number } };
  };
  assert.equal(payload.state.restoreAuthority.version, 1);
  assert.equal(payload.state.restoreAuthority.fence, 2);
});

test("OpenTofu runner production export owns the Restore collection alarm handler", () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      OpenTofuRunnerObject.prototype,
      "alarm",
    ),
    true,
  );
  assert.equal(typeof OpenTofuRunnerObject.prototype.alarm, "function");
  assert.equal(
    typeof restoreRunner(new HookedR2Bucket()).alarm,
    "function",
  );
});

test("OpenTofu runner Restore alarm cannot collect the current claimant during upload", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const ledger = new FakeRestoreLedgerDatabase();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const putGate = deferredGate();
  state.beforePut = async (key, options) => {
    if (
      key.includes("/restore-operations/") &&
      options?.customMetadata?.["takosumi-run-id"] === "restore_alarm_race"
    ) {
      putGate.enter();
      await putGate.wait;
    }
  };
  ledger.setRunStatus("restore_alarm_race", "running");
  const runner = restoreRunner(state, storage, ledger);
  const pending = runner.fetch(restoreRequest("restore_alarm_race", source));
  await putGate.entered;
  storage.makeRestoreStagesDue();

  await runner.alarm();

  assert.equal(storage.restoreStageTrackingCount(), 1);
  assert.equal(state.restoreStageKeys().length, 0);
  putGate.release();
  const response = await pending;
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { state: { stateRef: string } };
  assert.ok(state.body(payload.state.stateRef));
});

test("OpenTofu runner Restore collector delegates to the Containers runtime alarm handler", async () => {
  const source = await Bun.file(
    new URL(
      "../../../../worker/src/durable/OpenTofuRunnerObject.ts",
      import.meta.url,
    ),
  ).text();

  assert.match(
    source,
    /async alarm\(alarmProps\?: unknown\)[\s\S]*?await super\.alarm\(alarmProps\)/u,
  );
});

test("OpenTofu runner Restore collector deletes a crashed current claimant only after its Run is terminal non-committing", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const ledger = new FakeRestoreLedgerDatabase();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const stagePutGate = deferredGate();
  state.afterPut = async (key, options) => {
    if (
      key.includes("/restore-operations/") &&
      options?.customMetadata?.["takosumi-run-id"] ===
        "restore_crashed_claim"
    ) {
      stagePutGate.enter();
      await stagePutGate.wait;
    }
  };
  ledger.setRunStatus("restore_crashed_claim", "failed");
  const runner = restoreRunner(state, storage, ledger);
  const pending = runner.fetch(
    restoreRequest("restore_crashed_claim", source),
  );
  await stagePutGate.entered;
  assert.equal(state.restoreStageKeys().length, 1);
  assert.equal(storage.restoreStageTrackingCount(), 1);
  storage.makeRestoreStagesDue();

  await runner.alarm();

  assert.equal(state.restoreStageKeys().length, 0);
  assert.equal(storage.restoreStageTrackingCount(), 0);
  stagePutGate.release();
  const response = await pending;
  assert.notEqual(response.status, 200);
});

test("OpenTofu runner Restore collector preserves a referenced pending stage when its authority record is missing", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const ledger = new FakeRestoreLedgerDatabase();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const controller = new AbortController();
  state.afterPut = (key) => {
    if (key.includes("/restore-operations/")) {
      controller.abort("lease lost after immutable upload");
    }
  };
  const runner = restoreRunner(state, storage, ledger);
  const response = await runner.fetch(
    restoreRequest("restore_missing_authority", source, controller.signal),
  );
  assert.notEqual(response.status, 200);
  const stage = storage.valueByPrefix("runner-restore-stage@v1:") as {
    stateRef: string;
    runId: string;
  };
  assert.ok(state.body(stage.stateRef));
  storage.deleteByPrefix("runner-restore-authority@v2:");
  ledger.referenceState(stage.stateRef, stage.runId);
  storage.makeRestoreStagesDue();

  await runner.alarm();

  assert.ok(state.body(stage.stateRef));
  assert.equal(storage.restoreStageTrackingCount(), 0);
  assert.equal(ledger.queryCount, 1);
});

test("OpenTofu runner Restore collector retains malformed pending authority when the ledger is unavailable", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const ledger = new FakeRestoreLedgerDatabase();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const controller = new AbortController();
  state.afterPut = (key) => {
    if (key.includes("/restore-operations/")) {
      controller.abort("lease lost after immutable upload");
    }
  };
  const runner = restoreRunner(state, storage, ledger);
  const response = await runner.fetch(
    restoreRequest("restore_malformed_authority", source, controller.signal),
  );
  assert.notEqual(response.status, 200);
  const stage = storage.valueByPrefix("runner-restore-stage@v1:") as {
    stateRef: string;
  };
  storage.replaceValueByPrefix("runner-restore-authority@v2:", {
    kind: "malformed",
  });
  ledger.unavailable = true;
  storage.makeRestoreStagesDue();

  await runner.alarm();

  assert.ok(state.body(stage.stateRef));
  assert.equal(storage.restoreStageTrackingCount(), 1);
  assert.ok((await storage.getAlarm()) !== null);
  assert.equal(ledger.queryCount, 1);
});

test("OpenTofu runner Restore collector checks the exact ledger reference for a stale pending claimant", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const ledger = new FakeRestoreLedgerDatabase();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const controller = new AbortController();
  state.afterPut = (key) => {
    if (key.includes("/restore-operations/")) {
      controller.abort("lease lost after immutable upload");
    }
  };
  const runner = restoreRunner(state, storage, ledger);
  const response = await runner.fetch(
    restoreRequest("restore_stale_authority", source, controller.signal),
  );
  assert.notEqual(response.status, 200);
  const stage = storage.valueByPrefix("runner-restore-stage@v1:") as {
    stateRef: string;
    runId: string;
  };
  const authority = storage.valueByPrefix(
    "runner-restore-authority@v2:",
  ) as {
    nextFence: number;
    claimant: Record<string, unknown>;
  };
  storage.replaceValueByPrefix("runner-restore-authority@v2:", {
    ...authority,
    nextFence: authority.nextFence + 1,
    claimant: {
      ...authority.claimant,
      fence: authority.nextFence + 1,
      operationId: "00000002-aaaaaaaaaaaaaaaaaaaaaaaa",
      runId: "restore_newer_claimant",
      stageStateRef: `${RESTORE_STATE_PREFIX}/restore-operations/00000002-aaaaaaaaaaaaaaaaaaaaaaaa.tfstate.enc`,
      phase: "abandoned",
    },
  });
  ledger.referenceState(stage.stateRef, stage.runId);
  storage.makeRestoreStagesDue();

  await runner.alarm();

  assert.ok(state.body(stage.stateRef));
  assert.equal(storage.restoreStageTrackingCount(), 0);
  assert.equal(ledger.queryCount, 1);
});

test("OpenTofu runner Restore collector HEAD-verifies an authority-uncertain stage after terminal ledger proof", async () => {
  const state = new HeadObservedR2Bucket();
  const storage = new FakeDoStorage();
  const ledger = new FakeRestoreLedgerDatabase();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const controller = new AbortController();
  state.afterPut = (key) => {
    if (key.includes("/restore-operations/")) {
      controller.abort("lease lost after immutable upload");
    }
  };
  const runner = restoreRunner(state, storage, ledger);
  const response = await runner.fetch(
    restoreRequest("restore_missing_authority_failed", source, controller.signal),
  );
  assert.notEqual(response.status, 200);
  const stage = storage.valueByPrefix("runner-restore-stage@v1:") as {
    stateRef: string;
    runId: string;
  };
  storage.deleteByPrefix("runner-restore-authority@v2:");
  ledger.setRunStatus(stage.runId, "failed");
  storage.makeRestoreStagesDue();
  state.resetEvents();

  await runner.alarm();

  assert.deepEqual(state.events, [
    `head:${stage.stateRef}`,
    `delete:${stage.stateRef}`,
    `head:${stage.stateRef}`,
  ]);
  assert.equal(ledger.queryCount, 1);
  assert.equal(storage.restoreStageTrackingCount(), 0);
});

test("OpenTofu runner Restore collector preserves exact StateVersion references and drops tracking", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const ledger = new FakeRestoreLedgerDatabase();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const runner = restoreRunner(state, storage, ledger);
  const response = await runner.fetch(
    restoreRequest("restore_referenced", source),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    state: { stateRef: string; runId: string };
  };
  ledger.referenceState(payload.state.stateRef, payload.state.runId);
  storage.makeRestoreStagesDue();

  await runner.alarm();

  assert.ok(state.body(payload.state.stateRef));
  assert.equal(storage.restoreStageTrackingCount(), 0);
});

test("OpenTofu runner Restore collector lets a core StateVersion commit race an acknowledged-stage alarm", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const ledger = new FakeRestoreLedgerDatabase();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const runner = restoreRunner(state, storage, ledger);
  const response = await runner.fetch(
    restoreRequest("restore_commit_race", source),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    state: { stateRef: string; runId: string };
  };
  ledger.setRunStatus(payload.state.runId, "running");
  storage.makeRestoreStagesDue();

  await runner.alarm();

  assert.ok(state.body(payload.state.stateRef));
  assert.equal(storage.restoreStageTrackingCount(), 1);
  ledger.referenceState(payload.state.stateRef, payload.state.runId);
  storage.makeRestoreStagesDue();
  await runner.alarm();
  assert.ok(state.body(payload.state.stateRef));
  assert.equal(storage.restoreStageTrackingCount(), 0);
});

test("OpenTofu runner Restore collector deletes an unreferenced failed Run ack", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const ledger = new FakeRestoreLedgerDatabase();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const runner = restoreRunner(state, storage, ledger);
  const response = await runner.fetch(
    restoreRequest("restore_failed_orphan", source),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    state: { stateRef: string; runId: string };
  };
  ledger.referenceState(payload.state.stateRef, "different_restore_run");
  ledger.setRunStatus(payload.state.runId, "failed");
  storage.makeRestoreStagesDue();

  await runner.alarm();

  assert.equal(state.body(payload.state.stateRef), undefined);
  assert.equal(storage.restoreStageTrackingCount(), 0);
});

test("OpenTofu runner Restore collector retains succeeded-missing and DB-unavailable acknowledgements", async () => {
  for (const scenario of ["succeeded", "unavailable"] as const) {
    const state = new HookedR2Bucket();
    const storage = new FakeDoStorage();
    const ledger = new FakeRestoreLedgerDatabase();
    const source = await seedRestoreSource(state, 1, STATE_BYTES);
    const runId = `restore_retained_${scenario}`;
    const runner = restoreRunner(state, storage, ledger);
    const response = await runner.fetch(restoreRequest(runId, source));
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      state: { stateRef: string; runId: string };
    };
    if (scenario === "unavailable") ledger.unavailable = true;
    else ledger.setRunStatus(payload.state.runId, "succeeded");
    storage.makeRestoreStagesDue();

    await runner.alarm();

    assert.ok(state.body(payload.state.stateRef), scenario);
    assert.equal(storage.restoreStageTrackingCount(), 1, scenario);
    assert.ok((await storage.getAlarm()) !== null, scenario);
  }
});

test("OpenTofu runner Restore collector bounds each alarm and resumes later stages", async () => {
  const state = new HookedR2Bucket();
  const storage = new FakeDoStorage();
  const ledger = new FakeRestoreLedgerDatabase();
  const source = await seedRestoreSource(state, 1, STATE_BYTES);
  const runner = restoreRunner(state, storage, ledger);
  const controllers = new Map<string, AbortController>();
  state.afterPut = (key, options) => {
    if (!key.includes("/restore-operations/")) return;
    const runId = options?.customMetadata?.["takosumi-run-id"];
    if (runId) controllers.get(runId)?.abort("lease lost after upload");
  };
  for (let index = 0; index < 17; index += 1) {
    const runId = `restore_collect_${String(index).padStart(2, "0")}`;
    ledger.setRunStatus(runId, "failed");
    const controller = new AbortController();
    controllers.set(runId, controller);
    const response = await runner.fetch(
      restoreRequest(runId, source, controller.signal),
    );
    assert.notEqual(response.status, 200);
  }
  assert.equal(state.restoreStageKeys().length, 17);
  assert.equal(storage.restoreStageTrackingCount(), 17);
  storage.makeRestoreStagesDue();

  await runner.alarm();

  assert.equal(state.restoreStageKeys().length, 1);
  assert.equal(storage.restoreStageTrackingCount(), 1);
  await runner.alarm();
  assert.equal(state.restoreStageKeys().length, 0);
  assert.equal(storage.restoreStageTrackingCount(), 0);
});

test("OpenTofu runner Durable Object uses the configured R2 bucket name in artifact refs", async () => {
  const r2 = new FakeR2Bucket();
  const runner = runnerWithContainer(
    r2,
    {
      async containerFetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === "/runs/plan_1") {
          return Response.json({
            status: "succeeded",
            exitCode: 0,
            planDigest: PLAN_DIGEST,
            planArtifact: {
              kind: "runner-local",
              ref: "runner-local://plan_1/tfplan",
              digest: PLAN_DIGEST,
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
    },
    { bucketName: "takosumi-proof-artifacts" },
  );

  const response = await runner.fetch(
    new Request("https://runner/runs/plan_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "plan_1",
        request: {},
      }),
    }),
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  const artifact = payload.planArtifact as Record<string, unknown>;
  assert.equal(
    artifact.ref,
    "r2://takosumi-proof-artifacts/opentofu-plan-runs/plan_1/tfplan",
  );
});

async function testStateBackendPrefix(ref: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ref),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `opentofu-state/backends/${hex}`;
}

function restoreTestCrypto(): StateArtifactCrypto {
  return StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
}

async function seedRestoreSource(
  state: FakeR2Bucket,
  generation: number,
  plaintext: Uint8Array,
): Promise<RestoreSourceDescriptor> {
  const stateRef = `${RESTORE_STATE_PREFIX}/${String(generation).padStart(
    8,
    "0",
  )}.tfstate.enc`;
  const sealed = await restoreTestCrypto().seal(plaintext);
  const createdByRunId = `apply_source_${generation}`;
  await state.put(stateRef, sealed.ciphertext, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: {
      "takosumi-run-id": createdByRunId,
      "takosumi-action": "apply",
      "takosumi-content-digest": sealed.contentDigest,
      "takosumi-ciphertext-length": String(sealed.ciphertextLength),
      "takosumi-encryption-format": sealed.format,
      "takosumi-generation": String(generation),
      "takosumi-workspace-id": "space_1",
      "takosumi-capsule-id": "inst_1",
      "takosumi-environment": "production",
      "takosumi-logical-target-state-ref": stateRef,
    },
  });
  return {
    stateVersionId: await testStateVersionIdForApplyRun(createdByRunId),
    workspaceId: "space_1",
    capsuleId: "inst_1",
    environment: "production",
    generation,
    stateRef,
    digest: sealed.contentDigest,
    createdByRunId,
  };
}

async function testStateVersionIdForApplyRun(
  applyRunId: string,
): Promise<string> {
  const digest = await stableJsonDigest({
    kind: "takosumi.state-version-id@v1",
    applyRunId,
  });
  return `state_${digest.slice("sha256:".length)}`;
}

function restoreRequest(
  runId: string,
  source: Readonly<Record<string, unknown>> | RestoreSourceDescriptor,
  signal?: AbortSignal,
  target: {
    readonly workspaceId?: string;
    readonly capsuleId?: string;
    readonly environment?: string;
    readonly generation?: number;
  } = {},
): Request {
  const workspaceId = target.workspaceId ?? "space_1";
  const capsuleId = target.capsuleId ?? "inst_1";
  const environment = target.environment ?? "production";
  const generation = target.generation ?? 2;
  const targetStateRef = `workspaces/${workspaceId}/capsules/${capsuleId}/environments/${environment}/state-versions/${String(
    generation,
  ).padStart(8, "0")}.tfstate.enc`;
  return new Request(`https://runner/runs/${encodeURIComponent(runId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "restore",
      runId,
      request: {
        stateScope: {
          workspaceId,
          subject: { kind: "capsule", id: capsuleId },
          environment,
          generation,
          stateRef: targetStateRef,
        },
        restoreState: source,
      },
    }),
    ...(signal ? { signal } : {}),
  });
}

function planRequestWithPriorState(
  runId: string,
  priorState: {
    readonly generation: number;
    readonly stateRef: string;
    readonly digest: string;
    readonly createdByRunId: string;
  },
): Request {
  return new Request(`https://runner/runs/${encodeURIComponent(runId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "plan",
      runId,
      request: {
        stateScope: {
          workspaceId: "space_1",
          subject: { kind: "capsule", id: "inst_1" },
          environment: "production",
          generation: 2,
          stateRef: RESTORE_TARGET_KEY,
          priorState,
        },
      },
    }),
  });
}

function restoreRunner(
  state: R2Bucket,
  storage = new FakeDoStorage(),
  controlDb?: D1Database,
): OpenTofuRunnerObject {
  return runnerWithContainer(
    new FakeR2Bucket(),
    {
      async containerFetch() {
        return Response.json(
          { error: "restore should not reach container" },
          { status: 500 },
        );
      },
    },
    {
      stateBucket: state,
      storage,
      ...(controlDb
        ? { env: { TAKOSUMI_CONTROL_DB: controlDb } }
        : {}),
    },
  );
}

function isRestoreStateWrite(key: string): boolean {
  return (
    key === RESTORE_TARGET_KEY || key.includes("/restore-operations/")
  );
}

function deferredGate(): {
  readonly entered: Promise<void>;
  readonly enter: () => void;
  readonly wait: Promise<void>;
  readonly release: () => void;
} {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    enter: () => enter(),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}

// At-rest encryption (M2) requires a secret-store passphrase; supply a fixed one
// so the runner DO seals/opens plan binaries + state with real AES-GCM in tests.
const TEST_PASSPHRASE = "takosumi-runner-container-test-passphrase-0123456789";

function runnerWithContainer(
  r2: R2Bucket,
  container: ContainerRequestFetcher,
  options: {
    readonly bucketName?: string;
    readonly stateBucket?: R2Bucket;
    readonly env?: Partial<CloudflareWorkerEnv>;
    readonly healthFetch?: (request: Request) => Promise<Response>;
    readonly startAndWaitForPorts?: (
      ports?: number | number[],
    ) => Promise<void>;
    readonly destroy?: () => Promise<void>;
    readonly stop?: () => Promise<void>;
    readonly storage?: FakeDoStorage;
  } = {},
): OpenTofuRunnerObject {
  const runner = new OpenTofuRunnerObject({
    storage: options.storage ?? new FakeDoStorage(),
  }, {
    TAKOSUMI_CONTROL_DB: {} as CloudflareWorkerEnv["TAKOSUMI_CONTROL_DB"],
    R2_ARTIFACTS: r2,
    ...(options.stateBucket ? { R2_STATE: options.stateBucket } : {}),
    ...(options.bucketName
      ? { R2_ARTIFACTS_BUCKET_NAME: options.bucketName }
      : {}),
    COORDINATION: {} as CloudflareWorkerEnv["COORDINATION"],
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
    ...(options.env ?? {}),
  } as CloudflareWorkerEnv);
  Object.defineProperty(runner, "containerFetch", {
    value(request: Request, _port?: number) {
      if (new URL(request.url).pathname === "/healthz") {
        return options.healthFetch
          ? options.healthFetch(request)
          : Response.json({ ok: true });
      }
      return container.containerFetch(request);
    },
  });
  if (options.startAndWaitForPorts) {
    Object.defineProperty(runner, "startAndWaitForPorts", {
      value: options.startAndWaitForPorts,
    });
  }
  if (options.destroy) {
    Object.defineProperty(runner, "destroy", {
      value: options.destroy,
    });
  }
  if (options.stop) {
    Object.defineProperty(runner, "stop", {
      value: options.stop,
    });
  }
  return runner;
}

async function seedEncryptedPlan(
  r2: FakeR2Bucket,
  runId: string,
): Promise<void> {
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const sealedPlan = await crypto.seal(PLAN_BYTES);
  await r2.put(
    `opentofu-plan-runs/${runId}/tfplan.enc`,
    sealedPlan.ciphertext,
    {
      httpMetadata: { contentType: "application/vnd.opentofu.plan" },
      customMetadata: {
        "takosumi-content-digest": sealedPlan.contentDigest,
      },
    },
  );
}

function mutationRequest(
  runId: string,
  action: "apply" | "destroy",
  requestFields: Readonly<Record<string, unknown>> = {},
): Request {
  return new Request(`https://runner/runs/${runId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action,
      runId,
      request: {
        ...requestFields,
        planArtifact: {
          kind: "object-storage",
          ref: `r2://takos-artifacts/opentofu-plan-runs/${runId}/tfplan`,
          digest: PLAN_DIGEST,
        },
      },
    }),
  });
}

function durableReleaseRequest(
  applyRunId: string,
  options: {
    readonly runtimeSecret?: string;
    readonly providerSecret?: string;
    readonly providerSource?: string;
    readonly providerConnectionId?: string;
    readonly runtimeProfileDigest?: string;
    readonly activationApplyRunId?: string;
    readonly workspaceId?: string;
    readonly capsuleId?: string;
    readonly sourceCommit?: string;
    readonly stateVersionId?: string;
    readonly commandIds?: readonly string[];
  } = {},
): Request {
  const releaseRunId = `release_${applyRunId}`;
  return new Request(`https://runner/runs/${releaseRunId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action: "release",
      runId: releaseRunId,
      request: {
        release: {
          commands: (options.commandIds ?? ["activate"]).map((id) => ({
            id,
            command: ["bun", "run", id],
          })),
        },
        activation: {
          applyRunId: options.activationApplyRunId ?? applyRunId,
          workspaceId: options.workspaceId ?? "workspace_release",
          capsuleId: options.capsuleId ?? "capsule_release",
          stateVersionId: options.stateVersionId ?? "state_release_1",
          sourceSnapshotId: "snapshot_release_1",
          sourceCommit:
            options.sourceCommit ??
            "0123456789abcdef0123456789abcdef01234567",
        },
        providerConfigurations: {
          format: "takosumi.provider-configurations@v1",
          providers: [],
        },
        ...(options.providerSecret
          ? {
              credentials: {
                env: { PROVIDER_RELEASE_TOKEN: options.providerSecret },
                manifest: {
                  bindings: [
                    {
                      providerSource:
                        options.providerSource ??
                        "registry.opentofu.org/example/release-provider",
                      connectionId:
                        options.providerConnectionId ?? "connection_release",
                      recipeId: "release-token",
                      authMode: "token",
                      envNames: ["PROVIDER_RELEASE_TOKEN"],
                      fileEnvNames: [],
                      requiredEnvGroups: [["PROVIDER_RELEASE_TOKEN"]],
                    },
                  ],
                },
              },
            }
          : {}),
        ...(options.runtimeSecret
          ? {
              runtimeSecrets: {
                contract: "takosumi.runner-runtime-secret-files/v1",
                profileDigest:
                  options.runtimeProfileDigest ?? `sha256:${"a".repeat(64)}`,
                files: [
                  {
                    path: "private/runtime-secrets.json",
                    mode: 0o600,
                    content: JSON.stringify({
                      ONLY_SECRET: options.runtimeSecret,
                    }),
                    envName: "TAKOS_RUNTIME_SECRETS_FILE",
                    secretNames: ["ONLY_SECRET"],
                  },
                ],
              },
            }
          : {}),
      },
    }),
  });
}

async function signedMutationToken(
  planRunId: string,
  options: {
    readonly action?: "apply" | "destroy";
    readonly jti: string;
    readonly nowMs?: number;
    readonly ttlSeconds?: number;
    readonly scopes?: readonly string[];
    readonly subject?: string;
    readonly runId?: string;
  },
): Promise<string> {
  const subject = options.subject ?? "principal_installer";
  const action = options.action ?? "apply";
  return (
    await createRunCredentialToken({
      secret: RUN_CREDENTIAL_SIGNING_SECRET,
      audience: "provider.example.v1",
      subject,
      workspaceId: "workspace_semantic",
      capsuleId: "capsule_semantic",
      runId: options.runId ?? `apply_${planRunId}`,
      installingPrincipalId: subject,
      connectionId: "connection_semantic",
      provider: RUN_CREDENTIAL_PROVIDER,
      phase: action,
      scopes: options.scopes ?? [`provider:${action}`],
      jti: options.jti,
      ...(options.ttlSeconds === undefined
        ? {}
        : { ttlSeconds: options.ttlSeconds }),
      ...(options.nowMs === undefined
        ? {}
        : { now: () => options.nowMs! }),
    })
  ).token;
}

function signedMutationRequest(
  planRunId: string,
  token: string,
  options: {
    readonly action?: "apply" | "destroy";
    readonly heartbeatAt?: number;
    readonly requestedAt?: string;
    readonly sourceRef?: string;
    readonly rawOutputRef?: string;
    readonly stateScope?: Readonly<Record<string, unknown>>;
    readonly runtimeInputValue?: string;
    readonly runtimeInputNames?: readonly string[];
  } = {},
): Request {
  const action = options.action ?? "apply";
  const operation = action === "destroy" ? "destroy" : "update";
  const planArtifact = {
    kind: "object-storage",
    ref: `r2://takos-artifacts/opentofu-plan-runs/${planRunId}/tfplan`,
    digest: PLAN_DIGEST,
  };
  return new Request(`https://runner/runs/${planRunId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run@v1",
      action,
      runId: planRunId,
      requestedAt: options.requestedAt ?? "2026-08-13T00:00:00.000Z",
      request: {
        applyRun: {
          id: `apply_${planRunId}`,
          planRunId,
          workspaceId: "workspace_semantic",
          capsuleId: "capsule_semantic",
          operation,
          runnerProfileId: "opentofu-default",
          status: "running",
          heartbeatAt: options.heartbeatAt ?? 1,
          runEnvironmentEvidenceDigest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          stateBackend: { kind: "runner-local" },
          stateLock: {
            status: "recorded",
            backendRef: "runner-local://workspace_semantic/capsule_semantic",
            acquiredAt: options.heartbeatAt ?? 1,
          },
          auditEvents: [],
          updatedAt: options.heartbeatAt ?? 1,
        },
        planRun: {
          id: planRunId,
          workspaceId: "workspace_semantic",
          capsuleId: "capsule_semantic",
          source: {
            kind: "git",
            url: "https://example.test/repository.git",
            ref:
              options.sourceRef ??
              "0123456789abcdef0123456789abcdef01234567",
            modulePath: ".",
          },
          sourceDigest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          operation,
          runnerProfileId: "opentofu-default",
          variablesDigest:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          requiredProviders: [RUN_CREDENTIAL_PROVIDER],
          status: "succeeded",
          policyDecisionDigest:
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          planDigest: PLAN_DIGEST,
          planArtifact,
          resolvedProviderBindingsDigest:
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          capsuleContext: {
            workspaceId: "workspace_semantic",
            capsuleId: "capsule_semantic",
            environment: "production",
          },
          auditEvents: [],
          updatedAt: options.heartbeatAt ?? 1,
        },
        planArtifact,
        ...(options.stateScope ? { stateScope: options.stateScope } : {}),
        ...(options.rawOutputRef ? { rawOutputRef: options.rawOutputRef } : {}),
        credentials: {
          env: { PROVIDER_RUN_TOKEN: token },
          ...(options.runtimeInputValue
            ? {
                runtimeInputs: [
                  {
                    variableName: "takosumi_runtime_inputs__probe",
                    names: options.runtimeInputNames ?? ["SIGNING_KEY"],
                    values: { SIGNING_KEY: options.runtimeInputValue },
                  },
                ],
              }
            : {}),
          manifest: {
            bindings: [
              {
                providerSource: RUN_CREDENTIAL_PROVIDER,
                connectionId: "connection_semantic",
                recipeId: "ephemeral-run-token",
                authMode: "run-token",
                envNames: ["PROVIDER_RUN_TOKEN"],
                fileEnvNames: [],
                requiredEnvGroups: [["PROVIDER_RUN_TOKEN"]],
              },
            ],
          },
        },
      },
    }),
  });
}

function rawOutputRefFor(planRunId: string): string {
  return `workspaces/workspace_semantic/capsules/capsule_semantic/runs/apply_${planRunId}/outputs.raw.json.enc`;
}

function capsuleStateScope(): {
  readonly workspaceId: string;
  readonly subject: { readonly kind: "capsule"; readonly id: string };
  readonly environment: string;
  readonly generation: number;
  readonly stateRef: string;
} {
  return {
    workspaceId: "workspace_semantic",
    subject: { kind: "capsule", id: "capsule_semantic" },
    environment: "production",
    generation: 1,
    stateRef:
      "workspaces/workspace_semantic/capsules/capsule_semantic/environments/production/state-versions/00000001.tfstate.enc",
  };
}

function assertNoSensitiveR2LogSerialization(
  calls: readonly unknown[][],
  failure: string,
): void {
  const logged = JSON.stringify(calls);
  const marker = failure.match(/arbitrary-marker-[a-z0-9-]+/iu)?.[0];
  assert.ok(marker);
  for (const forbidden of [
    marker,
    "Authorization",
    "Bearer",
    "cookie",
    "body",
    "stack",
  ]) {
    assert.equal(logged.includes(forbidden), false, `logged ${forbidden}`);
  }
}

function mutationSuccessContainer(
  planRunId: string,
  onProviderCall: () => void,
): ContainerRequestFetcher {
  return {
    async containerFetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT") return Response.json({ ok: true });
      if (request.method === "POST" && path === `/runs/${planRunId}`) {
        onProviderCall();
        return Response.json({ status: "succeeded", exitCode: 0 });
      }
      if (
        request.method === "GET" &&
        path === `/runs/${planRunId}/artifacts/tfstate`
      ) {
        return new Response(STATE_BYTES, {
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  };
}

function assertMutationIndeterminateResponse(
  text: string,
  action: "apply" | "destroy",
): void {
  const payload = JSON.parse(text) as Record<string, unknown>;
  assert.equal(payload.errorCode, "runner_mutation_indeterminate");
  assert.equal(payload.retryable, false);
  assert.equal(payload.outcome, "indeterminate");
  assert.deepEqual(payload.evidence, {
    kind: "runner_mutation_indeterminate",
    action,
    redispatchBlocked: true,
  });
}

function assertReleaseIndeterminateResponse(text: string): void {
  const payload = JSON.parse(text) as Record<string, unknown>;
  assert.equal(payload.errorCode, "runner_mutation_indeterminate");
  assert.equal(payload.phase, "release");
  assert.equal(payload.retryable, false);
  assert.equal(payload.outcome, "indeterminate");
  assert.deepEqual(payload.evidence, {
    kind: "runner_mutation_indeterminate",
    action: "release",
    redispatchBlocked: true,
  });
}

class FakeDoStorage {
  #values = new Map<string, unknown>();
  #alarm: number | null = null;
  #putCalls = 0;
  #transactionTail: Promise<void> = Promise.resolve();
  readonly #putFailuresBeforeCommit = new Set<number>();
  readonly #putFailuresAfterCommit = new Set<number>();
  #nextGetGate:
    | {
        readonly entered: () => void;
        readonly wait: Promise<void>;
      }
    | undefined;

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const gate = this.#nextGetGate;
    if (gate) {
      this.#nextGetGate = undefined;
      gate.entered();
      await gate.wait;
    }
    return this.#values.get(key) as T | undefined;
  }

  put<T = unknown>(key: string, value: T): Promise<void> {
    this.#putCalls += 1;
    if (this.#putFailuresBeforeCommit.delete(this.#putCalls)) {
      return Promise.reject(
        new Error("simulated Durable Object storage pre-commit failure"),
      );
    }
    this.#values.set(key, value);
    if (this.#putFailuresAfterCommit.delete(this.#putCalls)) {
      return Promise.reject(
        new Error("simulated Durable Object storage acknowledgement loss"),
      );
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.#values.delete(key));
  }

  list<T = unknown>(options: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly startAfter?: string;
  } = {}): Promise<Map<string, T>> {
    const entries = Array.from(this.#values.entries())
      .filter(
        ([key]) =>
          (!options.prefix || key.startsWith(options.prefix)) &&
          (!options.startAfter || key > options.startAfter),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options.limit);
    return Promise.resolve(new Map(entries) as Map<string, T>);
  }

  async transaction<T>(
    callback: (transaction: {
      get<V = unknown>(key: string): Promise<V | undefined>;
      put<V = unknown>(key: string, value: V): Promise<void>;
      delete(key: string): Promise<boolean>;
      getAlarm(): Promise<number | null>;
      setAlarm(scheduledTime: number | Date): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    const previous = this.#transactionTail;
    let release!: () => void;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const values = new Map(this.#values);
    let alarm = this.#alarm;
    let failAfterCommit = false;
    const transaction = {
      get: <V = unknown>(key: string): Promise<V | undefined> =>
        Promise.resolve(values.get(key) as V | undefined),
      put: <V = unknown>(key: string, value: V): Promise<void> => {
        this.#putCalls += 1;
        if (this.#putFailuresBeforeCommit.delete(this.#putCalls)) {
          return Promise.reject(
            new Error("simulated Durable Object storage pre-commit failure"),
          );
        }
        values.set(key, value);
        if (this.#putFailuresAfterCommit.delete(this.#putCalls)) {
          failAfterCommit = true;
        }
        return Promise.resolve();
      },
      delete: (key: string): Promise<boolean> =>
        Promise.resolve(values.delete(key)),
      getAlarm: (): Promise<number | null> => Promise.resolve(alarm),
      setAlarm: (scheduledTime: number | Date): Promise<void> => {
        alarm =
          scheduledTime instanceof Date
            ? scheduledTime.getTime()
            : scheduledTime;
        return Promise.resolve();
      },
    };
    try {
      const result = await callback(transaction);
      this.#values = values;
      this.#alarm = alarm;
      if (failAfterCommit) {
        throw new Error(
          "simulated Durable Object storage acknowledgement loss",
        );
      }
      return result;
    } finally {
      release();
    }
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.#alarm);
  }

  setAlarm(scheduledTime: number | Date): Promise<void> {
    this.#alarm =
      scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    return Promise.resolve();
  }

  entries(): readonly (readonly [string, unknown])[] {
    return Array.from(this.#values.entries());
  }

  valueByPrefix(prefix: string): unknown {
    const matches = Array.from(this.#values.entries()).filter(([key]) =>
      key.startsWith(prefix),
    );
    assert.equal(matches.length, 1);
    return matches[0]![1];
  }

  deleteByPrefix(prefix: string): void {
    const matches = Array.from(this.#values.keys()).filter((key) =>
      key.startsWith(prefix),
    );
    assert.equal(matches.length, 1);
    this.#values.delete(matches[0]!);
  }

  replaceValueByPrefix(prefix: string, value: unknown): void {
    const matches = Array.from(this.#values.keys()).filter((key) =>
      key.startsWith(prefix),
    );
    assert.equal(matches.length, 1);
    this.#values.set(matches[0]!, value);
  }

  makeRestoreStagesDue(now = Date.now()): void {
    for (const [key, raw] of this.#values) {
      if (
        !key.startsWith("runner-restore-stage@v1:") ||
        typeof raw !== "object" ||
        raw === null
      ) {
        continue;
      }
      this.#values.set(key, { ...raw, collectAfter: now - 1 });
    }
  }

  restoreStageTrackingCount(): number {
    return Array.from(this.#values.keys()).filter((key) =>
      key.startsWith("runner-restore-stage@v1:"),
    ).length;
  }

  failPutAfterCommit(call: number): void {
    this.#putFailuresAfterCommit.add(call);
  }

  failPutBeforeCommit(call: number): void {
    this.#putFailuresBeforeCommit.add(call);
  }

  deferNextGet(): {
    readonly entered: Promise<void>;
    readonly release: () => void;
  } {
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#nextGetGate = {
      entered: () => markEntered!(),
      wait,
    };
    return { entered, release: () => release!() };
  }
}

class FakeRestoreLedgerDatabase implements D1Database {
  readonly #stateVersions = new Map<string, string>();
  readonly #exactStateVersions = new Map<string, RestoreSourceDescriptor>();
  readonly #runStatuses = new Map<string, string>();
  unavailable = false;
  queryCount = 0;
  sourceQueryCount = 0;
  exactStateVersionCountOverride: unknown | undefined;

  referenceState(stateRef: string, runId: string): void {
    this.#stateVersions.set(stateRef, runId);
  }

  referenceExactStateVersion(source: RestoreSourceDescriptor): void {
    this.#exactStateVersions.set(source.stateVersionId, source);
  }

  setRunStatus(runId: string, status: string): void {
    this.#runStatuses.set(runId, status);
  }

  prepare(query: string): D1PreparedStatement {
    assert.match(query, /from state_versions/u);
    if (!query.includes("exact_state_version_count")) {
      assert.match(query, /from runs/u);
    }
    return new FakeRestoreLedgerStatement(this, query, []);
  }

  batch<T = unknown>(
    _statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    throw new Error("batch is not used by Restore stage collection");
  }

  result(query: string, values: readonly unknown[]): unknown {
    if (query.includes("exact_state_version_count")) {
      this.sourceQueryCount += 1;
      if (this.unavailable) throw new Error("simulated D1 unavailable");
      if (this.exactStateVersionCountOverride !== undefined) {
        return {
          exact_state_version_count: this.exactStateVersionCountOverride,
        };
      }
      const [
        stateVersionId,
        workspaceId,
        capsuleId,
        environment,
        generation,
        stateRef,
        digest,
        createdByRunId,
      ] = values;
      const exact =
        typeof stateVersionId === "string"
          ? this.#exactStateVersions.get(stateVersionId)
          : undefined;
      return {
        exact_state_version_count:
          exact?.workspaceId === workspaceId &&
            exact.capsuleId === capsuleId &&
            exact.environment === environment &&
            exact.generation === generation &&
            exact.stateRef === stateRef &&
            exact.digest === digest &&
            exact.createdByRunId === createdByRunId
            ? 1
            : 0,
      };
    }
    this.queryCount += 1;
    if (this.unavailable) throw new Error("simulated D1 unavailable");
    const [stateRef, createdByRunId, runId] = values;
    return {
      referenced:
        typeof stateRef === "string" &&
        typeof createdByRunId === "string" &&
        this.#stateVersions.get(stateRef) === createdByRunId
          ? 1
          : 0,
      run_status:
        typeof runId === "string"
          ? (this.#runStatuses.get(runId) ?? null)
          : null,
    };
  }
}

class FakeRestoreLedgerStatement implements D1PreparedStatement {
  constructor(
    readonly database: FakeRestoreLedgerDatabase,
    readonly query: string,
    readonly values: readonly unknown[],
  ) {}

  bind(...values: readonly unknown[]): D1PreparedStatement {
    return new FakeRestoreLedgerStatement(this.database, this.query, values);
  }

  first<T = unknown>(): Promise<T | null> {
    return Promise.resolve(this.database.result(this.query, this.values) as T);
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    throw new Error("all is not used by Restore stage collection");
  }

  run<T = unknown>(): Promise<D1Result<T>> {
    throw new Error("run is not used by Restore stage collection");
  }
}

class FakeR2Bucket implements R2Bucket {
  readonly #objects = new Map<string, FakeR2ObjectBody>();
  #nextEtag = 1;

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    const bytes = await bytesFromR2PutValue(value);
    const existing = this.#objects.get(key);
    if (
      options?.onlyIf?.etagMatches !== undefined &&
      existing?.etag !== options.onlyIf.etagMatches
    ) {
      return null;
    }
    if (
      options?.onlyIf?.etagDoesNotMatch !== undefined &&
      (options.onlyIf.etagDoesNotMatch === "*"
        ? existing !== undefined
        : existing?.etag === options.onlyIf.etagDoesNotMatch)
    ) {
      return null;
    }
    const object = new FakeR2ObjectBody(
      key,
      bytes,
      `etag-${this.#nextEtag++}`,
      options,
    );
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

  keys(): readonly string[] {
    return Array.from(this.#objects.keys());
  }
}

class HookedR2Bucket extends FakeR2Bucket {
  beforePut?: (key: string, options?: R2PutOptions) => void | Promise<void>;
  afterPut?: (key: string, options?: R2PutOptions) => void | Promise<void>;
  afterGet?: (key: string) => void | Promise<void>;
  afterHead?: (key: string, object: R2Object | null) => void | Promise<void>;
  restoreStatePutAttempts = 0;

  override async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    if (isRestoreStateWrite(key)) this.restoreStatePutAttempts += 1;
    await this.beforePut?.(key, options);
    const result = await super.put(key, value, options);
    await this.afterPut?.(key, options);
    return result;
  }

  override async get(key: string): Promise<R2ObjectBody | null> {
    const result = await super.get(key);
    await this.afterGet?.(key);
    return result;
  }

  override async head(key: string): Promise<R2Object | null> {
    const result = await super.head(key);
    await this.afterHead?.(key, result);
    return result;
  }

  restoreStageKeys(): readonly string[] {
    return this.keys().filter((key) => key.includes("/restore-operations/"));
  }
}

class HeadObservedR2Bucket extends HookedR2Bucket {
  readonly events: string[] = [];

  override async head(key: string): Promise<R2Object | null> {
    this.events.push(`head:${key}`);
    return await super.head(key);
  }

  override async delete(key: string): Promise<void> {
    this.events.push(`delete:${key}`);
    await super.delete(key);
  }

  resetEvents(): void {
    this.events.length = 0;
  }
}

class FlakyR2Bucket extends FakeR2Bucket {
  readonly #attempts = new Map<string, number>();

  constructor(
    readonly options: {
      readonly failKey: string;
      readonly failTimes: number;
      readonly message: string;
    },
  ) {
    super();
  }

  override async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    const attempts = (this.#attempts.get(key) ?? 0) + 1;
    this.#attempts.set(key, attempts);
    if (key === this.options.failKey && attempts <= this.options.failTimes) {
      throw new Error(this.options.message);
    }
    return await super.put(key, value, options);
  }

  putAttempts(key: string): number {
    return this.#attempts.get(key) ?? 0;
  }
}

class FailingR2Bucket extends FakeR2Bucket {
  constructor(readonly message: string) {
    super();
  }

  override put(): Promise<R2Object> {
    return Promise.reject(new Error(this.message));
  }
}

class FakeR2ObjectBody implements R2ObjectBody {
  readonly size: number;
  readonly uploaded = new Date("2026-06-03T00:00:00.000Z");
  readonly httpMetadata?: R2Object["httpMetadata"];
  readonly customMetadata?: Record<string, string>;

  constructor(
    readonly key: string,
    readonly bytes: Uint8Array,
    readonly etag: string,
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
