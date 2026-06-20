import type {
  ApplyRun,
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  Deployment,
  DeploymentOutput,
  DispatchStateScope,
  GetInstallationResponse,
  Installation,
  DeployControlErrorEnvelope,
  ListDeploymentOutputsResponse,
  ListDeploymentsResponse,
  ListRunnerProfilesResponse,
  PlanRun,
  PlanRunResponse,
  RunnerProfile,
  StateSnapshot,
} from "./internal-deploy-control-api.ts";

const runnerProfile = {
  id: "cloudflare-default",
  name: "Cloudflare default",
  substrate: "cloudflare-containers",
  tofuVersion: "1.10.0",
  stateBackend: {
    kind: "operator-managed",
    ref: "state://takosumi/cloudflare-default",
    lock: {
      kind: "operator",
      ref: "lock://takosumi/cloudflare-default",
    },
  },
  allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  credentialRefs: [
    {
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      ref: "secret://takosumi/cloudflare-default",
      required: true,
    },
  ],
  resourceLimits: {
    maxRunSeconds: 900,
    maxSourceArchiveBytes: 104857600,
    maxSourceDecompressedBytes: 1048576000,
    cpu: "1",
    memoryMb: 1024,
  },
  networkPolicy: {
    mode: "egress-allowlist",
    allowedHosts: ["registry.opentofu.org", "api.cloudflare.com"],
  },
  cloudflareContainer: {
    image: "ghcr.io/takosjp/takosumi-opentofu-runner:1",
    queueName: "takosumi-runs",
    durableObjectBinding: "RUNNER",
    workDir: "/workspace",
  },
  secretExposurePolicy: {
    providerCredentials: "runner-only",
    tenantWorkerOperatorSecrets: "forbidden",
    redactLogs: true,
    blockSensitiveOutputs: true,
  },
  createdAt: 1716000000000,
} satisfies RunnerProfile;

// Space-direct Installation coordinates shared across the fixtures: one
// Installation = Capsule + generated root + tfstate + outputs, keyed
// (spaceId, name, environment).
const spaceId = "space_personal";
const installationId = "ins_0123456789abcdef";
const environment = "production";
const outputSnapshotId = "snap_0123456789abcdef";

const source = {
  kind: "git",
  url: "https://github.com/example/notes",
  ref: "main",
  commit: "abc123",
  modulePath: "infra",
} as const;

// One projected, non-sensitive OpenTofu output. The runner envelope narrows
// `sensitive` to the literal `false`; sensitive outputs never enter the ledger.
const deploymentOutput = {
  name: "launch_url",
  kind: "launch_url",
  value: "https://notes.example.test",
  sensitive: false,
} satisfies DeploymentOutput;

const planRun = {
  id: "plan_0123456789abcdef",
  spaceId,
  installationId,
  source,
  sourceDigest:
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  operation: "create",
  runnerProfileId: runnerProfile.id,
  variablesDigest:
    "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  status: "succeeded",
  policy: {
    status: "passed",
    reasons: [],
    checkedAt: 1716000000001,
  },
  policyDecisionDigest:
    "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  planDigest:
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  planArtifact: {
    kind: "object-storage",
    ref: "r2://takos-artifacts/spaces/space_0123456789abcdef/installations/inst_0123456789abcdef/runs/plan_0123456789abcdef/plan.bin.enc",
    digest:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    contentType: "application/vnd.opentofu.plan",
    createdAt: 1716000000002,
  },
  sourceCommit: "abc123",
  providerLockDigest:
    "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  summary: { add: 2, change: 0, destroy: 0 },
  // Installation context the queue consumer reads to build the
  // `stateScope` dispatch field; renamed from the retired `environmentContext`.
  installationContext: {
    spaceId,
    installationId,
    environment,
  },
  auditEvents: [
    {
      id: "plan_0123456789abcdef:plan.completed:1716000000002",
      type: "plan.completed",
      at: 1716000000002,
      data: {
        planDigest:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    },
  ],
  createdAt: 1716000000001,
  updatedAt: 1716000000002,
  finishedAt: 1716000000002,
} satisfies PlanRun;

// Installation-scoped state location threaded onto the run dispatch payload
// An apply carries `base + 1` as the persist generation.
const dispatchStateScope = {
  spaceId,
  installationId,
  environment,
  generation: 1,
} satisfies DispatchStateScope;

// Installation ledger record: Space-direct, ISO timestamps,
// `status: "active"`. The App/Environment/InstallProfile lanes are retired.
const installation = {
  id: installationId,
  spaceId,
  name: "notes",
  slug: "notes",
  sourceId: "src_0123456789abcdef",
  installType: "opentofu_module",
  installConfigId: "cfg_0123456789abcdef",
  environment,
  currentDeploymentId: "dep_0123456789abcdef",
  currentStateGeneration: 1,
  status: "active",
  createdAt: "2024-05-18T03:00:00.000Z",
  updatedAt: "2024-05-18T03:00:05.000Z",
} satisfies Installation;

// One tfstate generation. Metadata-only; the encrypted bytes live in R2_STATE.
const stateSnapshot = {
  id: "sst_0123456789abcdef",
  spaceId,
  installationId,
  environment,
  generation: 1,
  objectKey:
    "spaces/space_personal/installations/ins_0123456789abcdef/envs/production/states/00000001.tfstate.enc",
  digest:
    "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  createdByRunId: "apply_0123456789abcdef",
  createdAt: "2024-05-18T03:00:05.000Z",
} satisfies StateSnapshot;

// Successful apply record: Space-direct, `outputsPublic` map,
// `status: "active"`, ISO `createdAt`. The legacy rich Deployment (source,
// runnerProfileId, outputs[], auditEvents) is gone.
const deployment = {
  id: "dep_0123456789abcdef",
  spaceId,
  installationId,
  environment,
  applyRunId: "apply_0123456789abcdef",
  sourceSnapshotId: "ssn_0123456789abcdef",
  stateGeneration: stateSnapshot.generation,
  outputSnapshotId,
  outputsPublic: { launch_url: deploymentOutput.value },
  status: "active",
  createdAt: "2024-05-18T03:00:05.000Z",
} satisfies Deployment;

const applyRun = {
  id: "apply_0123456789abcdef",
  planRunId: planRun.id,
  spaceId: planRun.spaceId,
  installationId,
  deploymentId: deployment.id,
  operation: planRun.operation,
  runnerProfileId: runnerProfile.id,
  status: "succeeded",
  expected: {
    planRunId: planRun.id,
    runnerProfileId: planRun.runnerProfileId,
    sourceDigest: planRun.sourceDigest,
    variablesDigest: planRun.variablesDigest,
    policyDecisionDigest: planRun.policyDecisionDigest,
    planDigest: planRun.planDigest,
    planArtifactDigest: planRun.planArtifact.digest,
    sourceCommit: planRun.sourceCommit,
    providerLockDigest: planRun.providerLockDigest,
  },
  stateBackend: runnerProfile.stateBackend,
  stateLock: {
    status: "recorded",
    backendRef: "state://takosumi/cloudflare-default",
    lockRef: "lock://takosumi/cloudflare-default",
    acquiredAt: 1716000000003,
    releasedAt: 1716000000005,
  },
  outputs: [deploymentOutput],
  auditEvents: [
    {
      id: "apply_0123456789abcdef:apply.completed:1716000000005",
      type: "apply.completed",
      at: 1716000000005,
      data: { deploymentId: deployment.id },
    },
  ],
  createdAt: 1716000000003,
  updatedAt: 1716000000005,
  finishedAt: 1716000000005,
} satisfies ApplyRun;

export const DEPLOY_CONTROL_API_CONTRACT_FIXTURES = {
  listRunnerProfilesResponse: {
    runnerProfiles: [runnerProfile],
  } satisfies ListRunnerProfilesResponse,

  createPlanRunRequest: {
    spaceId,
    source,
    runnerProfileId: runnerProfile.id,
    variables: { account_id: "acct_123" },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  } satisfies CreatePlanRunRequest,

  planRunResponse: {
    planRun,
  } satisfies PlanRunResponse,

  // Run-dispatch state scope pinned for the R2_STATE key derivation.
  dispatchStateScope,

  createApplyRunRequest: {
    planRunId: planRun.id,
    expected: {
      planRunId: planRun.id,
      runnerProfileId: planRun.runnerProfileId,
      sourceDigest: planRun.sourceDigest,
      variablesDigest: planRun.variablesDigest,
      policyDecisionDigest: planRun.policyDecisionDigest,
      planDigest: planRun.planDigest,
      planArtifactDigest: planRun.planArtifact.digest,
      sourceCommit: planRun.sourceCommit,
      providerLockDigest: planRun.providerLockDigest,
    },
  } satisfies CreateApplyRunRequest,

  applyRunResponse: {
    applyRun,
    installation,
    deployment,
  } satisfies ApplyRunResponse,

  getInstallationResponse: {
    installation,
  } satisfies GetInstallationResponse,

  // StateSnapshot metadata recorded after a successful apply.
  stateSnapshot,

  listDeploymentsResponse: {
    deployments: [deployment],
  } satisfies ListDeploymentsResponse,

  listDeploymentOutputsResponse: {
    outputs: [deploymentOutput],
  } satisfies ListDeploymentOutputsResponse,

  errorEnvelope: {
    error: {
      code: "failed_precondition",
      message: "expected planDigest does not match the PlanRun",
      requestId: "018f3c85-3f60-7110-8f15-7c0c17d5f9c8",
      details: { reason: "planDigest_mismatch" },
    },
  } satisfies DeployControlErrorEnvelope,
} as const;
