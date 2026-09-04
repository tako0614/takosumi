import { expect, test } from "bun:test";

import {
  assertRunExecutionEvidence,
  RUN_EXECUTION_EVIDENCE_CONTRACT,
  type RunExecutionEvidence,
} from "takosumi-contract/runs";
import type { ApplyRun } from "@takosumi/internal/deploy-control-api";
import { projectApplyRun } from "../../../../core/domains/deploy-control/projection_run.ts";

const digest = (char: string): `sha256:${string}` =>
  `sha256:${char.repeat(64)}` as `sha256:${string}`;

function evidence(
  over: Partial<RunExecutionEvidence> = {},
): RunExecutionEvidence {
  return {
    format: RUN_EXECUTION_EVIDENCE_CONTRACT,
    runId: "apply_1",
    planRunId: "plan_1",
    action: "apply",
    outcome: "committed",
    authority: {
      controllerArtifact: { digest: digest("a"), immutable: true },
      runnerArtifact: { digest: digest("f"), immutable: true },
      runnerProfileId: "opentofu-default",
      executorId: "opentofu.default",
      executorArtifact: { digest: digest("b"), immutable: true },
      providerArtifacts: [
        { source: "registry.opentofu.org/cloudflare/cloudflare", digest: digest("c"), attested: true },
      ],
    },
    plan: { digest: digest("d"), artifactDigest: digest("e") },
    commit: { stateVersionId: "state_1", outputId: "output_1" },
    receipt: { operationId: "apply_1", version: 1, fence: 1 },
    committedAt: "2026-09-04T00:00:00.000Z",
    ...over,
  };
}

function applyRun(over: Partial<ApplyRun> = {}): ApplyRun {
  return {
    id: "apply_1",
    planRunId: "plan_1",
    workspaceId: "workspace_1",
    operation: "create",
    runnerProfileId: "opentofu-default",
    status: "succeeded",
    expected: {
      planRunId: "plan_1",
      runnerProfileId: "opentofu-default",
      sourceDigest: digest("s"),
      variablesDigest: digest("v"),
      policyDecisionDigest: digest("p"),
      planDigest: digest("d"),
      planArtifactDigest: digest("e"),
    },
    stateBackend: { kind: "local", ref: "state" },
    stateLock: { status: "recorded", backendRef: "state" },
    executionEvidence: evidence(),
    auditEvents: [],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

test("RunExecutionEvidence is projected as value-free public evidence", () => {
  const run = projectApplyRun(applyRun());
  expect(run.executionEvidence).toEqual(evidence());
  expect(JSON.stringify(run)).not.toContain("token");
});

test("RunExecutionEvidence rejects unknown keys and unsorted provider artifacts", () => {
  expect(() =>
    assertRunExecutionEvidence({
      ...evidence(),
      secret: "must-not-cross-boundary",
    }),
  ).toThrow();
  expect(() =>
    assertRunExecutionEvidence({
      ...evidence(),
      authority: {
        ...evidence().authority,
        providerArtifacts: [
          {
            source: "z.example/provider",
            digest: digest("z"),
            attested: true,
          },
          {
            source: "a.example/provider",
            digest: digest("a"),
            attested: true,
          },
        ],
      },
    }),
  ).toThrow();
});

test("legacy ApplyRun rows remain readable without execution evidence", () => {
  const { executionEvidence: _ignored, ...legacy } = applyRun();
  expect(projectApplyRun(legacy)).not.toHaveProperty("executionEvidence");
});
