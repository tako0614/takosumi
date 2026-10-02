import { expect, test } from "bun:test";

import type { RunExecutionCommit } from "takosumi-contract/runs";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import {
  FIXTURE_CLOUDFLARE_PROVIDER,
  fixtureExecutionEvidence,
  seedCapsuleModel,
  seedProviderConnections,
} from "./model_fixture.ts";

function evidenceJob(
  executionEvidenceCommit: RunExecutionCommit,
) {
  return {
    applyRun: { id: "apply_fixture" },
    planRun: {
      id: "plan_fixture",
      planDigest: `sha256:${"a".repeat(64)}`,
      requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
    },
    planArtifact: { digest: `sha256:${"b".repeat(64)}` },
    runnerProfile: { id: "runner_fixture", executorId: "executor_fixture" },
    executionEvidenceCommit,
  };
}

test("persisted provider-failure evidence requires a state version", () => {
  const job = evidenceJob({ destroyed: true });

  expect(() =>
    fixtureExecutionEvidence(job, "destroy", {
      outcome: "provider_failed_state_persisted",
    })
  ).toThrow(/state version/i);
});

test("persisted provider-failure evidence retains the state ID and explicit commit override", () => {
  const job = evidenceJob({ destroyed: true, stateVersionId: "state_fixture" });

  expect(
    fixtureExecutionEvidence(job, "destroy", {
      outcome: "provider_failed_state_persisted",
    }).commit,
  ).toEqual({ stateVersionId: "state_fixture" });

  const override: RunExecutionCommit = { stateVersionId: "state_override" };
  expect(
    fixtureExecutionEvidence(job, "destroy", {
      outcome: "provider_failed_state_persisted",
      commit: override,
    }).commit,
  ).toEqual(override);

  const missingStateJob = evidenceJob({ destroyed: true });
  const deliberatelyInconsistentCommit: RunExecutionCommit = {
    destroyed: true,
  };
  expect(
    fixtureExecutionEvidence(missingStateJob, "destroy", {
      outcome: "provider_failed_state_persisted",
      commit: deliberatelyInconsistentCommit,
    }).commit,
  ).toEqual(deliberatelyInconsistentCommit);
});

test("seeded model defaults project config and keeps install config in its workspace", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_fixture_owner",
    installConfig: { workspaceId: "workspace_fixture_other" },
  });

  expect(seeded.project.projectJson).toEqual({});
  expect((await store.getProject(seeded.project.id))?.projectJson).toEqual({});
  expect(seeded.installConfig.workspaceId).toBe("workspace_fixture_owner");
});

test("seeded provider connections use recipe authority without a source transport kind", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_fixture_provider",
  });
  await seedProviderConnections(store, seeded.capsule, {
    requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
  });

  const connection = await store.getConnection(
    "conn_fixture_workspace_fixture_provider_cloudflare",
  );
  expect(connection?.kind).toBeUndefined();
  expect(connection?.credentialRecipe).toMatchObject({
    id: "generic-env",
    authMode: "env",
    secretPartition: "provider-credentials",
    declaredEnv: true,
  });
});
