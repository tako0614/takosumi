import type {
  Deployment,
  DeploymentApplyRequest,
  DeploymentApplyResponse,
  DeploymentDryRunRequest,
  DeploymentDryRunResponse,
  Installation,
  InstallationApplyRequest,
  InstallationApplyResponse,
  InstallationDryRunRequest,
  InstallationDryRunResponse,
  InstallerErrorEnvelope,
  InstallPlan,
  RollbackRequest,
  RollbackResponse,
} from "./installer-api.ts";

const installPlan = {
  source: {
    kind: "git",
    url: "https://github.com/example/notes",
    ref: "v1.2.3",
    commit: "abc123",
  },
  repo: {
    id: "notes",
    name: "notes",
    version: "1.2.3",
    repositoryUrl: "https://github.com/example/notes",
  },
  selectedProfile: "default",
  requestedBindings: [{
    name: "db",
    serviceKind: "postgres",
    labels: { tier: "primary" },
    required: true,
  }],
  resolvedBindings: [{
    name: "db",
    selection: {
      name: "db",
      serviceKind: "postgres",
      labels: { tier: "primary" },
      required: true,
    },
    services: [{
      path: "data.primary.postgres",
      kind: "postgres",
      name: "primary-postgres",
      labels: { tier: "primary" },
      material: { dsn: "postgres://example.invalid/app" },
    }],
  }],
  publications: [{
    name: "web",
    kind: "http.endpoint",
    path: "apps.notes.web",
  }],
  changes: [{
    op: "create",
    subject: "notes",
    kind: "source",
  }],
  warnings: [],
} satisfies InstallPlan;

const installation = {
  id: "ins_0123456789abcdef",
  spaceId: "space_personal",
  appId: "notes",
  currentDeploymentId: "dep_0123456789abcdef",
  status: "ready",
  createdAt: 1716000000000,
} satisfies Installation;

const deployment = {
  id: "dep_0123456789abcdef",
  installationId: installation.id,
  source: installPlan.source,
  planSnapshotDigest:
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  planSnapshot: installPlan,
  bindingsSnapshot: installPlan.resolvedBindings,
  status: "succeeded",
  outputs: {
    public: {
      web: { url: "https://notes.example.test" },
    },
  },
  createdAt: 1716000000001,
} satisfies Deployment;

export const INSTALLER_API_CONTRACT_FIXTURES = {
  installationDryRunRequest: {
    spaceId: "space_personal",
    source: {
      kind: "git",
      url: "https://github.com/example/notes",
      ref: "v1.2.3",
    },
    profile: "default",
    bindings: installPlan.requestedBindings,
  } satisfies InstallationDryRunRequest,

  installationDryRunResponse: {
    source: installPlan.source,
    installPlan,
    planSnapshotDigest: deployment.planSnapshotDigest,
    changes: installPlan.changes,
    expected: {
      commit: "abc123",
      planSnapshotDigest: deployment.planSnapshotDigest,
    },
  } satisfies InstallationDryRunResponse,

  installationApplyRequest: {
    spaceId: "space_personal",
    source: {
      kind: "git",
      url: "https://github.com/example/notes",
      ref: "v1.2.3",
    },
    profile: "default",
    bindings: installPlan.requestedBindings,
    expected: {
      commit: "abc123",
      planSnapshotDigest: deployment.planSnapshotDigest,
    },
  } satisfies InstallationApplyRequest,

  installationApplyResponse: {
    installation,
    deployment,
  } satisfies InstallationApplyResponse,

  deploymentDryRunRequest: {
    source: {
      kind: "git",
      url: "https://github.com/example/notes",
      ref: "v1.2.4",
    },
    profile: "default",
    bindings: installPlan.requestedBindings,
  } satisfies DeploymentDryRunRequest,

  deploymentDryRunResponse: {
    source: {
      kind: "git",
      url: "https://github.com/example/notes",
      ref: "v1.2.4",
      commit: "def456",
    },
    installPlan,
    planSnapshotDigest: deployment.planSnapshotDigest,
    changes: installPlan.changes,
    expected: {
      currentDeploymentId: deployment.id,
      commit: "def456",
      planSnapshotDigest: deployment.planSnapshotDigest,
    },
  } satisfies DeploymentDryRunResponse,

  deploymentApplyRequest: {
    source: {
      kind: "git",
      url: "https://github.com/example/notes",
      ref: "v1.2.4",
    },
    profile: "default",
    bindings: installPlan.requestedBindings,
    expected: {
      currentDeploymentId: deployment.id,
      commit: "def456",
      planSnapshotDigest: deployment.planSnapshotDigest,
    },
  } satisfies DeploymentApplyRequest,

  deploymentApplyResponse: {
    deployment,
  } satisfies DeploymentApplyResponse,

  rollbackRequest: {
    deploymentId: deployment.id,
  } satisfies RollbackRequest,

  rollbackResponse: {
    installation,
    deployment,
    rollback: {
      rolledBackFrom: "dep_previous",
      rolledBackTo: deployment.id,
      scope: {
        pointer: "reverted",
        resourceMaterialization: "not-reapplied",
        workloadState: "not-reverted",
      },
    },
  } satisfies RollbackResponse,

  errorEnvelope: {
    error: {
      code: "failed_precondition",
      message: "expected planSnapshotDigest does not match reviewed plan",
      requestId: "018f3c85-3f60-7110-8f15-7c0c17d5f9c8",
      details: { reason: "planSnapshotDigest_mismatch" },
    },
  } satisfies InstallerErrorEnvelope,
} as const;
