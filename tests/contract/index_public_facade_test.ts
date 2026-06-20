/**
 * Root `takosumi-contract` exports the public contract facade. Internal ledger
 * fields such as InstallConfig.installType and templateBinding remain available
 * from the explicit `takosumi-contract/installations` subpath only.
 */
import { expect, test } from "bun:test";

import type {
  Deployment as RootDeployment,
  InstallConfig as RootInstallConfig,
  Installation as RootInstallation,
  OutputSnapshot as RootOutputSnapshot,
} from "../../contract/index.ts";

test("root contract facade exports public Installation projections", async () => {
  const source = await Bun.file(
    new URL("../../contract/index.ts", import.meta.url),
  ).text();
  expect(source).not.toContain('export * from "../../contract/installations.ts"');
  const deployControlSource = await Bun.file(
    new URL("../../contract/deploy-control-api.ts", import.meta.url),
  ).text();
  expect(deployControlSource).not.toContain(
    'export * from "../../contract/installations.ts"',
  );
  expect(source).not.toContain("InstallationProviderEnvBindingSet");
  expect(deployControlSource).not.toContain(
    "InstallationProviderEnvBindingSet",
  );
  expect(source).not.toContain("ProviderEnvStatus");
  expect(deployControlSource).not.toContain("ProviderEnvStatus");
  expect(source).not.toContain('export * from "../../contract/api-surface.ts"');
  expect(source).not.toContain("INTERNAL_V1_PREFIX");

  const config = {
    id: "cfg_public",
    name: "public",
    sourceKind: "generic_capsule",
    trustLevel: "space",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
  } satisfies RootInstallConfig;
  expect("installType" in config).toBe(false);
  expect("templateBinding" in config).toBe(false);
  expect(config.sourceKind).toBe("generic_capsule");

  const installation = {
    id: "inst_public",
    spaceId: "space_public",
    name: "public",
    slug: "public",
    sourceId: "src_public",
    installConfigId: "cfg_public",
    environment: "prod",
    currentStateGeneration: 0,
    status: "pending",
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
  } satisfies RootInstallation;
  expect("installType" in installation).toBe(false);
  expect("currentOutputSnapshotId" in installation).toBe(false);

  const deployment = {
    id: "dep_public",
    spaceId: "space_public",
    installationId: "inst_public",
    environment: "prod",
    applyRunId: "run_apply",
    sourceSnapshotId: "snap_public",
    stateGeneration: 1,
    outputsPublic: { launch_url: "https://example.test" },
    status: "active",
    createdAt: "2026-06-08T00:00:00.000Z",
  } satisfies RootDeployment;
  expect("outputSnapshotId" in deployment).toBe(false);

  const outputSnapshot = {
    id: "osnap_public",
    spaceId: "space_public",
    installationId: "inst_public",
    stateGeneration: 1,
    publicOutputs: { launch_url: "https://example.test" },
    spaceOutputs: { endpoint: "https://internal.example.test" },
    outputDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-06-08T00:00:00.000Z",
  } satisfies RootOutputSnapshot;
  expect("rawOutputArtifactKey" in outputSnapshot).toBe(false);
});

const publicConfig = {
  id: "cfg_public",
  name: "public",
  sourceKind: "generic_capsule",
  trustLevel: "space",
  variableMapping: {},
  outputAllowlist: {},
  policy: {},
  createdAt: "2026-06-08T00:00:00.000Z",
  updatedAt: "2026-06-08T00:00:00.000Z",
} satisfies RootInstallConfig;

// @ts-expect-error root public InstallConfig must not expose the internal ledger discriminator.
({
  ...publicConfig,
  installType: "opentofu_module",
}) satisfies RootInstallConfig;

const publicInstallation = {
  id: "inst_public",
  spaceId: "space_public",
  name: "public",
  slug: "public",
  sourceId: "src_public",
  installConfigId: "cfg_public",
  environment: "prod",
  currentStateGeneration: 0,
  status: "pending",
  createdAt: "2026-06-08T00:00:00.000Z",
  updatedAt: "2026-06-08T00:00:00.000Z",
} satisfies RootInstallation;

// @ts-expect-error root public Installation must not expose the internal ledger discriminator.
({
  ...publicInstallation,
  installType: "opentofu_module",
}) satisfies RootInstallation;

// @ts-expect-error root public Installation must not expose raw OutputSnapshot pointers.
({
  ...publicInstallation,
  currentOutputSnapshotId: "osnap_secret_1",
}) satisfies RootInstallation;

const publicDeployment = {
  id: "dep_public",
  spaceId: "space_public",
  installationId: "inst_public",
  environment: "prod",
  applyRunId: "run_apply",
  sourceSnapshotId: "snap_public",
  stateGeneration: 1,
  outputsPublic: { launch_url: "https://example.test" },
  status: "active",
  createdAt: "2026-06-08T00:00:00.000Z",
} satisfies RootDeployment;

// @ts-expect-error root public Deployment must not expose raw OutputSnapshot pointers.
({
  ...publicDeployment,
  outputSnapshotId: "osnap_secret_1",
}) satisfies RootDeployment;

const publicOutputSnapshot = {
  id: "osnap_public",
  spaceId: "space_public",
  installationId: "inst_public",
  stateGeneration: 1,
  publicOutputs: { launch_url: "https://example.test" },
  spaceOutputs: { endpoint: "https://internal.example.test" },
  outputDigest: `sha256:${"a".repeat(64)}`,
  createdAt: "2026-06-08T00:00:00.000Z",
} satisfies RootOutputSnapshot;

// @ts-expect-error root public OutputSnapshot must not expose raw artifact handles.
({
  ...publicOutputSnapshot,
  rawOutputArtifactKey:
    "spaces/space_public/installations/inst_public/runs/run_apply/outputs.raw.json.enc",
}) satisfies RootOutputSnapshot;
