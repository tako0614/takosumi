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
  OpenTofuRunnerObject,
} from "../../../../worker/src/durable/OpenTofuRunnerObject.ts";
import {
  digestBytes,
  StateArtifactCrypto,
} from "../../../../worker/src/state_crypto.ts";

const PLAN_BYTES = new TextEncoder().encode("reviewed tfplan bytes");
const PLAN_DIGEST =
  "sha256:0fd9817656d95201f5c8073b9b4b4c2d5bfe8468b69e7bf771e5311b122a90e7";
const STATE_BYTES = new TextEncoder().encode('{"serial":1}');
const UPDATED_STATE_BYTES = new TextEncoder().encode('{"serial":2}');

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

test("OpenTofu runner Durable Object keeps only successful plan containers warm when keepalive is enabled", async () => {
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
  assert.deepEqual(calls, ["fetch POST /runs/plan_warm"]);
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

test("OpenTofu runner Durable Object does not echo relay failure details", async () => {
  const runner = runnerWithContainer(new FakeR2Bucket(), {
    containerFetch() {
      throw new Error("Authorization: Bearer relay-secret-token");
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

  assert.equal(response.status, 500);
  const text = await response.text();
  assert.equal(text.includes("relay-secret-token"), false);
  assert.equal(text.includes("OpenTofu runner artifact relay failed"), true);
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
  assert.match(text, /plan artifact object not found/);
});

test("OpenTofu runner Durable Object restores and persists operator-managed state", async () => {
  const calls: string[] = [];
  const r2 = new FakeR2Bucket();
  const stateBackendRef = "state://takosumi/cloudflare-default";
  const stateKey = `${await testStateBackendPrefix(stateBackendRef)}/installations/inst_1/terraform.tfstate`;
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
            installationId: "inst_1",
            spaceId: "space_1",
            runnerProfileId: "cloudflare-default",
            source: {
              kind: "git",
              url: "https://github.com/example/app.git",
              ref: "main",
            },
          },
          runnerProfile: {
            id: "cloudflare-default",
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
    "spaces/space_1/installations/inst_1/envs/production/states/00000001.tfstate.enc";
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
            spaceId: "space_1",
            installationId: "inst_1",
            environment: "production",
            generation: 2,
          },
          restoreState: {
            objectKey: sourceKey,
            digest: sealed.contentDigest,
          },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    state: { generation: number; objectKey: string; digest: string };
  };
  assert.equal(payload.state.generation, 2);
  assert.equal(
    payload.state.objectKey,
    "spaces/space_1/installations/inst_1/envs/production/states/00000002.tfstate.enc",
  );
  const restored = state.body(payload.state.objectKey);
  assert.ok(restored);
  assert.deepEqual(
    await crypto.open(restored, payload.state.digest),
    STATE_BYTES,
  );
  const current = state.body(
    "spaces/space_1/installations/inst_1/envs/production/states/current.json",
  );
  assert.ok(current);
  assert.equal(
    JSON.parse(new TextDecoder().decode(current)).objectKey,
    payload.state.objectKey,
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
  } = {},
): OpenTofuRunnerObject {
  const runner = new OpenTofuRunnerObject({ storage: new FakeDoStorage() }, {
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
