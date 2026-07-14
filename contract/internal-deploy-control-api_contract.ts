import type {
  ApplyRun,
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  DispatchStateScope,
  GetCapsuleResponse,
  Capsule,
  DeployControlErrorEnvelope,
  ListStateVersionsResponse,
  ListRunnerProfilesResponse,
  OutputResponse,
  PlanRun,
  PlanRunResponse,
  RunnerProfile,
  StateVersion,
} from "./internal-deploy-control-api.ts";
import type { PublicOutput } from "./outputs.ts";

const runnerProfile = {
  id: "opentofu-default",
  name: "OpenTofu default",
  substrate: "operator-managed",
  executorId: "opentofu.default",
  lifecycle: { state: "active" },
  availability: { state: "available" },
  tofuVersion: "1.10.0",
  stateBackend: {
    kind: "operator-managed",
    ref: "state://takosumi/opentofu-default",
    lock: {
      kind: "operator",
      ref: "lock://takosumi/opentofu-default",
    },
  },
  allowedProviders: ["*"],
  resourceLimits: {
    maxRunSeconds: 900,
    maxSourceArchiveBytes: 104857600,
    maxSourceDecompressedBytes: 1048576000,
    cpu: "1",
    memoryMb: 1024,
  },
  networkPolicy: { mode: "operator-managed" },
  secretExposurePolicy: {
    providerCredentials: "runner-only",
    tenantWorkerOperatorSecrets: "forbidden",
    redactLogs: true,
    blockSensitiveOutputs: true,
  },
  createdAt: 1716000000000,
} satisfies RunnerProfile;

// Workspace/Project-direct Capsule coordinates shared across the fixtures: one
// Capsule = generated root + tfstate + outputs, keyed (projectId, name,
// environment).
const workspaceId = "ws_personal";
const projectId = "prj_default";
const capsuleId = "cap_0123456789abcdef";
const environment = "production";
const stateVersionId = "sst_0123456789abcdef";

const source = {
  kind: "git",
  url: "https://git.example.test/example/notes.git",
  ref: "release",
  commit: "abc123",
  modulePath: "infra",
} as const;

const planRun = {
  id: "plan_0123456789abcdef",
  workspaceId,
  capsuleId,
  source,
  sourceDigest:
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  operation: "create",
  runnerProfileId: runnerProfile.id,
  variablesDigest:
    "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  requiredProviders: ["registry.example.com/acme/example"],
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
    ref: "artifact:plan_0123456789abcdef",
    digest:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    contentType: "application/vnd.opentofu.plan",
    createdAt: 1716000000002,
  },
  sourceCommit: "abc123",
  providerLockDigest:
    "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  summary: { add: 2, change: 0, destroy: 0 },
  // Capsule context the queue consumer reads to build the `stateScope` dispatch
  // field.
  capsuleContext: {
    workspaceId,
    capsuleId,
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

// Capsule-scoped state location threaded onto the run dispatch payload.
// An apply carries `base + 1` as the persist generation.
const dispatchStateScope = {
  workspaceId,
  subject: { kind: "capsule", id: capsuleId },
  environment,
  generation: 1,
  stateRef: "artifact:state_0123456789abcdef",
} satisfies DispatchStateScope;

// Capsule ledger record: Workspace/Project-direct, ISO timestamps,
// `status: "active"`. The App/Environment/InstallProfile lanes are retired.
const capsule = {
  id: capsuleId,
  workspaceId,
  projectId,
  name: "notes",
  slug: "notes",
  sourceId: "src_0123456789abcdef",
  installConfigId: "cfg_0123456789abcdef",
  environment,
  currentStateVersionId: stateVersionId,
  currentStateGeneration: 1,
  status: "active",
  createdAt: "2024-05-18T03:00:00.000Z",
  updatedAt: "2024-05-18T03:00:05.000Z",
} satisfies Capsule;

// One tfstate generation. Metadata-only; storage owns the encrypted bytes.
const stateVersion = {
  id: stateVersionId,
  workspaceId,
  capsuleId,
  environment,
  generation: 1,
  stateRef: "artifact:state_0123456789abcdef",
  digest:
    "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  createdByRunId: "apply_0123456789abcdef",
  createdAt: "2024-05-18T03:00:05.000Z",
} satisfies StateVersion;

const output = {
  id: "out_0123456789abcdef",
  workspaceId,
  capsuleId,
  stateGeneration: 1,
  publicOutputs: { endpoint: "https://notes.example.test" },
  workspaceOutputs: { endpoint: "https://notes.example.test" },
  outputDigest:
    "sha256:5555555555555555555555555555555555555555555555555555555555555555",
  createdAt: "2024-05-18T03:00:05.000Z",
} satisfies PublicOutput;

const applyRun = {
  id: "apply_0123456789abcdef",
  planRunId: planRun.id,
  workspaceId: planRun.workspaceId,
  capsuleId,
  stateVersionId: stateVersion.id,
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
    backendRef: "state://takosumi/opentofu-default",
    lockRef: "lock://takosumi/opentofu-default",
    acquiredAt: 1716000000003,
    releasedAt: 1716000000005,
  },
  outputId: "out_0123456789abcdef",
  auditEvents: [
    {
      id: "apply_0123456789abcdef:apply.completed:1716000000005",
      type: "apply.completed",
      at: 1716000000005,
      data: { stateVersionId: stateVersion.id },
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
    workspaceId,
    source,
    runnerProfileId: runnerProfile.id,
    variables: { account_id: "acct_123" },
    requiredProviders: ["registry.example.com/acme/example"],
  } satisfies CreatePlanRunRequest,

  planRunResponse: {
    planRun,
  } satisfies PlanRunResponse,

  // Run-dispatch state scope carrying a host-allocated opaque state reference.
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
    capsule,
  } satisfies ApplyRunResponse,

  getCapsuleResponse: {
    capsule,
  } satisfies GetCapsuleResponse,

  // StateVersion metadata recorded after a successful apply.
  stateVersion,

  listStateVersionsResponse: {
    stateVersions: [stateVersion],
  } satisfies ListStateVersionsResponse,

  outputResponse: {
    output,
  } satisfies OutputResponse,

  errorEnvelope: {
    error: {
      code: "failed_precondition",
      message: "expected planDigest does not match the PlanRun",
      requestId: "018f3c85-3f60-7110-8f15-7c0c17d5f9c8",
      details: { reason: "planDigest_mismatch" },
    },
  } satisfies DeployControlErrorEnvelope,
} as const;
