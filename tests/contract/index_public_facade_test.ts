/**
 * Root `takosumi-contract` exports the public contract facade. Internal ledger
 * pointers remain available only from their explicit contract subpaths.
 */
import { expect, test } from "bun:test";

import type {
  InstallConfig as RootInstallConfig,
  Capsule as RootCapsule,
  Output as RootOutput,
  PublicStateVersion as RootStateVersion,
} from "../../contract/index.ts";

test("root contract facade exports public Capsule projections", async () => {
  const source = await Bun.file(
    new URL("../../contract/index.ts", import.meta.url),
  ).text();
  expect(source).not.toContain('export * from "./installations.ts"');
  const deployControlSource = await Bun.file(
    new URL("../../contract/deploy-control-api.ts", import.meta.url),
  ).text();
  expect(deployControlSource).not.toContain(
    'export * from "./installations.ts"',
  );
  expect(source).not.toContain('export * from "../../contract/api-surface.ts"');
  expect(source).not.toContain("INTERNAL_V1_PREFIX");
  expect(source).not.toContain("DeployRequest");
  expect(source).not.toContain("PublicDeployResponse");

  const config = {
    id: "cfg_public",
    name: "public",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
  } satisfies RootInstallConfig;
  expect("runnerId" in config).toBe(false);
  expect("internal" in config).toBe(false);

  const capsule = {
    id: "cap_public",
    workspaceId: "ws_public",
    projectId: "prj_public",
    name: "public",
    slug: "public",
    sourceId: "src_public",
    installConfigId: "cfg_public",
    environment: "prod",
    currentStateGeneration: 0,
    status: "pending",
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
  } satisfies RootCapsule;
  expect("currentOutputId" in capsule).toBe(false);
  expect("autoUpdateAttemptSourceSnapshotId" in capsule).toBe(false);

  const stateVersion = {
    id: "state_public",
    workspaceId: "ws_public",
    capsuleId: "cap_public",
    environment: "prod",
    generation: 1,
    createdByRunId: "run_apply",
    createdAt: "2026-06-08T00:00:00.000Z",
  } satisfies RootStateVersion;
  expect("stateRef" in stateVersion).toBe(false);
  expect("digest" in stateVersion).toBe(false);

  const output = {
    id: "osnap_public",
    workspaceId: "ws_public",
    capsuleId: "cap_public",
    stateGeneration: 1,
    publicOutputs: { launch_url: "https://example.test" },
    workspaceOutputs: { endpoint: "https://internal.example.test" },
    outputDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-06-08T00:00:00.000Z",
  } satisfies RootOutput;
  expect("rawArtifactRef" in output).toBe(false);
});

const publicConfig = {
  id: "cfg_public",
  name: "public",
  variableMapping: {},
  outputAllowlist: {},
  policy: {},
  createdAt: "2026-06-08T00:00:00.000Z",
  updatedAt: "2026-06-08T00:00:00.000Z",
} satisfies RootInstallConfig;

// @ts-expect-error root public InstallConfig must not expose runner selection.
({
  ...publicConfig,
  runnerId: "runner_private",
}) satisfies RootInstallConfig;

const publicCapsule = {
  id: "cap_public",
  workspaceId: "ws_public",
  projectId: "prj_public",
  name: "public",
  slug: "public",
  sourceId: "src_public",
  installConfigId: "cfg_public",
  environment: "prod",
  currentStateGeneration: 0,
  status: "pending",
  createdAt: "2026-06-08T00:00:00.000Z",
  updatedAt: "2026-06-08T00:00:00.000Z",
} satisfies RootCapsule;

// @ts-expect-error root public Capsule must not expose raw Output pointers.
({
  ...publicCapsule,
  currentOutputId: "osnap_secret_1",
}) satisfies RootCapsule;

const publicStateVersion = {
  id: "state_public",
  workspaceId: "ws_public",
  capsuleId: "cap_public",
  environment: "prod",
  generation: 1,
  createdByRunId: "run_apply",
  createdAt: "2026-06-08T00:00:00.000Z",
} satisfies RootStateVersion;

// @ts-expect-error root public StateVersion must not expose storage coordinates.
({
  ...publicStateVersion,
  stateRef: "workspaces/ws_public/capsules/cap_public/state.tfstate.enc",
}) satisfies RootStateVersion;

const publicOutput = {
  id: "osnap_public",
  workspaceId: "ws_public",
  capsuleId: "cap_public",
  stateGeneration: 1,
  publicOutputs: { launch_url: "https://example.test" },
  workspaceOutputs: { endpoint: "https://internal.example.test" },
  outputDigest: `sha256:${"a".repeat(64)}`,
  createdAt: "2026-06-08T00:00:00.000Z",
} satisfies RootOutput;

// @ts-expect-error root public Output must not expose raw artifact handles.
({
  ...publicOutput,
  rawArtifactRef:
    "workspaces/ws_public/capsules/cap_public/runs/run_apply/outputs.raw.json.enc",
}) satisfies RootOutput;
