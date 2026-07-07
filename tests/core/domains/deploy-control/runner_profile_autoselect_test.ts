import { expect, test } from "bun:test";

import {
  OpenTofuDeploymentController,
  createDefaultRunnerProfiles,
  resolveEnabledRunnerProfiles,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  FIXTURE_CLOUDFLARE_PROVIDER,
  seedInstallationModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";

const VERCEL_PROVIDER = "registry.opentofu.org/vercel/vercel";

// Runner-profile auto-selection (the "bring your own key -> any provider runs
// without naming a profile" routing). When the caller pins no runnerProfileId,
// createPlanRun picks the enabled profile that admits the Capsule's required
// providers: prefer a specific match, fall back to the wildcard generic surface.
// Candidates are only the operator-enabled profiles, so this never widens the
// admitted provider surface.

const SOURCE = {
  kind: "git",
  url: "https://github.com/example/app.git",
  ref: "main",
} as const;

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

// The realized Cloud/self-host enabled surface: the Cloudflare preset + the
// wildcard generic-provider profile.
const ENABLED = resolveEnabledRunnerProfiles(
  createDefaultRunnerProfiles(1),
  "cloudflare-default,generic-opentofu-provider",
);

async function seededController() {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: () => 1,
    newId: deterministicIds(),
    runnerProfiles: ENABLED,
    defaultRunnerProfileId: "cloudflare-default",
  });
  const { installation } = await seedInstallationModel(store, {
    installationId: "inst_autoselect",
  });
  // Seed own-key connections for both a preset provider (cloudflare) and an
  // arbitrary generic-env provider (vercel) so binding resolution succeeds for
  // each routing case.
  await seedProviderConnections(store, installation, {
    requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER, VERCEL_PROVIDER],
  });
  await store.putInstallation({
    ...installation,
    currentDeploymentId: "dep_seed_autoselect",
    status: "active",
  });
  return { store, controller, installation };
}

test("auto-selects the wildcard generic profile for an arbitrary own-key provider", async () => {
  const { controller, installation } = await seededController();
  const { planRun } = await controller.createPlanRun({
    spaceId: installation.spaceId,
    installationId: installation.id,
    operation: "update",
    source: SOURCE,
    // The default cloudflare-default profile does not admit this provider; with
    // no pinned profile the run routes to the enabled wildcard surface so a
    // user's own key for any OpenTofu provider runs.
    requiredProviders: [VERCEL_PROVIDER],
  });
  expect(planRun.runnerProfileId).toBe("generic-opentofu-provider");
});

test("keeps the specific default profile when it already admits the providers", async () => {
  const { controller, installation } = await seededController();
  const { planRun } = await controller.createPlanRun({
    spaceId: installation.spaceId,
    installationId: installation.id,
    operation: "update",
    source: SOURCE,
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  });
  // cloudflare-default admits cloudflare -> no auto-switch to the wildcard.
  expect(planRun.runnerProfileId).toBe("cloudflare-default");
});

test("respects an explicitly pinned runner profile and never auto-switches", async () => {
  const { controller, installation } = await seededController();
  const { planRun } = await controller.createPlanRun({
    spaceId: installation.spaceId,
    installationId: installation.id,
    operation: "update",
    source: SOURCE,
    runnerProfileId: "cloudflare-default",
    requiredProviders: [VERCEL_PROVIDER],
  });
  // Explicit pin wins even for an arbitrary provider (policy may then block, but
  // the profile is not silently switched).
  expect(planRun.runnerProfileId).toBe("cloudflare-default");
});

test("skips a wildcard profile that denies the provider and picks an admitting one", async () => {
  const defaults = createDefaultRunnerProfiles(1);
  const cloudflare = resolveEnabledRunnerProfiles(defaults, "cloudflare-default")[0]!;
  const generic = defaults.find(
    (profile) => profile.id === "generic-opentofu-provider",
  )!;
  const enabledLabels = {
    ...(generic.labels ?? {}),
    "takosumi.com/profile-enabled": "true",
  };
  // Two enabled wildcard surfaces: the first denies vercel, the second admits it.
  const denyingWildcard = {
    ...generic,
    id: "wildcard-deny",
    deniedProviders: [VERCEL_PROVIDER],
    labels: enabledLabels,
  };
  const openWildcard = {
    ...generic,
    id: "wildcard-open",
    labels: enabledLabels,
  };
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: () => 1,
    newId: deterministicIds(),
    runnerProfiles: [cloudflare, denyingWildcard, openWildcard],
    defaultRunnerProfileId: "cloudflare-default",
  });
  const { installation } = await seedInstallationModel(store, {
    installationId: "inst_deny",
  });
  await seedProviderConnections(store, installation, {
    requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER, VERCEL_PROVIDER],
  });
  await store.putInstallation({
    ...installation,
    currentDeploymentId: "dep_seed_deny",
    status: "active",
  });
  const { planRun } = await controller.createPlanRun({
    spaceId: installation.spaceId,
    installationId: installation.id,
    operation: "update",
    source: SOURCE,
    requiredProviders: [VERCEL_PROVIDER],
  });
  // The earlier wildcard denies vercel, so auto-selection must skip it (its
  // deny-list overrides the "*" allow) and pick the admitting wildcard — never a
  // profile section-25 policy would then block.
  expect(planRun.runnerProfileId).toBe("wildcard-open");
});

test("falls back to keeping the default profile when no enabled wildcard exists", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = new OpenTofuDeploymentController({
    store,
    now: () => 1,
    newId: deterministicIds(),
    // Only the Cloudflare preset is enabled — no wildcard surface to route to.
    runnerProfiles: resolveEnabledRunnerProfiles(
      createDefaultRunnerProfiles(1),
      "cloudflare-default",
    ),
    defaultRunnerProfileId: "cloudflare-default",
  });
  const { installation } = await seedInstallationModel(store, {
    installationId: "inst_no_wildcard",
  });
  await seedProviderConnections(store, installation, {
    requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER, VERCEL_PROVIDER],
  });
  await store.putInstallation({
    ...installation,
    currentDeploymentId: "dep_seed_no_wildcard",
    status: "active",
  });
  const { planRun } = await controller.createPlanRun({
    spaceId: installation.spaceId,
    installationId: installation.id,
    operation: "update",
    source: SOURCE,
    requiredProviders: [VERCEL_PROVIDER],
  });
  // No enabled surface admits the provider: keep the default so policy blocks the
  // run exactly as before (the operator enabled no surface for it).
  expect(planRun.runnerProfileId).toBe("cloudflare-default");
});
