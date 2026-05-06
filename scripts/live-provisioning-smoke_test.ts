import assert from "node:assert/strict";
import {
  loadProofFixture,
  manifestToProofFixture,
  runBundledFixtureProof,
  runFixtureProof,
  runLiveProof,
} from "./live-provisioning-smoke.ts";
import type { ProviderProofFixture } from "../packages/plugins/src/providers/proof.ts";

Deno.test("manifestToProofFixture maps bundled manifests to runtime desired state", async () => {
  const manifest = JSON.parse(
    await Deno.readTextFile("fixtures/live-provisioning/aws.shape-v1.json"),
  );
  const fixture = manifestToProofFixture(manifest, "aws.shape-v1.json");

  assert.equal(fixture.provider, "aws");
  assert.equal(fixture.desiredState.workloads.length, 1);
  assert.equal(fixture.desiredState.resources.length, 2);
  assert.equal(fixture.desiredState.routes.length, 1);
  assert.deepEqual(fixture.expectedDescriptors, [
    "object-store@v1:aws-s3:artifacts",
    "database-postgres@v1:aws-rds:db",
    "web-service@v1:aws-fargate:web",
    "custom-domain@v1:route53:primary",
  ]);
});

Deno.test("runBundledFixtureProof validates all credential-free provider fixtures", async () => {
  const report = await runBundledFixtureProof();

  assert.equal(report.status, "passed");
  assert.equal(report.executionMode, "fixture");
  assert.equal(report.live, false);
  assert.deepEqual(report.providers, [
    "aws",
    "gcp",
    "kubernetes",
    "cloudflare",
    "selfhosted",
  ]);
});

Deno.test("runFixtureProof materializes verifies and tears down expected descriptors", async () => {
  const fixture = await loadProofFixture(
    "fixtures/live-provisioning/cloudflare.shape-v1.json",
  );
  const report = await runFixtureProof(fixture);

  assert.equal(report.status, "passed");
  assert.equal(report.cleanup?.attempted, true);
  assert.equal(report.operations.length, fixture.expectedDescriptors.length);
});

Deno.test("runLiveProof posts to gateway and validates returned descriptors", async () => {
  const fixture = proofFixture();
  const calls: string[] = [];
  const report = await runLiveProof(fixture, { baseUrl: "https://gw.test" }, {
    fetch: (input, init) => {
      const path = new URL(String(input)).pathname.replace(/^\/+/, "");
      calls.push(path);
      const requestInit = init as { body?: BodyInit } | undefined;
      const body = requestInit?.body
        ? JSON.parse(String(requestInit.body))
        : {};
      if (path === "provider/materialize-desired-state") {
        return Promise.resolve(Response.json({
          result: {
            id: "plan_1",
            provider: "aws",
            desiredStateId: body.id,
            recordedAt: "2026-05-06T00:00:00.000Z",
            operations: [operation(body.id)],
          },
        }));
      }
      if (path === "provider/list-operations") {
        return Promise.resolve(Response.json({ result: [] }));
      }
      if (path === "provider/verify-desired-state") {
        return Promise.resolve(Response.json({ result: { ok: true } }));
      }
      return Promise.resolve(
        Response.json({ error: "not found" }, { status: 404 }),
      );
    },
  });

  assert.equal(report.status, "passed");
  assert.deepEqual(calls, [
    "provider/materialize-desired-state",
    "provider/list-operations",
    "provider/verify-desired-state",
  ]);
});

Deno.test("runLiveProof cleanup-only tears down and clears gateway operations", async () => {
  const fixture = proofFixture();
  const calls: string[] = [];
  const report = await runLiveProof(fixture, { baseUrl: "https://gw.test" }, {
    cleanupOnly: true,
    fetch: (input) => {
      const path = new URL(String(input)).pathname.replace(/^\/+/, "");
      calls.push(path);
      if (path === "provider/teardown-desired-state") {
        return Promise.resolve(Response.json({ result: { ok: true } }));
      }
      if (path === "provider/list-operations") {
        return Promise.resolve(
          Response.json({ result: [operation(fixture.desiredState.id)] }),
        );
      }
      if (path === "provider/clear-operations") {
        return Promise.resolve(Response.json({ result: undefined }));
      }
      return Promise.resolve(
        Response.json({ error: "not found" }, { status: 404 }),
      );
    },
  });

  assert.equal(report.status, "passed");
  assert.equal(report.cleanup?.attempted, true);
  assert.deepEqual(calls, [
    "provider/teardown-desired-state",
    "provider/list-operations",
    "provider/clear-operations",
  ]);
});

function proofFixture(): ProviderProofFixture {
  return {
    version: "takos.provider-proof/v1",
    provider: "aws",
    runId: "aws-live-proof-test",
    desiredState: {
      id: "desired_test",
      spaceId: "space_test",
      groupId: "group_test",
      activationId: "activation_test",
      appName: "proof-test",
      workloads: [{
        workloadId: "web",
        name: "web",
        kind: "web-service@v1",
        provider: "aws-fargate",
        spec: {},
      }],
      resources: [],
      routes: [],
    },
    expectedDescriptors: ["web-service@v1:aws-fargate:web"],
    verify: { gateway: true },
    cleanup: { enabled: true, strategy: "gateway" },
  };
}

function operation(desiredStateId: string) {
  return {
    id: "op_1",
    kind: "proof",
    provider: "aws",
    desiredStateId,
    command: ["proof"],
    details: { descriptor: "web-service@v1:aws-fargate:web" },
    recordedAt: "2026-05-06T00:00:00.000Z",
    execution: {
      status: "succeeded",
      code: 0,
      startedAt: "2026-05-06T00:00:00.000Z",
      completedAt: "2026-05-06T00:00:00.000Z",
    },
  };
}
