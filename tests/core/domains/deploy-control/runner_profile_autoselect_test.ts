import { expect, test } from "bun:test";
import {
  OpenTofuDeploymentController,
  createDefaultRunnerProfiles,
  DEFAULT_OPENTOFU_RUNNER_PROFILE_ID,
  resolveEnabledRunnerProfiles,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  seedInstallationModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";

const VERCEL_PROVIDER = "registry.opentofu.org/vercel/vercel";
const SOURCE = {
  kind: "git",
  url: "https://github.com/example/app.git",
  ref: "main",
} as const;

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

async function seededController() {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: () => 1,
    newId: deterministicIds(),
    runnerProfiles: resolveEnabledRunnerProfiles(
      createDefaultRunnerProfiles(1),
      undefined,
    ),
    defaultRunnerProfileId: DEFAULT_OPENTOFU_RUNNER_PROFILE_ID,
  });
  const { installation } = await seedInstallationModel(store, {
    installationId: "inst_provider_neutral",
  });
  await seedProviderConnections(store, installation, {
    requiredProviders: [VERCEL_PROVIDER],
  });
  await store.putInstallation({
    ...installation,
    currentDeploymentId: "dep_seed",
    status: "active",
  });
  return { controller, installation };
}

test("an arbitrary provider uses the default runner without provider routing", async () => {
  const { controller, installation } = await seededController();
  const { planRun } = await controller.createPlanRun({
    spaceId: installation.spaceId,
    installationId: installation.id,
    operation: "update",
    source: SOURCE,
    requiredProviders: [VERCEL_PROVIDER],
  });
  expect(planRun.runnerProfileId).toBe(DEFAULT_OPENTOFU_RUNNER_PROFILE_ID);
});

test("an explicit capability profile remains explicit", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const defaultProfile = createDefaultRunnerProfiles(1)[0]!;
  const privateNetwork = {
    ...defaultProfile,
    id: "private-network",
    labels: {
      ...defaultProfile.labels,
      "takosumi.com/profile-enabled": "true",
    },
  };
  const controller = new OpenTofuDeploymentController({
    store,
    now: () => 1,
    newId: deterministicIds(),
    runnerProfiles: [defaultProfile, privateNetwork],
    defaultRunnerProfileId: DEFAULT_OPENTOFU_RUNNER_PROFILE_ID,
  });
  const { installation } = await seedInstallationModel(store, {
    installationId: "inst_private",
  });
  await seedProviderConnections(store, installation, {
    requiredProviders: [VERCEL_PROVIDER],
  });
  const { planRun } = await controller.createPlanRun({
    spaceId: installation.spaceId,
    installationId: installation.id,
    operation: "update",
    source: SOURCE,
    runnerProfileId: "private-network",
    requiredProviders: [VERCEL_PROVIDER],
  });
  expect(planRun.runnerProfileId).toBe("private-network");
});
