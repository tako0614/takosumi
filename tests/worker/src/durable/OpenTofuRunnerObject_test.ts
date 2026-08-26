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

const PLAN_BYTES = new TextEncoder().encode("reviewed tfplan bytes");
const PLAN_DIGEST =
  "sha256:0fd9817656d95201f5c8073b9b4b4c2d5bfe8468b69e7bf771e5311b122a90e7";
const STATE_BYTES = new TextEncoder().encode('{"serial":1}');
const UPDATED_STATE_BYTES = new TextEncoder().encode('{"serial":2}');
const RUN_CREDENTIAL_SIGNING_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef";
const RUN_CREDENTIAL_PROVIDER =
  "registry.opentofu.org/example/ephemeral";

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

test("OpenTofu runner Durable Object replays a value-free failed release outcome after cleanup", async () => {
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
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: TEST_PASSPHRASE,
  });
  const sourceKey =
    "workspaces/space_1/capsules/inst_1/environments/production/state-versions/00000001.tfstate.enc";
  const sealed = await crypto.seal(STATE_BYTES);
  await state.put(sourceKey, sealed.ciphertext, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { "takosumi-content-digest": sealed.contentDigest },
  });
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
          restoreState: {
            stateRef: sourceKey,
            digest: sealed.contentDigest,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    state: { generation: number; stateRef: string; digest: string };
  };
  assert.equal(payload.state.generation, 2);
  assert.equal(
    payload.state.stateRef,
    "workspaces/space_1/capsules/inst_1/environments/production/state-versions/00000002.tfstate.enc",
  );
  const restored = state.body(payload.state.stateRef);
  assert.ok(restored);
  assert.deepEqual(
    await crypto.open(restored, payload.state.digest),
    STATE_BYTES,
  );
  const current = state.body(
    "workspaces/space_1/capsules/inst_1/environments/production/state-versions/current.json",
  );
  assert.ok(current);
  assert.equal(
    JSON.parse(new TextDecoder().decode(current)).objectKey,
    payload.state.stateRef,
  );
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
  #putCalls = 0;
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

  entries(): readonly (readonly [string, unknown])[] {
    return Array.from(this.#values.entries());
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
  ): Promise<R2Object> {
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
  readonly etag = "etag";
  readonly uploaded = new Date("2026-06-03T00:00:00.000Z");
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
