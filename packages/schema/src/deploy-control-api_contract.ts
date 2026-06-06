import type {
  ApplyRun,
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  Deployment,
  GetInstallationResponse,
  Installation,
  DeployControlErrorEnvelope,
  ListDeploymentOutputsResponse,
  ListDeploymentsResponse,
  ListRunnerProfilesResponse,
  PlanRun,
  PlanRunResponse,
  RunnerProfile,
} from "./deploy-control-api.ts";

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
  credentialRefs: [{
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    ref: "secret://takosumi/cloudflare-default",
    required: true,
  }],
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
  cloudflareWorkersForPlatforms: {
    dispatchNamespace: "takosumi-tenants",
    dispatchWorkerBinding: "TAKOSUMI_TENANT_DISPATCH",
    outboundWorker: {
      serviceBinding: "TAKOSUMI_OUTBOUND_WORKER",
      enforceNetworkPolicy: true,
    },
    userWorkerBindings: {
      mode: "tenant-scoped-only",
      allowedBindingKinds: [
        "kv_namespace",
        "durable_object_namespace",
        "queue",
        "r2_bucket",
        "d1_database",
      ],
    },
  },
  secretExposurePolicy: {
    providerCredentials: "runner-only",
    tenantWorkerOperatorSecrets: "forbidden",
    redactLogs: true,
    blockSensitiveOutputs: true,
  },
  createdAt: 1716000000000,
} satisfies RunnerProfile;

const source = {
  kind: "git",
  url: "https://github.com/example/notes",
  ref: "main",
  commit: "abc123",
  modulePath: "infra",
} as const;

const planRun = {
  id: "plan_0123456789abcdef",
  spaceId: "space_personal",
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
    ref:
      "r2://takos-artifacts/opentofu-plan-runs/plan_0123456789abcdef/tfplan",
    digest:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    contentType: "application/vnd.opentofu.plan",
    createdAt: 1716000000002,
  },
  sourceCommit: "abc123",
  providerLockDigest:
    "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  summary: { add: 2, change: 0, destroy: 0 },
  auditEvents: [{
    id: "plan_0123456789abcdef:plan.completed:1716000000002",
    type: "plan.completed",
    at: 1716000000002,
    data: {
      planDigest:
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
  }],
  createdAt: 1716000000001,
  updatedAt: 1716000000002,
  finishedAt: 1716000000002,
} satisfies PlanRun;

const installation = {
  id: "ins_0123456789abcdef",
  spaceId: "space_personal",
  appId: "notes-infra",
  source,
  runnerProfileId: runnerProfile.id,
  currentDeploymentId: "dep_0123456789abcdef",
  status: "ready",
  createdAt: 1716000000003,
  updatedAt: 1716000000005,
} satisfies Installation;

const deployment = {
  id: "dep_0123456789abcdef",
  installationId: installation.id,
  planRunId: planRun.id,
  applyRunId: "apply_0123456789abcdef",
  source,
  runnerProfileId: runnerProfile.id,
  status: "succeeded",
  planDigest: planRun.planDigest,
  sourceCommit: planRun.sourceCommit,
  providerLockDigest: planRun.providerLockDigest,
  outputs: [{
    name: "launch_url",
    kind: "launch_url",
    value: "https://notes.example.test",
    sensitive: false,
  }],
  auditEvents: [{
    id: "deployment:deployment.recorded:1716000000005",
    type: "deployment.recorded",
    at: 1716000000005,
    data: { outputCount: 1 },
  }],
  createdAt: 1716000000004,
  completedAt: 1716000000005,
} satisfies Deployment;

const applyRun = {
  id: "apply_0123456789abcdef",
  planRunId: planRun.id,
  spaceId: planRun.spaceId,
  installationId: installation.id,
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
  outputs: deployment.outputs,
  auditEvents: [{
    id: "apply_0123456789abcdef:apply.completed:1716000000005",
    type: "apply.completed",
    at: 1716000000005,
    data: { deploymentId: deployment.id },
  }],
  createdAt: 1716000000003,
  updatedAt: 1716000000005,
  finishedAt: 1716000000005,
} satisfies ApplyRun;

export const DEPLOY_CONTROL_API_CONTRACT_FIXTURES = {
  listRunnerProfilesResponse: {
    runnerProfiles: [runnerProfile],
  } satisfies ListRunnerProfilesResponse,

  createPlanRunRequest: {
    spaceId: "space_personal",
    source,
    runnerProfileId: runnerProfile.id,
    variables: { account_id: "acct_123" },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  } satisfies CreatePlanRunRequest,

  planRunResponse: {
    planRun,
  } satisfies PlanRunResponse,

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

  listDeploymentsResponse: {
    deployments: [deployment],
  } satisfies ListDeploymentsResponse,

  listDeploymentOutputsResponse: {
    outputs: deployment.outputs,
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
