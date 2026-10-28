/**
 * Value-free facts and the `userAction` projection for coordinator-owned Git
 * install attempts (`mode: "attempt"`).
 *
 * Facts are captured from immutable evidence (SourceSnapshot module index,
 * the exact compatibility report and the compiled InstallConfig preview) when
 * an attempt pauses. Live data that can change while the actor looks at the
 * sheet — eligible Provider Connections and app-name collisions — is read
 * again for every projection, so creating a connection elsewhere is visible
 * on the next read without another coordinator write. No variable value is
 * captured, projected or compared here.
 */
import type {
  GitInstallPlanConnectionCandidate,
  GitInstallPlanConnectionRequirement,
  GitInstallPlanInterfaceLinkRequest,
  GitInstallPlanInterfaceRequirement,
  GitInstallPlanModuleCandidate,
  GitInstallPlanNameProposal,
  GitInstallPlanProviderBindingRequest,
  GitInstallPlanUserAction,
  GitInstallPlanVariablePresentation,
  JsonValue,
  PolicyConfig,
  ProviderConnection,
} from "takosumi-contract";
import type {
  Capsule,
  InstallConfig,
} from "takosumi-contract/install-configs";
import type {
  CapsuleCompatibilityReport,
  CapsuleRootModuleVariableDeclaration,
} from "takosumi-contract/capsules";
import { isWorkspaceBindableOperatorConnection } from "takosumi-contract/connections";
import { sameProviderSource } from "takosumi-contract/provider-env-rules";
import { isSecretKey } from "takosumi-contract/redaction";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { CapsuleRequiredInterface } from "takosumi-contract/interfaces";
import { accountsOidcModuleVariableProfile } from "../../../../core/domains/deploy-control/accounts_oidc_module_variable_profile.ts";

import type {
  GitInstallAttemptFacts,
  GitInstallAttemptProviderPolicy,
  GitInstallAttemptRequirement,
  StoredGitInstallPlan,
} from "../../../../core/domains/install-plans/store.ts";
import { defaultProjectId } from "../../../../core/domains/projects/mod.ts";
import type { ControlPlaneOperations } from "../control-operations.ts";

const MAX_FACT_MODULES = 100;
const MAX_FACT_RESOURCES = 200;
const MAX_FACT_VARIABLES = 256;
const MAX_NAME_SUFFIX = 99;
const MAX_CAPSULE_NAME = 128;

/** Deterministic initial Capsule id shared by creation, adoption and discard. */
export function deterministicInitialCapsuleId(planId: string): string {
  const suffix = planId.replace(/[^A-Za-z0-9]/gu, "").slice(-16);
  return `cap_${suffix.padStart(16, "0")}`;
}

/** Deterministic Source id reserved for one install plan. */
export function deterministicInstallSourceId(planId: string): string {
  const suffix = planId.replace(/[^A-Za-z0-9]/gu, "").slice(-16);
  return `src_${suffix.padStart(16, "0")}`;
}

/** `https://github.com/o/my_App.git` → `my-app`; never empty. */
export function proposedAppName(url: string): string {
  const last = url
    .replace(/[?#].*$/u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    .split(/[/:]/u)
    .filter((part) => part.length > 0)
    .at(-1) ?? "";
  const slug = last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 63)
    .replace(/-$/u, "");
  return slug || "app";
}

/** Module candidates captured for a `module` pause. */
export function moduleCandidates(
  snapshot: SourceSnapshot,
): readonly GitInstallPlanModuleCandidate[] {
  const index = snapshot.repositoryModules;
  if (!index || index.status !== "ready") return [];
  return index.modules.slice(0, MAX_FACT_MODULES).map((module) => ({
    path: module.path,
    providers: [
      ...new Set(module.providerPackages.map((provider) => provider.source)),
    ].sort(),
  }));
}

export type AttemptInputFactsResult =
  | { readonly ok: true; readonly facts: NonNullable<GitInstallAttemptFacts["inputs"]> }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Inputs facts for one analyzed module. `installConfig` is the preview the
 * coordinator will commit (repository manifest) or the materialized generic
 * configuration; `baseConfig` supplies host-owned generic values.
 */
export function attemptInputFacts(input: {
  readonly modulePath: string;
  readonly report: CapsuleCompatibilityReport;
  readonly installConfig: InstallConfig;
  readonly baseConfig: InstallConfig;
  readonly repositoryManifest: boolean;
}): AttemptInputFactsResult {
  const requirements: GitInstallAttemptRequirement[] = input.report
    .rootProviderRequirements
    .filter((requirement) => requirement.credentialRequired === true)
    .map((requirement) => ({
      provider: requirement.source,
      moduleLocalName: requirement.moduleLocalName,
      ...(requirement.childAlias !== undefined
        ? { childAlias: requirement.childAlias }
        : {}),
    }));
  let variables: GitInstallPlanVariablePresentation[];
  if (input.repositoryManifest) {
    variables = [];
    for (const entry of input.installConfig.variablePresentation ?? []) {
      const literalDefault = entry.defaultValue?.source === "literal"
        ? entry.defaultValue.value
        : undefined;
      const derivedDefault = entry.defaultValue?.source === "capsule_name" ||
          entry.defaultValue?.source === "workspace_scoped_capsule_name"
        ? entry.defaultValue.source
        : undefined;
      if (entry.secret === true) {
        // Install-time secret values have no host materialization boundary
        // yet; the compiler rejects them. A required one makes the attempt
        // impossible, an optional one is simply not offered.
        if (entry.required === true && entry.defaultValue === undefined) {
          return {
            ok: false,
            code: "repository_install_ux_secret_materialization_required",
            message:
              "This app needs a secret setting that Takosumi cannot accept at install time yet.",
          };
        }
        continue;
      }
      const sensitive = isSecretKey(entry.name);
      variables.push({
        name: entry.name,
        type: entry.type ?? "unknown",
        required: entry.required === true && entry.defaultValue === undefined,
        sensitive,
        ...(entry.advanced === true ? { advanced: true } : {}),
        label: entry.label,
        ...(entry.helper ? { description: entry.helper } : {}),
        ...(entry.placeholder && !sensitive
          ? { placeholder: entry.placeholder }
          : {}),
        ...(literalDefault !== undefined && !sensitive
          ? { defaultValue: literalDefault as JsonValue }
          : {}),
        ...(derivedDefault ? { derivedDefault } : {}),
      });
    }
  } else {
    const declarations: readonly CapsuleRootModuleVariableDeclaration[] =
      input.report.rootModuleVariableDeclarations ?? [];
    const hostMapped = input.baseConfig.variableMapping;
    variables = declarations
      .filter((declaration) =>
        !Object.prototype.hasOwnProperty.call(hostMapped, declaration.name)
      )
      .map((declaration) => ({
        name: declaration.name,
        type: declaration.type,
        required: !declaration.hasDefault,
        // HCL `sensitive` cannot be proven statically: every generic value
        // is write-only, exactly as the public InstallConfig projection.
        sensitive: true,
      }));
  }
  let repositoryAccountsOidcPublicUrlVariable: string | undefined;
  if (input.repositoryManifest) {
    try {
      repositoryAccountsOidcPublicUrlVariable = accountsOidcModuleVariableProfile(
        input.installConfig,
      )?.publicUrlVariable;
    } catch {
      return {
        ok: false,
        code: "repository_install_ux_profile_invalid",
        message: "This app's reviewed sign-in settings are invalid.",
      };
    }
  }
  return {
    ok: true,
    facts: {
      modulePath: input.modulePath,
      resources: input.report.resources.slice(0, MAX_FACT_RESOURCES).map(
        (resource) => ({
          type: resource.type,
          ...(resource.count !== undefined ? { count: resource.count } : {}),
          allowed: resource.allowed,
        }),
      ),
      requirements,
      variables: variables.slice(0, MAX_FACT_VARIABLES),
      ...(input.installConfig.requiredInterfaces?.length
        ? { requiredInterfaces: input.installConfig.requiredInterfaces }
        : {}),
      ...(repositoryAccountsOidcPublicUrlVariable !== undefined
        ? { repositoryAccountsOidcPublicUrlVariable }
        : {}),
      ...(providerPolicyFrom(input.installConfig.policy)
        ? { providerPolicy: providerPolicyFrom(input.installConfig.policy) }
        : {}),
    },
  };
}

function providerPolicyFrom(
  policy: PolicyConfig | undefined,
): GitInstallAttemptProviderPolicy | undefined {
  const credentials = policy?.providerCredentials;
  if (!credentials) return undefined;
  const reduced: GitInstallAttemptProviderPolicy = {
    ...(credentials.allowedConnectionIds
      ? { allowedConnectionIds: [...credentials.allowedConnectionIds] }
      : {}),
    ...(credentials.forbiddenConnectionIds
      ? { forbiddenConnectionIds: [...credentials.forbiddenConnectionIds] }
      : {}),
    ...(credentials.allowedConnectionScopes
      ? { allowedConnectionScopes: [...credentials.allowedConnectionScopes] }
      : {}),
    ...(credentials.allowedCredentialRecipes
      ? {
          allowedCredentialRecipes: credentials.allowedCredentialRecipes.map(
            (recipe) => ({ id: recipe.id, authMode: recipe.authMode }),
          ),
        }
      : {}),
    ...(credentials.requiredCredentialCapabilities
      ? {
          requiredCredentialCapabilities: [
            ...credentials.requiredCredentialCapabilities,
          ],
        }
      : {}),
  };
  return Object.keys(reduced).length > 0 ? reduced : undefined;
}

/**
 * Intersects the Workspace ceiling with the install policy on the same axes
 * the deploy-control policy composer enforces. The result only decides what
 * the sheet offers; the atomic creation re-validates every binding.
 */
function mergedProviderPolicy(
  workspace: PolicyConfig | undefined,
  install: GitInstallAttemptProviderPolicy | undefined,
): GitInstallAttemptProviderPolicy {
  const ceiling = providerPolicyFrom(workspace) ?? {};
  const local = install ?? {};
  const intersect = (
    left: readonly string[] | undefined,
    right: readonly string[] | undefined,
  ) => left === undefined
    ? right
    : right === undefined
      ? left
      : right.filter((value) => left.includes(value));
  const recipes = ceiling.allowedCredentialRecipes === undefined
    ? local.allowedCredentialRecipes
    : local.allowedCredentialRecipes === undefined
      ? ceiling.allowedCredentialRecipes
      : local.allowedCredentialRecipes.filter((recipe) =>
          ceiling.allowedCredentialRecipes!.some((candidate) =>
            candidate.id === recipe.id && candidate.authMode === recipe.authMode
          )
        );
  const forbidden = [
    ...(ceiling.forbiddenConnectionIds ?? []),
    ...(local.forbiddenConnectionIds ?? []),
  ];
  const capabilities = [
    ...(ceiling.requiredCredentialCapabilities ?? []),
    ...(local.requiredCredentialCapabilities ?? []),
  ];
  const allowedIds = intersect(
    ceiling.allowedConnectionIds,
    local.allowedConnectionIds,
  );
  const allowedScopes = intersect(
    ceiling.allowedConnectionScopes,
    local.allowedConnectionScopes,
  );
  return {
    ...(allowedIds !== undefined ? { allowedConnectionIds: allowedIds } : {}),
    ...(forbidden.length > 0 ? { forbiddenConnectionIds: forbidden } : {}),
    ...(allowedScopes !== undefined
      ? { allowedConnectionScopes: allowedScopes }
      : {}),
    ...(recipes !== undefined ? { allowedCredentialRecipes: recipes } : {}),
    ...(capabilities.length > 0
      ? { requiredCredentialCapabilities: capabilities }
      : {}),
  };
}

function connectionAllowed(
  connection: ProviderConnection,
  policy: GitInstallAttemptProviderPolicy,
): boolean {
  if (
    policy.allowedConnectionIds !== undefined &&
    !policy.allowedConnectionIds.includes(connection.id)
  ) return false;
  if (policy.forbiddenConnectionIds?.includes(connection.id)) return false;
  if (
    policy.allowedConnectionScopes !== undefined &&
    !policy.allowedConnectionScopes.includes(connection.scope)
  ) return false;
  if (policy.allowedCredentialRecipes !== undefined) {
    const recipe = connection.credentialRecipe;
    if (
      !recipe ||
      !policy.allowedCredentialRecipes.some((candidate) =>
        candidate.id === recipe.id && candidate.authMode === recipe.authMode
      )
    ) return false;
  }
  if (policy.requiredCredentialCapabilities !== undefined) {
    const verification = connection.credentialVerification;
    const capabilities = verification?.kind ===
        "takosumi.credential-verification@v1"
      ? new Set(verification.capabilities ?? [])
      : new Set<string>();
    if (
      policy.requiredCredentialCapabilities.some((capability) =>
        !capabilities.has(capability)
      )
    ) return false;
  }
  return true;
}

function isOfferableConnection(
  connection: ProviderConnection,
  workspaceId: string,
): boolean {
  return isWorkspaceBindableOperatorConnection(connection) ||
    (connection.scope === "workspace" &&
      connection.status === "verified" &&
      connection.workspaceId === workspaceId);
}

function sameRequirement(
  requirement: GitInstallAttemptRequirement,
  binding: Pick<
    GitInstallPlanProviderBindingRequest,
    "provider" | "moduleLocalName" | "childAlias"
  >,
): boolean {
  return requirement.provider === binding.provider &&
    requirement.moduleLocalName === binding.moduleLocalName &&
    (requirement.childAlias ?? undefined) === (binding.childAlias ?? undefined);
}

/** Live connection rows for an `inputs` pause. */
export async function connectionRequirements(
  operations: ControlPlaneOperations,
  plan: Pick<StoredGitInstallPlan, "workspaceId" | "options" | "attemptFacts">,
): Promise<readonly GitInstallPlanConnectionRequirement[]> {
  const facts = plan.attemptFacts?.inputs;
  if (!facts || facts.requirements.length === 0) return [];
  const [connections, workspace] = await Promise.all([
    operations.connections.listProviderConnections(plan.workspaceId),
    operations.workspaces.getWorkspace(plan.workspaceId),
  ]);
  const policy = mergedProviderPolicy(workspace.policy, facts.providerPolicy);
  const explicit = plan.options.providerBindings ?? [];
  return facts.requirements.map((requirement) => {
    const candidates: GitInstallPlanConnectionCandidate[] = connections
      .filter((connection) =>
        isOfferableConnection(connection, plan.workspaceId) &&
        sameProviderSource(requirement.provider, connection.providerSource) &&
        connectionAllowed(connection, policy)
      )
      .map((connection) => ({
        id: connection.id,
        displayName: connection.displayName || connection.id,
        status: connection.status,
        scope: connection.scope,
      }))
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const answer = explicit.find((binding) => sameRequirement(requirement, binding));
    const selected = answer?.connectionId ??
      (candidates.length === 1 ? candidates[0]!.id : undefined);
    return {
      provider: requirement.provider,
      moduleLocalName: requirement.moduleLocalName,
      ...(requirement.childAlias !== undefined
        ? {
            childAlias: requirement.childAlias,
            rootAlias: answer?.rootAlias ?? requirement.childAlias,
          }
        : answer?.rootAlias !== undefined
          ? { rootAlias: answer.rootAlias }
          : {}),
      candidates,
      ...(selected !== undefined ? { selectedConnectionId: selected } : {}),
      autoSelected: answer === undefined && selected !== undefined,
    };
  });
}

/** True when each requirement has a selection among its live candidates. */
export function connectionsReady(
  rows: readonly GitInstallPlanConnectionRequirement[],
): boolean {
  return rows.every((row) =>
    row.selectedConnectionId !== undefined &&
    row.candidates.some((candidate) => candidate.id === row.selectedConnectionId)
  );
}

/** Exact binding answers for the atomic creation (explicit or only choice). */
export function effectiveProviderBindings(
  rows: readonly GitInstallPlanConnectionRequirement[],
): readonly GitInstallPlanProviderBindingRequest[] {
  return rows.map((row) => ({
    provider: row.provider,
    moduleLocalName: row.moduleLocalName,
    ...(row.childAlias !== undefined ? { childAlias: row.childAlias } : {}),
    ...(row.rootAlias !== undefined ? { rootAlias: row.rootAlias } : {}),
    connectionId: row.selectedConnectionId!,
  }));
}

/** Whether a binding answer names an exact requirement of the analyzed module. */
export function bindingMatchesRequirement(
  facts: NonNullable<GitInstallAttemptFacts["inputs"]>,
  binding: GitInstallPlanProviderBindingRequest,
): boolean {
  return facts.requirements.some((requirement) =>
    sameRequirement(requirement, binding)
  );
}

/** Live providers accessible to this already-admitted install actor. */
export async function interfaceRequirements(
  operations: ControlPlaneOperations,
  plan: Pick<
    StoredGitInstallPlan,
    "id" | "workspaceId" | "options" | "attemptFacts" | "autoSelectedInterfaceKeys"
  >,
  requirements: readonly CapsuleRequiredInterface[] =
    plan.attemptFacts?.inputs?.requiredInterfaces ?? [],
): Promise<readonly GitInstallPlanInterfaceRequirement[]> {
  if (requirements.length === 0) return [];
  const capsuleId = deterministicInitialCapsuleId(plan.id);
  const capsules = new Map(
    (await operations.capsules.listCapsules(plan.workspaceId))
      .filter((capsule) => capsule.workspaceId === plan.workspaceId &&
        capsule.status !== "destroyed" && capsule.status !== "uninstalled" &&
        capsule.uninstall?.phase !== "scheduled" && capsule.id !== capsuleId)
      .map((capsule) => [capsule.id, capsule]),
  );
  const rows = await Promise.all(requirements.map(async (requirement) => {
    const offered = await operations.interfaces?.listInterfaceLinkCandidates?.({
      workspaceId: plan.workspaceId,
      capsuleId,
      requirement,
    }) ?? [];
    const candidates = offered.filter((candidate) =>
      candidate.metadata.workspaceId === plan.workspaceId &&
      candidate.metadata.ownerRef.kind === "Capsule" &&
      capsules.has(candidate.metadata.ownerRef.id) &&
      candidate.status.phase === "Resolved" &&
      candidate.spec.type === requirement.interface.type &&
      candidate.spec.version === requirement.interface.version
    ).map((candidate) => ({
      id: candidate.metadata.id,
      name: candidate.metadata.name,
      capsuleId: candidate.metadata.ownerRef.id,
      capsuleName: capsules.get(candidate.metadata.ownerRef.id)!.name,
    })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const answer = plan.options.interfaceLinks?.find((entry) =>
      entry.requirementKey === requirement.key
    );
    const onlyCandidate = candidates.length === 1 ? offered.find((candidate) =>
      candidate.metadata.id === candidates[0]!.id
    ) : undefined;
    const choice = answer?.choice ?? (candidates.length === 1 &&
      onlyCandidate?.spec.access.visibility !== "private"
      ? { kind: "interface" as const, interfaceId: candidates[0]!.id }
      : candidates.length === 0 ? { kind: "later" as const } : undefined);
    return {
      requirementKey: requirement.key,
      type: requirement.interface.type,
      version: requirement.interface.version,
      permissions: requirement.permissions,
      candidates,
      ...(choice ? { choice } : {}),
      autoSelected: answer === undefined
        ? choice?.kind === "interface"
        : choice?.kind === "interface" &&
          plan.autoSelectedInterfaceKeys?.includes(requirement.key) === true,
    };
  }));
  const used = new Set(rows.flatMap((row) =>
    !row.autoSelected && row.choice?.kind === "interface" ? [row.choice.interfaceId] : []
  ));
  return rows.map((row) => {
    if (!row.autoSelected || row.choice?.kind !== "interface") return row;
    if (used.has(row.choice.interfaceId)) {
      return { ...row, choice: undefined, autoSelected: false };
    }
    used.add(row.choice.interfaceId);
    return row;
  });
}

/** Missing choices block only when multiple providers need a user decision. */
export function interfacesReady(rows: readonly GitInstallPlanInterfaceRequirement[]): boolean {
  return !duplicateSelectedInterface(rows) && rows.every((row) => {
    const choice = row.choice;
    return choice?.kind === "later" || choice?.kind === "interface" &&
      row.candidates.some((candidate) => candidate.id === choice.interfaceId);
  });
}

/** A provider can back only one requirement of the same consumer Capsule. */
export function duplicateSelectedInterface(rows: readonly GitInstallPlanInterfaceRequirement[]): boolean {
  const selected = rows.flatMap((row) => row.choice?.kind === "interface" ? [row.choice.interfaceId] : []);
  return new Set(selected).size !== selected.length;
}

/** Freeze the choices without persisting provider documents or grant material. */
export function effectiveInterfaceLinks(
  rows: readonly GitInstallPlanInterfaceRequirement[],
): readonly GitInstallPlanInterfaceLinkRequest[] {
  return rows.filter((row) => row.choice !== undefined).map((row) => ({
    requirementKey: row.requirementKey,
    choice: row.choice!,
  }));
}

/** Live collision check against active Capsules in the default Project. */
export async function nameProposal(
  operations: ControlPlaneOperations,
  plan: Pick<StoredGitInstallPlan, "id" | "workspaceId" | "capsule">,
): Promise<GitInstallPlanNameProposal> {
  const own = deterministicInitialCapsuleId(plan.id);
  const projectId = defaultProjectId(plan.workspaceId);
  const taken = new Set(
    (await operations.capsules.listCapsules(plan.workspaceId))
      .filter((capsule: Capsule) =>
        capsule.id !== own &&
        capsule.status !== "destroyed" &&
        capsule.environment === plan.capsule.environment &&
        (capsule.projectId === undefined || capsule.projectId === projectId)
      )
      .map((capsule) => capsule.name),
  );
  const current = plan.capsule.name;
  if (!taken.has(current)) return { current, proposed: current, conflict: false };
  for (let suffix = 2; suffix <= MAX_NAME_SUFFIX; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${current.slice(0, MAX_CAPSULE_NAME - tail.length)}${tail}`;
    if (!taken.has(candidate)) {
      return { current, proposed: candidate, conflict: true };
    }
  }
  return { current, proposed: current, conflict: true };
}

export type AttemptVariablesCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly names: readonly string[] };

/**
 * Cheap pre-claim validation of the confirming request's variables against
 * the captured presentation. Names only ever leave this function.
 */
export function checkAttemptVariables(
  facts: NonNullable<GitInstallAttemptFacts["inputs"]> | undefined,
  variables: Readonly<Record<string, JsonValue>>,
): AttemptVariablesCheck {
  const declared = new Map(
    (facts?.variables ?? []).map((variable) => [variable.name, variable]),
  );
  const unknown = Object.keys(variables).filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    return { ok: false, reason: "install_variable_unknown", names: unknown.sort() };
  }
  const mismatched = Object.entries(variables)
    .filter(([name, value]) => {
      const type = declared.get(name)!.type;
      return (type === "string" && typeof value !== "string") ||
        (type === "number" && typeof value !== "number") ||
        (type === "boolean" && typeof value !== "boolean");
    })
    .map(([name]) => name);
  if (mismatched.length > 0) {
    return {
      ok: false,
      reason: "install_variable_type_mismatch",
      names: mismatched.sort(),
    };
  }
  const missing = [...declared.values()]
    .filter((variable) =>
      variable.required &&
      !Object.prototype.hasOwnProperty.call(variables, variable.name)
    )
    .map((variable) => variable.name);
  if (missing.length > 0) {
    return { ok: false, reason: "install_variable_required", names: missing.sort() };
  }
  const publicUrlVariable = facts?.repositoryAccountsOidcPublicUrlVariable;
  if (
    publicUrlVariable !== undefined &&
    Object.prototype.hasOwnProperty.call(variables, publicUrlVariable) &&
    !isCanonicalHttpsOrigin(variables[publicUrlVariable])
  ) {
    return {
      ok: false,
      reason: "install_variable_invalid",
      names: [publicUrlVariable],
    };
  }
  return { ok: true };
}

function isCanonicalHttpsOrigin(value: JsonValue | undefined): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" &&
      parsed.password === "" && parsed.port === "" &&
      parsed.pathname === "/" && parsed.search === "" && parsed.hash === "" &&
      parsed.origin === value;
  } catch {
    return false;
  }
}

/**
 * The single next user action. Pure for every phase except an `inputs`
 * pause, which reads live connections and app names.
 */
export async function userActionFor(
  operations: ControlPlaneOperations,
  plan: StoredGitInstallPlan,
): Promise<GitInstallPlanUserAction> {
  switch (plan.phase) {
    case "syncing_source":
    case "compiling_install":
    case "analyzing_compatibility":
    case "creating_capsule":
    case "planning":
      return plan.diagnostic?.code === "install_plan_reconcile_retryable"
        ? { kind: "retry", code: plan.diagnostic.code, restart: false }
        : { kind: "wait", phase: plan.phase };
    case "reviewable":
      return plan.planRunId && plan.capsuleId
        ? { kind: "review_run", planRunId: plan.planRunId, capsuleId: plan.capsuleId }
        : { kind: "none" };
    case "failed":
      return {
        kind: "retry",
        code: plan.diagnostic?.code ?? "install_plan_failed",
        restart: true,
      };
    case "discarded":
      return { kind: "none" };
    case "awaiting_input":
      break;
  }
  if (plan.awaitingInput === "module") {
    return {
      kind: "choose_module",
      modules: plan.attemptFacts?.modules ?? [],
      ...(plan.options.modulePath !== undefined
        ? { requested: plan.options.modulePath }
        : {}),
    };
  }
  const facts = plan.attemptFacts?.inputs;
  // After a started creation only a resubmission is accepted, even when the
  // confirming request carried no variables.
  const resubmitting = plan.creationAttempted === true;
  const resubmit = plan.transientVariableNames ?? [];
  const [connections, interfaces, name] = await Promise.all([
    connectionRequirements(operations, plan),
    interfaceRequirements(operations, plan),
    nameProposal(operations, plan),
  ]);
  const variables = facts?.variables ??
    resubmit.map((variableName) => ({
      name: variableName,
      type: "unknown" as const,
      required: true,
      sensitive: true,
    }));
  return {
    kind: "provide_inputs",
    modulePath: facts?.modulePath ?? plan.installModulePath ??
      plan.options.modulePath ?? ".",
    resources: facts?.resources ?? [],
    connections,
    interfaces,
    variables,
    name,
    missing: [
      ...(connectionsReady(connections) ? [] : ["connections" as const]),
      ...(interfacesReady(interfaces) ? [] : ["interfaces" as const]),
      ...(name.conflict ? ["name" as const] : []),
    ],
    ...(resubmitting ? { resubmitVariables: [...resubmit] } : {}),
  };
}

const PHASES_BEFORE_CAPSULE: ReadonlySet<string> = new Set([
  "syncing_source",
  "compiling_install",
  "analyzing_compatibility",
  "awaiting_input",
]);

/**
 * Only an attempt whose Capsule cannot exist yet may expire. Once a
 * confirming request started creation a Capsule may exist, so it never does.
 */
export function attemptCanExpire(
  plan: Pick<
    StoredGitInstallPlan,
    "mode" | "phase" | "capsuleId" | "transientVariableNames" | "creationAttempted"
  >,
): boolean {
  return plan.mode === "attempt" &&
    PHASES_BEFORE_CAPSULE.has(plan.phase) &&
    plan.capsuleId === undefined &&
    plan.creationAttempted !== true &&
    (plan.transientVariableNames?.length ?? 0) === 0;
}

/** Projection-only: reads never store or apply this decision. */
export function attemptIsExpired(
  plan: Pick<
    StoredGitInstallPlan,
    | "mode"
    | "phase"
    | "capsuleId"
    | "transientVariableNames"
    | "creationAttempted"
    | "expiresAt"
  >,
  now: number,
): boolean {
  return attemptCanExpire(plan) &&
    typeof plan.expiresAt === "string" &&
    Number.isFinite(Date.parse(plan.expiresAt)) &&
    Date.parse(plan.expiresAt) <= now;
}
