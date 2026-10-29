/**
 * Small, deterministic data set for the portable dashboard browser check.
 *
 * The fixture is intentionally shaped like the public dashboard projections,
 * not like an internal store/database row. It proves that the browser can
 * authenticate, navigate, manage owned/shared apps, and render the canonical
 * launcher projection without deploying anything.
 */

import type {
  GitInstallPlanInterfaceChoice,
  GitInstallPlanInterfaceLinkRequest,
  GitInstallPlanInterfaceRequirement,
} from "../../../contract/install-plans.ts";

const CREATED_AT = "2026-08-01T00:00:00.000Z";

export const PORTABLE_SESSION_COOKIE = "takosumi_session=portable-e2e";

export const PORTABLE_EXPECTATIONS = {
  workspaceName: "Alpha Workspace",
  switchWorkspaceName: "Beta Workspace",
  duplicateWorkspaceHandle: "alpha-lab",
  appName: "Repository Office",
  appUrl: "https://apps.example.test/repository-office",
} as const;

/** Immutable commit used by the deterministic source fixtures. */
export const PORTABLE_SOURCE_COMMIT =
  "0123456789abcdef0123456789abcdef01234567";

/**
 * Provider destination fixtures are independent from repository metadata.
 * The first row is an operator-provided, workspace-bindable
 * managed ProviderConnection; the second is a user-owned direct credential.
 */
export const PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS = [
  {
    id: "pc_takosumi_cloud",
    provider: "cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    scope: "operator",
    status: "verified",
    displayName: "Takosumi hosted service",
    materialization: "managed",
    envNames: [],
    credentialRecipe: {
      id: "takosumi-cloud-run-credential",
      authMode: "run-issuance",
      secretPartition: "takosumi-cloud",
      runIssuance: {
        context: "capsule-run.v1",
        operatorConnection: "workspace-bindable",
        storedMaterial: "none",
        audience: "takosumi-cloud",
        scopes: ["cloudflare:account"],
      },
    },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    verifiedAt: CREATED_AT,
  },
  {
    id: "pc_cloudflare_direct",
    workspaceId: "ws_alpha",
    provider: "cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    scope: "workspace",
    status: "verified",
    displayName: "Cloudflare (direct)",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    verifiedAt: CREATED_AT,
  },
] as const;

export const PORTABLE_WORKSPACES = [
  {
    id: "ws_alpha",
    handle: "alpha",
    displayName: PORTABLE_EXPECTATIONS.workspaceName,
    type: "personal",
    ownerUserId: "sub_portable_e2e",
    createdAt: CREATED_AT,
    updatedAt: "2026-08-01T00:00:02.000Z",
  },
  {
    id: "ws_beta",
    handle: "beta",
    displayName: PORTABLE_EXPECTATIONS.switchWorkspaceName,
    type: "personal",
    ownerUserId: "sub_portable_e2e",
    createdAt: CREATED_AT,
    updatedAt: "2026-08-01T00:00:01.000Z",
  },
  {
    id: "ws_alpha_lab",
    handle: PORTABLE_EXPECTATIONS.duplicateWorkspaceHandle,
    displayName: PORTABLE_EXPECTATIONS.workspaceName,
    type: "personal",
    ownerUserId: "sub_portable_e2e",
    createdAt: CREATED_AT,
    updatedAt: "2026-08-01T00:00:00.500Z",
  },
] as const;

function capsule(workspaceId: string, id: string, name: string) {
  return {
    id,
    workspaceId,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/gu, "-"),
    sourceId: `src_${id}`,
    installConfigId: `cfg_${id}`,
    environment: "production",
    currentStateGeneration: 1,
    status: "active",
    freshness: "fresh",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

export const PORTABLE_CAPSULES = {
  ws_alpha: [
    capsule("ws_alpha", "cap_repository_office", PORTABLE_EXPECTATIONS.appName),
  ],
  ws_beta: [capsule("ws_beta", "cap_beta_office", "Beta Office")],
} as const;

/** Value-free app list returned by the workspace-less management API. */
export const PORTABLE_APPS = [
  {
    capsuleId: "cap_repository_office",
    name: PORTABLE_EXPECTATIONS.appName,
    displayName: PORTABLE_EXPECTATIONS.appName,
    role: "owner",
    ownerDisplayName: "Portable E2E",
    state: "installed",
    primaryAction: "open",
  },
  {
    capsuleId: "cap_beta_office",
    name: "Beta Office",
    displayName: "Beta Office",
    role: "member",
    ownerDisplayName: "Hanako Sato",
    state: "installed",
    primaryAction: "open",
  },
] as const;

export const PORTABLE_PERSONAL_CONNECTIONS = [
  {
    ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1],
    scope: "personal",
    ownerAccountId: "sub_portable_e2e",
    workspaceId: undefined,
  },
  PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[0],
] as const;

export function portableUsageResponse() {
  return {
    usageEvents: [
      {
        id: "use_rated",
        payerAccountId: "sub_portable_e2e",
        capsuleId: "cap_repository_office",
        kind: "runner_minute",
        quantity: 3,
        usdMicros: 12_000,
        ratingStatus: "rated",
        source: "runner",
        idempotencyKey: "use_rated",
        createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      },
      {
        id: "use_unrated",
        payerAccountId: "sub_portable_e2e",
        capsuleId: "cap_repository_office",
        kind: "operation",
        quantity: 1,
        usdMicros: 0,
        ratingStatus: "unrated",
        source: "control",
        idempotencyKey: "use_unrated",
        createdAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
      },
    ],
  };
}

/** Owner-visible people for the primary app in sharing E2E fixtures. */
export const PORTABLE_APP_MEMBERS = {
  owner: {
    accountId: "sub_portable_e2e",
    displayName: "Portable E2E",
    email: "portable-e2e@example.test",
  },
  members: [
    {
      accountId: "tsub_hanako0123456789",
      displayName: "Hanako Sato",
      email: "hanako@example.test",
      status: "active",
    },
    {
      accountId: "tsub_kenta0123456789",
      displayName: "Kenta Ito",
      email: "kenta@example.test",
      status: "active",
    },
  ],
} as const;

export const PORTABLE_SHARED_APP_MEMBERS = {
  owner: {
    accountId: "tsub_hanako0123456789",
    displayName: "Hanako Sato",
  },
  members: [
    {
      accountId: "sub_portable_e2e",
      displayName: "Portable E2E",
      email: "portable-e2e@example.test",
      status: "active",
    },
  ],
} as const;

export function portableAppConnectionLabels(capsuleId: string) {
  const ownerAccountId = capsuleId === "cap_beta_office"
    ? "tsub_hanako0123456789"
    : "sub_portable_e2e";
  return {
    projection: "app-owner-connection-labels",
    ownerAccountId,
    connections: [
      {
        id: capsuleId === "cap_beta_office" ? "pc_hanako_cloudflare" : "pc_cloudflare_direct",
        displayName: "Cloudflare account",
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        scope: "personal",
        ownerAccountId,
      },
      ...(capsuleId === "cap_beta_office" ? [{
        id: "pc_hanako_cloudflare_alt",
        displayName: "Second Cloudflare account",
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        scope: "personal",
        ownerAccountId,
      }] : []),
      ...(capsuleId === "cap_beta_office" ? [{
        id: "pc_hanako_aws",
        displayName: "AWS account",
        providerSource: "registry.opentofu.org/hashicorp/aws",
        scope: "personal",
        ownerAccountId,
      }] : []),
      {
        id: "pc_takosumi_cloud",
        displayName: "Takosumi hosted service",
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        scope: "operator",
        operatorBindable: true,
      },
    ],
  };
}

function launcherInterface(
  workspaceId: string,
  capsuleId: string,
  title: string,
  url: string,
) {
  return {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "Interface",
    metadata: {
      id: `if_${capsuleId}`,
      workspaceId,
      name: "app.launcher",
      ownerRef: { kind: "Capsule", id: capsuleId },
      generation: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    spec: {
      type: "interface.ui.surface",
      version: "1",
      document: {
        launcher: true,
        display: { title, category: "productivity" },
      },
      inputs: {
        url: {
          source: "capsule_output",
          capsuleId,
          outputName: "url",
        },
      },
      access: { visibility: "workspace" },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 1,
      resolvedRevision: 1,
      resolvedInputs: { url },
    },
  };
}

export const PORTABLE_UI_SURFACES = {
  ws_alpha: [
    launcherInterface(
      "ws_alpha",
      "cap_repository_office",
      PORTABLE_EXPECTATIONS.appName,
      PORTABLE_EXPECTATIONS.appUrl,
    ),
  ],
  ws_beta: [
    launcherInterface(
      "ws_beta",
      "cap_beta_office",
      "Beta Office",
      "https://apps.example.test/beta-office",
    ),
  ],
} as const;

/** The authority guard every fixture Capsule read carries. */
export const PORTABLE_AUTHORITY_GUARD = `sha256:${"a".repeat(64)}`;

type PortableCapsule = (typeof PORTABLE_CAPSULES)[keyof typeof PORTABLE_CAPSULES][number];

/** Every fixture Capsule, across Workspaces. */
export function portableCapsule(id: string): PortableCapsule | undefined {
  return Object.values(PORTABLE_CAPSULES)
    .flatMap((capsules) => [...capsules])
    .find((capsule) => capsule.id === id);
}

/** The applied install of one fixture Capsule. */
export function portableCapsuleRuns(capsule: PortableCapsule) {
  return [
    {
      id: `run_install_apply_${capsule.id}`,
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      type: "apply",
      status: "succeeded",
      createdBy: "portable-e2e",
      createdAt: CREATED_AT,
      finishedAt: CREATED_AT,
    },
  ];
}

/**
 * The control plane's view of one fixture Capsule
 * (`GET /api/v1/capsules/:id/app`): installed, its launcher as the one
 * screen, nothing in progress, and a seven-day uninstall grace period.
 */
export function portableCapsuleApp(capsule: PortableCapsule) {
  const launcher = (PORTABLE_UI_SURFACES[capsule.workspaceId as keyof typeof PORTABLE_UI_SURFACES] ?? [])
    .find((item) => item.metadata.ownerRef.id === capsule.id);
  const latestRun = portableCapsuleRuns(capsule)[0]!;
  return {
    kind: "takosumi.capsule-app@v1",
    capsuleId: capsule.id,
    workspaceId: capsule.workspaceId,
    projectId: `prj_${capsule.workspaceId}`,
    name: capsule.name,
    environment: capsule.environment,
    status: capsule.status,
    applied: true,
    state: "installed",
    primaryAction: launcher ? "open" : "view_resources",
    problems: [],
    links: { uses: [], usedBy: [] },
    screens: launcher
      ? [{
          interfaceId: launcher.metadata.id,
          name: launcher.metadata.name,
          title: launcher.spec.document.display.title,
          category: launcher.spec.document.display.category,
          url: launcher.status.resolvedInputs.url,
        }]
      : [],
    version: { updateAvailable: false, stale: false, autoUpdate: false },
    progress: { revisionPreparing: false },
    latestRun: {
      id: latestRun.id,
      type: latestRun.type,
      status: latestRun.status,
      createdAt: latestRun.createdAt,
      finishedAt: latestRun.finishedAt,
    },
    uninstall: { mode: "scheduled", graceDays: 7, impact: { usedBy: [] } },
    observedAt: CREATED_AT,
  };
}

export function workspacesResponse() {
  return {
    workspaces: PORTABLE_WORKSPACES,
    total: PORTABLE_WORKSPACES.length,
    returned: PORTABLE_WORKSPACES.length,
    limit: 50,
    truncated: false,
  };
}

// --- Install attempts (TASK-0115 Phase 3b) ----------------------------------
//
// A deterministic stand-in for the install-plan coordinator's attempt routes:
// POST /install-plans (mode "attempt") and its legacy
// /workspaces/:id/install-plans alias, GET ?open=1, GET/PATCH/DELETE
// /install-plans/:id and POST /install-plans/:id/reconcile. It follows
// the public contract shapes (contract/install-plans.ts) and keeps no setting
// value: a confirming answer's values are only checked for presence.

type AttemptPhase =
  | "syncing_source"
  | "compiling_install"
  | "analyzing_compatibility"
  | "awaiting_input"
  | "creating_capsule"
  | "planning"
  | "reviewable"
  | "failed"
  | "discarded";

export interface InstallAttemptFixtureConnection {
  readonly id: string;
  readonly providerSource: string;
  readonly displayName?: string;
  readonly status: string;
  readonly scope: string;
  readonly workspaceId?: string;
}

export interface InstallAttemptFixtureRequirement {
  readonly provider: string;
  readonly moduleLocalName: string;
  readonly childAlias?: string;
}

export interface InstallAttemptFixtureVariable {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "json" | "unknown";
  readonly required: boolean;
  readonly sensitive: boolean;
  readonly advanced?: boolean;
  readonly label?: { readonly ja: string; readonly en: string };
  readonly description?: { readonly ja: string; readonly en: string };
  readonly placeholder?: string;
  readonly defaultValue?: unknown;
  readonly derivedDefault?: "capsule_name" | "workspace_scoped_capsule_name";
}

export interface InstallAttemptFixtureOptions {
  readonly workspaceId?: string;
  readonly createdBy?: string;
  readonly capsuleId?: string;
  readonly planRunId?: string;
  /** The Plan Run of the n-th attempt (1-based), when attempts must differ. */
  readonly planRunIdFor?: (sequence: number) => string;
  /** Scanned roots; more than one (without a proven hint) asks for a choice. */
  readonly modules?: readonly { readonly path: string; readonly providers: readonly string[] }[];
  readonly resources?: readonly { readonly type: string; readonly count?: number; readonly allowed: boolean }[];
  readonly requirements?: readonly InstallAttemptFixtureRequirement[];
  /** Declared app requirements; candidates are projected without any values. */
  readonly interfaces?: readonly Omit<GitInstallPlanInterfaceRequirement, "choice" | "autoSelected">[];
  /** Live Provider Connections, read again for every projection. */
  readonly connections?: () => readonly InstallAttemptFixtureConnection[];
  readonly variables?: readonly InstallAttemptFixtureVariable[];
  /** App names already used in the Workspace. */
  readonly takenNames?: readonly string[];
  /** Reconcile rounds each working phase takes before it moves on. */
  readonly roundsPerPhase?: number;
  /** Fail the attempt when it reaches this phase. */
  readonly failAt?: { readonly phase: AttemptPhase; readonly code: string; readonly message?: string };
}

interface StoredAttempt {
  id: string;
  sequence: number;
  idempotencyKey: string;
  workspaceId: string;
  createdBy: string;
  source: { name: string; url: string; ref: string; path: string; authConnectionId?: string };
  capsule: { name: string; environment: string };
  options: { modulePath?: string; providerBindings?: readonly Record<string, unknown>[]; interfaceLinks?: readonly GitInstallPlanInterfaceLinkRequest[] };
  /** Test-only public values and value-free presence markers for the committed settings. */
  settings?: readonly { name: string; type: InstallAttemptFixtureVariable["type"]; required: boolean; sensitive: boolean; set: boolean; value?: unknown }[];
  phase: AttemptPhase;
  awaitingInput?: "module" | "inputs";
  generation: number;
  rounds: number;
  capsuleId?: string;
  planRunId?: string;
  diagnostic?: { code: string; message: string };
  invalidated?: "install_attempt_expired" | "workspace_management_changed";
  createdAt: string;
  updatedAt: string;
}

export interface InstallAttemptFixtureRequest {
  readonly method: string;
  readonly path: string;
  readonly search?: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string | null;
}

export interface InstallAttemptFixtureResponse {
  readonly status: number;
  readonly json: unknown;
}

const ATTEMPT_CREATED_AT = "2026-10-28T00:00:00.000Z";

function attemptError(status: number, code: string, message: string, reason?: string): InstallAttemptFixtureResponse {
  return { status, json: { error: { code, message, ...(reason ? { details: { reason } } : {}) } } };
}

function proposedAttemptName(url: string): string {
  const last = url.replace(/[?#].*$/u, "").replace(/\/+$/u, "").replace(/\.git$/u, "")
    .split(/[/:]/u).filter(Boolean).at(-1) ?? "";
  return last.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 63) || "app";
}

function offerable(connection: InstallAttemptFixtureConnection, provider: string, workspaceId: string): boolean {
  if (connection.providerSource !== provider || connection.status !== "verified") return false;
  return connection.scope === "operator" ||
    (connection.scope === "workspace" && (connection.workspaceId === undefined || connection.workspaceId === workspaceId));
}

/** One scripted coordinator. Each test (or the fixture server) owns its own. */
export function createInstallAttemptFixture(options: InstallAttemptFixtureOptions = {}) {
  const workspaceId = options.workspaceId ?? "ws_alpha";
  const createdBy = options.createdBy ?? "sub_portable_e2e";
  const rounds = Math.max(1, options.roundsPerPhase ?? 1);
  const modules = options.modules ?? [{ path: ".", providers: (options.requirements ?? []).map((r) => r.provider) }];
  const attempts = new Map<string, StoredAttempt>();
  const log = {
    creates: [] as unknown[],
    answers: [] as unknown[],
    discards: [] as { readonly id: string; readonly expectedGeneration: unknown }[],
    reconciles: 0,
  };
  let sequence = 0;

  const requirementRows = (attempt: StoredAttempt) =>
    (options.requirements ?? []).map((requirement) => {
      const candidates = (options.connections?.() ?? [])
        .filter((connection) => offerable(connection, requirement.provider, attempt.workspaceId))
        .map((connection) => ({
          id: connection.id,
          displayName: connection.displayName || connection.id,
          status: connection.status,
          scope: connection.scope,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const answer = attempt.options.providerBindings?.find((binding) =>
        binding.provider === requirement.provider &&
        binding.moduleLocalName === requirement.moduleLocalName &&
        (binding.childAlias ?? undefined) === requirement.childAlias
      );
      const selected = typeof answer?.connectionId === "string"
        ? answer.connectionId
        : candidates.length === 1 ? candidates[0]!.id : undefined;
      return {
        provider: requirement.provider,
        moduleLocalName: requirement.moduleLocalName,
        ...(requirement.childAlias !== undefined
          ? { childAlias: requirement.childAlias, rootAlias: requirement.childAlias }
          : {}),
        candidates,
        ...(selected !== undefined ? { selectedConnectionId: selected } : {}),
        autoSelected: answer === undefined && selected !== undefined,
      };
    });

  const nameFacts = (attempt: StoredAttempt) => {
    const taken = new Set(options.takenNames ?? []);
    const conflict = taken.has(attempt.capsule.name);
    let proposed = attempt.capsule.name;
    for (let suffix = 2; taken.has(proposed); suffix += 1) proposed = `${attempt.capsule.name}-${suffix}`;
    return { current: attempt.capsule.name, proposed, conflict };
  };

  const interfaceRows = (attempt: StoredAttempt): readonly GitInstallPlanInterfaceRequirement[] =>
    (options.interfaces ?? []).map((requirement) => {
      const answer = attempt.options.interfaceLinks?.find((entry) => entry.requirementKey === requirement.requirementKey);
      const choice: GitInstallPlanInterfaceChoice | undefined = answer?.choice ?? (
        requirement.candidates.length === 0 ? { kind: "later" } :
        requirement.candidates.length === 1 ? { kind: "interface", interfaceId: requirement.candidates[0]!.id } : undefined
      );
      return {
        ...requirement,
        ...(choice ? { choice } : {}),
        autoSelected: answer === undefined && choice?.kind === "interface",
      };
    });

  const userAction = (attempt: StoredAttempt) => {
    if (attempt.invalidated) return { kind: "retry", code: attempt.invalidated, restart: true };
    switch (attempt.phase) {
      case "awaiting_input": {
        if (attempt.awaitingInput === "module") {
          return {
            kind: "choose_module",
            modules,
            ...(attempt.options.modulePath !== undefined ? { requested: attempt.options.modulePath } : {}),
          };
        }
        const connections = requirementRows(attempt);
        const interfaces = interfaceRows(attempt);
        const name = nameFacts(attempt);
        return {
          kind: "provide_inputs",
          modulePath: attempt.options.modulePath ?? modules[0]?.path ?? ".",
          resources: options.resources ?? [],
          connections,
          interfaces,
          variables: options.variables ?? [],
          name,
          missing: [
            ...(connections.every((row) => row.candidates.some((c) => c.id === row.selectedConnectionId)) ? [] : ["connections"]),
            ...(interfaces.every((row) => row.choice?.kind === "later" || row.candidates.some((candidate) => row.choice?.kind === "interface" && candidate.id === row.choice.interfaceId)) ? [] : ["interfaces"]),
            ...(name.conflict ? ["name"] : []),
          ],
        };
      }
      case "reviewable":
        return { kind: "review_run", planRunId: attempt.planRunId!, capsuleId: attempt.capsuleId! };
      case "failed":
        return { kind: "retry", code: attempt.diagnostic?.code ?? "install_plan_failed", restart: true };
      case "discarded":
        return { kind: "none" };
      default:
        return { kind: "wait", phase: attempt.phase };
    }
  };

  const reviewSummary = (attempt: StoredAttempt) => {
    if (attempt.phase !== "planning" && attempt.phase !== "reviewable") return undefined;
    if (!attempt.capsuleId || !attempt.planRunId) return undefined;
    const connections = requirementRows(attempt).flatMap((row) => {
      const connectionId = row.selectedConnectionId;
      if (!connectionId) return [];
      const candidate = row.candidates.find((entry) => entry.id === connectionId);
      return [{
        provider: row.provider,
        moduleLocalName: row.moduleLocalName,
        ...(row.childAlias !== undefined ? { childAlias: row.childAlias } : {}),
        ...(row.rootAlias !== undefined ? { rootAlias: row.rootAlias } : {}),
        connectionId,
        displayName: candidate?.displayName ?? connectionId,
        // Persisted provider bindings do not retain whether the person chose
        // this row or it was the only available candidate.
        autoSelected: null,
      }];
    });
    const interfaces = interfaceRows(attempt).flatMap((row) => row.choice ? [{
      requirementKey: row.requirementKey,
      choice: row.choice,
      autoSelected: row.autoSelected,
    }] : []);
    return {
      modulePath: attempt.options.modulePath ?? modules[0]?.path ?? ".",
      appName: attempt.capsule.name,
      environment: attempt.capsule.environment,
      connections,
      interfaces,
      settings: attempt.settings ?? [],
    };
  };

  const respond = (attempt: StoredAttempt, status = 200): InstallAttemptFixtureResponse => {
    const action = userAction(attempt);
    return {
      status,
      json: {
        installPlan: {
          id: attempt.id,
          workspaceId: attempt.workspaceId,
          createdBy: attempt.createdBy,
          operation: "install",
          mode: "attempt",
          requestDigest: `sha256:${"a".repeat(64)}`,
          source: attempt.source,
          capsule: attempt.capsule,
          options: attempt.options,
          ...(attempt.awaitingInput ? { awaitingInput: attempt.awaitingInput } : {}),
          ...(attempt.capsuleId ? { capsuleId: attempt.capsuleId } : {}),
          ...(attempt.planRunId ? { planRunId: attempt.planRunId } : {}),
          ...(attempt.diagnostic ? { diagnostic: attempt.diagnostic } : {}),
          phase: attempt.phase,
          generation: attempt.generation,
          createdAt: attempt.createdAt,
          updatedAt: attempt.updatedAt,
        },
        nextAction: action.kind === "wait" ? "reconcile" : action.kind === "review_run" ? "review_run" : "none",
        userAction: action,
        ...(attempt.invalidated ? { invalidated: attempt.invalidated } : {}),
        links: { self: `/api/v1/install-plans/${attempt.id}`, reconcile: `/api/v1/install-plans/${attempt.id}/reconcile` },
        ...(reviewSummary(attempt) ? { reviewSummary: reviewSummary(attempt) } : {}),
      },
    };
  };

  const move = (attempt: StoredAttempt, phase: AttemptPhase, awaitingInput?: "module" | "inputs") => {
    if (options.failAt?.phase === phase) {
      attempt.phase = "failed";
      attempt.diagnostic = { code: options.failAt.code, message: options.failAt.message ?? "The install attempt failed." };
      delete attempt.awaitingInput;
    } else {
      attempt.phase = phase;
      if (awaitingInput) attempt.awaitingInput = awaitingInput;
      else delete attempt.awaitingInput;
      if (phase === "reviewable") {
        attempt.capsuleId = options.capsuleId ?? "cap_provider_destination_e2e";
        attempt.planRunId = options.planRunIdFor?.(attempt.sequence) ?? options.planRunId ?? "run_provider_plan_e2e";
      }
    }
    attempt.generation += 1;
    attempt.rounds = 0;
    attempt.updatedAt = new Date(Date.parse(ATTEMPT_CREATED_AT) + attempt.generation * 1000).toISOString();
  };

  const advance = (attempt: StoredAttempt) => {
    attempt.rounds += 1;
    if (attempt.rounds < rounds) return;
    switch (attempt.phase) {
      case "syncing_source":
      case "compiling_install": {
        const proven = attempt.options.modulePath !== undefined &&
          modules.some((module) => module.path === attempt.options.modulePath);
        if (modules.length > 1 && !proven) move(attempt, "awaiting_input", "module");
        else move(attempt, "analyzing_compatibility");
        return;
      }
      case "analyzing_compatibility":
        move(attempt, "awaiting_input", "inputs");
        return;
      case "creating_capsule":
        move(attempt, "planning");
        return;
      case "planning":
        move(attempt, "reviewable");
        return;
      default:
        return;
    }
  };

  const create = (request: InstallAttemptFixtureRequest): InstallAttemptFixtureResponse => {
    const body = request.body as Record<string, unknown> | undefined;
    const source = body?.source as Record<string, unknown> | undefined;
    const capsule = body?.capsule as Record<string, unknown> | undefined;
    const optionsBody = body?.options as Record<string, unknown> | undefined;
    if (body?.mode !== "attempt" || typeof source?.url !== "string") {
      return attemptError(400, "invalid_request", "The fixture accepts only install attempts.");
    }
    const key = request.idempotencyKey ?? "";
    if (!key) return attemptError(400, "idempotency_key_required", "Idempotency-Key is required.");
    const existing = [...attempts.values()].find((attempt) => attempt.idempotencyKey === key);
    if (existing) return respond(existing);
    log.creates.push(body);
    sequence += 1;
    const id = `gip_${sequence.toString(16).padStart(16, "0")}`;
    const proposed = proposedAttemptName(source.url);
    const bindings = Array.isArray(optionsBody?.providerBindings)
      ? optionsBody.providerBindings as Record<string, unknown>[]
      : undefined;
    const attempt: StoredAttempt = {
      id,
      sequence,
      idempotencyKey: key,
      workspaceId,
      createdBy,
      source: {
        name: typeof source.name === "string" ? source.name : proposed,
        url: source.url,
        ref: typeof source.ref === "string" ? source.ref : "HEAD",
        path: typeof source.path === "string" ? source.path : ".",
        ...(typeof source.authConnectionId === "string" ? { authConnectionId: source.authConnectionId } : {}),
      },
      capsule: {
        name: typeof capsule?.name === "string" ? capsule.name : proposed,
        environment: typeof capsule?.environment === "string" ? capsule.environment : "production",
      },
      options: {
        ...(typeof optionsBody?.modulePath === "string" ? { modulePath: optionsBody.modulePath } : {}),
        ...(bindings ? { providerBindings: bindings } : {}),
        ...(Array.isArray(optionsBody?.interfaceLinks) ? { interfaceLinks: optionsBody.interfaceLinks as unknown as readonly GitInstallPlanInterfaceLinkRequest[] } : {}),
      },
      settings: [],
      phase: "syncing_source",
      generation: 0,
      rounds: 0,
      createdAt: ATTEMPT_CREATED_AT,
      updatedAt: ATTEMPT_CREATED_AT,
    };
    attempts.set(id, attempt);
    return respond(attempt, 201);
  };

  const answer = (attempt: StoredAttempt, body: Record<string, unknown> | undefined): InstallAttemptFixtureResponse => {
    log.answers.push(body);
    if (!body || typeof body.expectedGeneration !== "number") {
      return attemptError(400, "invalid_request", "expectedGeneration is required.");
    }
    if (body.expectedGeneration !== attempt.generation) {
      return attemptError(409, "install_plan_generation_conflict", "The install plan changed; read it and answer again.");
    }
    if (attempt.invalidated) {
      const code = attempt.invalidated;
      attempt.phase = "discarded";
      attempt.diagnostic = { code, message: "The install attempt can no longer continue." };
      attempt.generation += 1;
      return attemptError(409, "install_attempt_invalid", "The install attempt can no longer continue.", code);
    }
    if (attempt.phase !== "awaiting_input") {
      return attemptError(409, "install_plan_not_awaiting_input", "This install plan is not waiting for an answer.");
    }
    if (body.variables !== undefined && body.continue !== true) {
      return attemptError(400, "invalid_request", "variables are accepted only with continue.");
    }
    if (typeof body.modulePath === "string") {
      if (!modules.some((module) => module.path === body.modulePath)) {
        return attemptError(400, "install_module_unavailable", "That module is not in this version.");
      }
      attempt.options = { modulePath: body.modulePath };
      move(attempt, "compiling_install");
      return respond(attempt);
    }
    if (typeof body.capsuleName === "string") attempt.capsule = { ...attempt.capsule, name: body.capsuleName };
    if (Array.isArray(body.providerBindings)) {
      attempt.options = { ...attempt.options, providerBindings: body.providerBindings as Record<string, unknown>[] };
    }
    if (Array.isArray(body.interfaceLinks)) {
      attempt.options = { ...attempt.options, interfaceLinks: body.interfaceLinks as unknown as readonly GitInstallPlanInterfaceLinkRequest[] };
    }
    if (body.continue === true) {
      const action = userAction(attempt) as { missing?: readonly string[] };
      if (action.missing?.includes("connections")) {
        return attemptError(409, "install_inputs_incomplete", "Choose a connection for every provider.", "provider_connection_required");
      }
      if (action.missing?.includes("name")) {
        return attemptError(409, "install_inputs_incomplete", "Another app uses this name.", "capsule_name_conflict");
      }
      if (action.missing?.includes("interfaces")) {
        return attemptError(409, "install_inputs_incomplete", "Choose an app or link it later.", "interface_choice_required");
      }
      const values = (body.variables ?? {}) as Record<string, unknown>;
      const missingVariables = (options.variables ?? [])
        .filter((variable) => variable.required && !Object.hasOwn(values, variable.name))
        .map((variable) => variable.name);
      if (missingVariables.length > 0) {
        return attemptError(400, "invalid_request", `The settings are incomplete: ${missingVariables.join(", ")}.`, "install_variable_required");
      }
      attempt.settings = (options.variables ?? []).map((variable) => {
        const set = Object.hasOwn(values, variable.name);
        const metadata = { name: variable.name, type: variable.type, required: variable.required, sensitive: variable.sensitive };
        if (!set) return { ...metadata, set };
        if (variable.sensitive) return { ...metadata, set: true };
        return { ...metadata, set: true, value: values[variable.name] };
      });
      move(attempt, "creating_capsule");
      move(attempt, "planning");
      return respond(attempt);
    }
    attempt.generation += 1;
    return respond(attempt);
  };

  const discard = (attempt: StoredAttempt, body: Record<string, unknown> | undefined, search: string): InstallAttemptFixtureResponse => {
    const queryGeneration = new URLSearchParams(search).get("expectedGeneration");
    const expectedGeneration = body?.expectedGeneration ?? (queryGeneration === null ? undefined : Number(queryGeneration));
    log.discards.push({ id: attempt.id, expectedGeneration });
    if (attempt.phase === "discarded") return respond(attempt);
    if (expectedGeneration !== attempt.generation) {
      return attemptError(409, "install_plan_generation_conflict", "The install plan changed; read it and retry.");
    }
    attempt.phase = "discarded";
    delete attempt.awaitingInput;
    attempt.diagnostic = { code: "install_attempt_discarded", message: "The install attempt was discarded." };
    attempt.generation += 1;
    return respond(attempt);
  };

  /** Answer one request, or undefined when it is not an attempt route. */
  const handle = (request: InstallAttemptFixtureRequest): InstallAttemptFixtureResponse | undefined => {
    const method = request.method.toUpperCase();
    const workspaceCollection = request.path.match(/^\/api\/v1\/workspaces\/([^/]+)\/install-plans$/u);
    const collection = request.path === "/api/v1/install-plans" || workspaceCollection
      ? true
      : undefined;
    if (collection) {
      if (workspaceCollection && decodeURIComponent(workspaceCollection[1] ?? "") !== workspaceId) return attemptError(404, "not_found", "Workspace not found.");
      if (method === "POST") return create(request);
      if (method === "GET") {
        const open = new URLSearchParams(request.search ?? "").get("open");
        if (open !== "1" && open !== "true") return attemptError(400, "invalid_request", "Only open install attempts can be listed; pass open=1.");
        const installPlans = [...attempts.values()]
          .filter((attempt) => attempt.phase !== "failed" && attempt.phase !== "discarded")
          .sort((left, right) => right.id.localeCompare(left.id))
          .slice(0, 20)
          .map((attempt) => respond(attempt).json);
        return { status: 200, json: { installPlans } };
      }
      return attemptError(405, "method_not_allowed", "GET, POST");
    }
    const item = request.path.match(/^\/api\/v1\/install-plans\/([^/]+)(\/reconcile)?$/u);
    if (!item) return undefined;
    const attempt = attempts.get(decodeURIComponent(item[1] ?? ""));
    if (!attempt) return attemptError(404, "not_found", "Install plan not found.");
    if (item[2]) {
      if (method !== "POST") return attemptError(405, "method_not_allowed", "POST");
      log.reconciles += 1;
      if (!attempt.invalidated) advance(attempt);
      return respond(attempt);
    }
    const body = request.body as Record<string, unknown> | undefined;
    if (method === "GET") return respond(attempt);
    if (method === "PATCH") return answer(attempt, body);
    if (method === "DELETE") return discard(attempt, body, request.search ?? "");
    return attemptError(405, "method_not_allowed", "GET, PATCH, DELETE");
  };

  return {
    handle,
    log,
    /** The newest attempt, for assertions. */
    latest: () => [...attempts.values()].at(-1),
    /** Mark an attempt invalid, as the server does on read after expiry. */
    invalidate: (id: string, reason: "install_attempt_expired" | "workspace_management_changed" = "install_attempt_expired") => {
      const attempt = attempts.get(id);
      if (attempt) attempt.invalidated = reason;
    },
  };
}

export type InstallAttemptFixture = ReturnType<typeof createInstallAttemptFixture>;
