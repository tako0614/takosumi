import { expect, test } from "bun:test";

import {
  boundedRunnerFetch,
  cleanupOwnedContainer,
  parseProofArgs,
  requireLocalDockerEndpoint,
  runAndEmitAfterCleanup,
  assertUpdatePlanStateMetadataReceipt,
  assertRunnerImageDeclaresNonRootUser,
  assertRunnerContainerRunsAsNonRoot,
  assertStateVersionArtifactContinuity,
} from "../proofs/local-core-http-lifecycle.ts";

const IMAGE = `sha256:${"a".repeat(64)}`;

test("manual Core HTTP proof requires an explicit immutable local image ID", () => {
  expect(parseProofArgs(["--image", IMAGE])).toEqual({ image: IMAGE });
  expect(parseProofArgs(["--", "--image", IMAGE])).toEqual({ image: IMAGE });
  for (const args of [
    [],
    ["--image", "latest"],
    ["--image", "registry.example.test/runner@" + IMAGE],
    ["--image", `sha256:${"A".repeat(64)}`],
    ["--image", IMAGE, "--pull"],
  ]) {
    expect(() => parseProofArgs(args)).toThrow("usage");
  }
});

test("manual Core HTTP proof fails closed for remote or overridden Docker endpoints", () => {
  expect(requireLocalDockerEndpoint("unix:///var/run/docker.sock", {})).toBe(
    "/var/run/docker.sock",
  );
  for (const host of [
    "tcp://localhost:2375",
    "ssh://operator.example.test",
    "unix://relative.sock",
    "unix:///tmp/../remote.sock",
  ]) {
    expect(() => requireLocalDockerEndpoint(host, {})).toThrow();
  }
  expect(() => requireLocalDockerEndpoint("unix:///var/run/docker.sock", {
    DOCKER_HOST: "tcp://remote.example.test:2376",
  })).toThrow("overrides");
  expect(() => requireLocalDockerEndpoint("unix:///var/run/docker.sock", {
    DOCKER_CONTEXT: "remote",
  })).toThrow("overrides");
});

test("runner image USER rejects root identities even when a group is specified", () => {
  for (const user of ["root", "0"]) {
    expect(() => assertRunnerImageDeclaresNonRootUser(user)).toThrow("non-root user");
  }
  expect(() => assertRunnerImageDeclaresNonRootUser("bun")).not.toThrow();
});

test("runner image USER rejects root and UID-zero principals with group suffixes", () => {
  expect(() => assertRunnerImageDeclaresNonRootUser("root:1000")).toThrow("non-root user");
});

test("runner image USER rejects numeric UID-zero principals with group suffixes", () => {
  expect(() => assertRunnerImageDeclaresNonRootUser("0:1000")).toThrow("non-root user");
});

test("named runner USER aliases are checked inside the exact owned container before readiness", async () => {
  const calls: string[][] = [];
  await expect(assertRunnerContainerRunsAsNonRoot({
    containerId: "d".repeat(64),
    imageUser: "root-alias",
    runDocker: async (...args) => {
      calls.push(args);
      return "0";
    },
  })).rejects.toThrow("non-root UID");
  expect(calls).toEqual([["exec", "d".repeat(64), "id", "-u"]]);
  await expect(assertRunnerContainerRunsAsNonRoot({
    containerId: "e".repeat(64),
    imageUser: "bun",
    runDocker: async (...args) => {
      calls.push(args);
      return "1000";
    },
  })).resolves.toBeUndefined();
});

test("lost Docker acknowledgement cannot remove a foreign container with the chosen name", async () => {
  const id = "b".repeat(64);
  const calls: string[][] = [];
  const runDocker = async (...args: string[]) => {
    calls.push(args);
    if (args[0] === "ps") return id.slice(0, 12);
    if (args[0] === "container" && args[1] === "inspect") {
      return `${id}|${IMAGE}|another-owner|/proof-name`;
    }
    throw new Error("unexpected Docker mutation");
  };
  await expect(cleanupOwnedContainer({
    name: "proof-name",
    ownerNonce: "our-owner",
    image: IMAGE,
    runDocker,
  })).rejects.toThrow("another owner");
  expect(calls.some(([action]) => action === "rm")).toBe(false);
});

test("owned Docker cleanup removes the inspected immutable ID and confirms absence", async () => {
  const id = "c".repeat(64);
  const nonce = "our-owner";
  let present = true;
  const removals: string[] = [];
  const runDocker = async (...args: string[]) => {
    if (args[0] === "ps") return present ? id.slice(0, 12) : "";
    if (args[0] === "container" && args[1] === "inspect") {
      return `${id}|${IMAGE}|${nonce}|/proof-name`;
    }
    if (args[0] === "rm") {
      removals.push(args[2] ?? "");
      present = false;
      return id;
    }
    throw new Error("unexpected Docker command");
  };
  await cleanupOwnedContainer({ name: "proof-name", ownerNonce: nonce, image: IMAGE, runDocker });
  expect(removals).toEqual([id]);
  expect(present).toBe(false);
});

test("cleanup failure suppresses the passing marker", async () => {
  const markers: string[] = [];
  await expect(runAndEmitAfterCleanup(
    async () => ({ status: "passed" }),
    async () => { throw new Error("cleanup failed"); },
    (result) => { markers.push(result.status); },
  )).rejects.toThrow("cleanup failed");
  expect(markers).toEqual([]);
});

test("update Plan metadata receipt must match its exact Plan and canonical prior State", () => {
  const receipt = {
    runnerRunId: "apply_update_1",
    planDigest: `sha256:${"a".repeat(64)}`,
    lineage: "lineage-existing-state",
    serial: 4,
  };
  const planRunId = "plan_update_1";
  const priorStateBytes = new TextEncoder().encode(JSON.stringify({
    version: 4,
    lineage: "lineage-existing-state",
    serial: 4,
  }));
  const expected = {
    runnerRunId: receipt.runnerRunId,
    applyRunPlanRunId: planRunId,
    planRunId,
    planArtifact: {
      kind: "runner-local",
      ref: `runner-local://${planRunId}/tfplan`,
      digest: receipt.planDigest,
    },
    planDigest: receipt.planDigest,
    priorStateBytes,
    receipt,
  };

  expect(() => assertUpdatePlanStateMetadataReceipt(expected)).not.toThrow();
  expect(() => assertUpdatePlanStateMetadataReceipt({
    ...expected,
    receipt: { ...receipt, runnerRunId: "plan_update_1" },
  })).toThrow("update Plan metadata receipt did not match its canonical prior State");
  expect(() => assertUpdatePlanStateMetadataReceipt({
    ...expected,
    receipt: { ...receipt, planDigest: `sha256:${"b".repeat(64)}` },
  })).toThrow("update Plan metadata receipt did not match its canonical prior State");
  expect(() => assertUpdatePlanStateMetadataReceipt({
    ...expected,
    applyRunPlanRunId: "another_plan",
  })).toThrow("update Plan metadata receipt did not match its canonical prior State");
  expect(() => assertUpdatePlanStateMetadataReceipt({
    ...expected,
    planArtifact: { ...expected.planArtifact, ref: "runner-local://another_plan/tfplan" },
  })).toThrow("update Plan metadata receipt did not match its canonical prior State");
  expect(() => assertUpdatePlanStateMetadataReceipt({
    ...expected,
    planArtifact: { ...expected.planArtifact, digest: `sha256:${"d".repeat(64)}` },
  })).toThrow("update Plan metadata receipt did not match its canonical prior State");
  expect(() => assertUpdatePlanStateMetadataReceipt({
    ...expected,
    receipt: { ...receipt, lineage: "stale-lineage" },
  })).toThrow("update Plan metadata receipt did not match its canonical prior State");
  expect(() => assertUpdatePlanStateMetadataReceipt({
    ...expected,
    receipt: { ...receipt, serial: 3 },
  })).toThrow("update Plan metadata receipt did not match its canonical prior State");
});

test("proof StateVersion generations require exact ledger and stored artifact continuity", () => {
  const stateVersion = {
    id: "state_version_2",
    workspaceId: "ws_core_http_proof",
    capsuleId: "cap_core_http_proof",
    environment: "development",
    generation: 2,
    stateRef: "workspace/capsule/generation-2",
    digest: `sha256:${"b".repeat(64)}`,
    createdByRunId: "apply_second",
    createdAt: "2026-10-02T00:00:00.000Z",
  } as const;
  const stateBytes = new TextEncoder().encode(JSON.stringify({
    version: 4,
    lineage: "proof-lineage",
    serial: 2,
  }));
  const artifact = {
    stateRef: stateVersion.stateRef,
    workspaceId: stateVersion.workspaceId,
    environment: stateVersion.environment,
    generation: stateVersion.generation,
    createdByRunId: stateVersion.createdByRunId,
    stateDigest: stateVersion.digest,
    stateBytes,
    action: "apply" as const,
  };
  const expected = {
    listedStateVersion: {
      id: stateVersion.id,
      createdByRunId: "apply_second",
      generation: 2,
    },
    stateVersion,
    artifact,
    expectedRunId: "apply_second",
    expectedGeneration: 2,
    expectedAction: "apply" as const,
  };
  expect(() => assertStateVersionArtifactContinuity(expected)).not.toThrow();
  expect(() => assertStateVersionArtifactContinuity({
    ...expected,
    listedStateVersion: { ...expected.listedStateVersion, id: "different_ledger_id" },
  })).toThrow("public StateVersion ID differs from ledger ID");
  expect(() => assertStateVersionArtifactContinuity({
    ...expected,
    artifact: { ...artifact, stateDigest: `sha256:${"c".repeat(64)}` },
  })).toThrow("stored artifact digest differs from ledger");
});

test("bounded runner transport captures only successful metadata receipts with exact Run and Plan identity", async () => {
  const receipts: Array<{
    runnerRunId: string;
    planDigest: string;
    lineage: string;
    serial: number;
  }> = [];
  const planDigest = `sha256:${"c".repeat(64)}`;
  let calls = 0;
  const request = boundedRunnerFetch(
    "http://127.0.0.1:4321",
    (async () => ++calls === 1
      ? Response.json({ lineage: "lineage-existing-state", serial: 4 })
      : Response.json({ error: "saved Plan metadata rejected" }, { status: 409 })) as unknown as typeof fetch,
    undefined,
    (receipt) => { receipts.push(receipt); },
  );
  const planRunId = "plan_update_1";
  const applyRunId = "apply_update_1";

  await request(`http://127.0.0.1:4321/runs/${applyRunId}/plan-state-metadata`, {
    method: "POST",
    headers: { "x-takosumi-plan-digest": planDigest },
    body: new Uint8Array([1, 2, 3]),
  });
  await request("http://127.0.0.1:4321/runs/apply_initial_1/plan-state-metadata", {
    method: "POST",
    headers: { "x-takosumi-plan-digest": `sha256:${"d".repeat(64)}` },
    body: new Uint8Array([1]),
  });

  expect(receipts).toEqual([{
    runnerRunId: applyRunId,
    planDigest,
    lineage: "lineage-existing-state",
    serial: 4,
  }]);
  expect(receipts.find((receipt) => receipt.runnerRunId === planRunId)).toBeUndefined();
});

test("proof-scoped runner HTTP caps reject oversized artifacts and streamed replies", async () => {
  const artifactFetch = boundedRunnerFetch(
    "http://127.0.0.1:4321",
    (async () => new Response(new Uint8Array(), {
      headers: { "content-length": String(8 * 1024 * 1024 + 1) },
    })) as unknown as typeof fetch,
  );
  await expect(artifactFetch("http://127.0.0.1:4321/runs/r/artifacts/tfstate"))
    .rejects.toThrow("byte cap");

  const streamedFetch = boundedRunnerFetch(
    "http://127.0.0.1:4321",
    (async () => new Response(new Uint8Array(256 * 1024 + 1))) as unknown as typeof fetch,
  );
  await expect(streamedFetch("http://127.0.0.1:4321/runs/r"))
    .rejects.toThrow("byte cap");
  await expect(streamedFetch("http://external.example.test/runs/r"))
    .rejects.toThrow("external HTTP destination");
});
