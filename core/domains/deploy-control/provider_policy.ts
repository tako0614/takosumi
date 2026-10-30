/**
 * Provider / Capsule policy evaluation for the deploy-control domain.
 *
 * Pure functions over contract types that layer Workspace policy and InstallConfig
 * policy, gate a Capsule Compatibility Report, and evaluate the provider
 * lockfile / installation-mirror / credential-mint policies. These were lifted
 * verbatim out of `mod.ts`; they take no controller or store state. The
 * controller composes them with run-execution ceremony in `mod.ts`.
 */

import type { PolicyConfig } from "@takosumi/internal/deploy-control-api";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type {
  ConnectionScopeKind,
  ProviderConnection,
} from "takosumi-contract/connections";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";
import { normalizeScopeBoundaryPolicy } from "takosumi-contract";
import {
  canonicalProviderSource,
  isOpenTofuBuiltinProviderSource,
} from "takosumi-contract/provider-env-rules";
import { stableStringify } from "../../adapters/source/digest.ts";
import { providerMatches } from "./policy.ts";
import { normalizeProviders } from "./validation.ts";
import {
  evaluateProviderAllowlist,
  type ProviderAllowlistResult,
} from "takosumi-policy";
import type { ProviderInstallationEvidence } from "./mod.ts";

type AllowedCredentialRecipe = {
  readonly id: string;
  readonly authMode: string;
};
type AllowedCredentialRecipes = readonly AllowedCredentialRecipe[];

/**
 * Canonicalizes a provider rule to a fully-qualified OpenTofu registry address.
 * A bare `namespace/type` (the OpenTofu source form templates declare) is
 * prefixed with the default registry host; an already-qualified address (3+
 * segments) is returned unchanged.
 */
export function canonicalProviderAddress(rule: string): string {
  return canonicalProviderSource(rule);
}

export function mergePolicyConfigs(
  spacePolicy: PolicyConfig | undefined,
  installPolicy: PolicyConfig | undefined,
): PolicyConfig | undefined {
  if (!spacePolicy && !installPolicy) return undefined;
  return {
    allowedProviders: intersectOptionalLists(
      spacePolicy?.allowedProviders,
      installPolicy?.allowedProviders,
    ),
    allowedResourceTypes: intersectOptionalLists(
      spacePolicy?.allowedResourceTypes,
      installPolicy?.allowedResourceTypes,
    ),
    allowedDataSourceTypes: intersectOptionalLists(
      spacePolicy?.allowedDataSourceTypes,
      installPolicy?.allowedDataSourceTypes,
    ),
    allowedProvisionerTypes: intersectOptionalLists(
      spacePolicy?.allowedProvisionerTypes,
      installPolicy?.allowedProvisionerTypes,
    ),
    destructiveChanges:
      installPolicy?.destructiveChanges ?? spacePolicy?.destructiveChanges,
    providerLockfile: mergeProviderLockfilePolicy(
      spacePolicy?.providerLockfile,
      installPolicy?.providerLockfile,
    ),
    providerInstallation: mergeProviderInstallationPolicy(
      spacePolicy?.providerInstallation,
      installPolicy?.providerInstallation,
    ),
    providerCredentials: mergeProviderCredentialPolicy(
      spacePolicy?.providerCredentials,
      installPolicy?.providerCredentials,
    ),
    scopeBoundary: mergeScopeBoundary(
      spacePolicy?.scopeBoundary,
      installPolicy?.scopeBoundary,
    ),
    quota: mergeQuota(spacePolicy?.quota, installPolicy?.quota),
  };
}

/**
 * The PolicyConfig keys a Workspace policy contributes when
 * {@link mergePolicyConfigs} layers it over an InstallConfig policy. Every
 * other Workspace policy key (`lifecycleActions`, `repositoryInstallUx`, or an
 * unknown key) never reached a runtime decision, so it is neither enforced nor
 * baked (TASK-0118 P9.1-g).
 */
export const WORKSPACE_POLICY_CEILING_KEYS = [
  "allowedProviders",
  "allowedResourceTypes",
  "allowedDataSourceTypes",
  "allowedProvisionerTypes",
  "destructiveChanges",
  "providerLockfile",
  "providerInstallation",
  "providerCredentials",
  "scopeBoundary",
  "quota",
] as const satisfies readonly (keyof PolicyConfig)[];

/** Maximum persisted `scopeBoundary.rules` (`parseScopeBoundaryPolicy`). */
export const SCOPE_BOUNDARY_RULE_LIMIT = 64;

/**
 * The part of a Workspace policy that acts as a runtime ceiling, or
 * `undefined` when it has none.
 */
export function workspacePolicyCeiling(
  policy: PolicyConfig | undefined,
): PolicyConfig | undefined {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return undefined;
  }
  const ceiling: Record<string, unknown> = {};
  for (const key of WORKSPACE_POLICY_CEILING_KEYS) {
    if (policy[key] !== undefined) ceiling[key] = policy[key];
  }
  return Object.keys(ceiling).length > 0 ? ceiling as PolicyConfig : undefined;
}

/**
 * Bakes a Workspace policy ceiling into one InstallConfig policy with the
 * strictest merge (TASK-0118 data policy: "Workspace.policy is baked into each
 * app's InstallConfig policy as the strictest composition").
 *
 * Only the keys the Workspace sets are rewritten. Each takes the value
 * {@link mergePolicyConfigs} enforces today (allowlists intersect, `require*`
 * flags OR, required and forbidden lists union, quotas take the minimum, both
 * scope-boundary rule sets stay enforceable), with two changes that keep the
 * result no weaker than the runtime composition: `destructiveChanges` requires
 * confirmation when either layer does (the runtime let the InstallConfig layer
 * override the Workspace), and duplicate scope-boundary rules are dropped.
 *
 * Every rewritten value is written in canonical form (sets as sorted,
 * duplicate-free arrays; flags as explicit booleans; no `undefined` members),
 * so `bake(ws, bake(ws, p))` equals `bake(ws, p)` for any input order. An
 * unnecessary second rebind would reset the app's OIDC activation and discard
 * its pending Plans. Keys the Workspace does not set, and keys it never
 * contributes (`lifecycleActions`, `repositoryInstallUx`, unknown keys), keep
 * the InstallConfig value verbatim, so baking never rewrites an app only to
 * reorder a list the Workspace does not constrain.
 */
export function bakeWorkspacePolicy(
  workspacePolicy: PolicyConfig | undefined,
  installPolicy: PolicyConfig | undefined,
): PolicyConfig | undefined {
  const ceiling = workspacePolicyCeiling(workspacePolicy);
  if (!ceiling) return installPolicy;
  const malformed = malformedWorkspacePolicyKeys(ceiling);
  if (malformed.length > 0) {
    throw new TypeError(
      `Workspace policy cannot be baked; malformed keys: ${malformed.join(", ")}`,
    );
  }
  const merged = mergePolicyConfigs(ceiling, installPolicy) ?? {};
  const baked: Record<string, unknown> = { ...(installPolicy ?? {}) };
  for (const key of WORKSPACE_POLICY_CEILING_KEYS) {
    if (ceiling[key] === undefined) continue;
    const value = canonicalCeilingValue(
      key,
      key === "destructiveChanges"
        ? strictestDestructiveChanges(
            ceiling.destructiveChanges,
            installPolicy?.destructiveChanges,
          )
        : merged[key],
    );
    if (value === undefined) delete baked[key];
    else baked[key] = value;
  }
  return baked as PolicyConfig;
}

/**
 * Workspace ceiling keys whose stored value is not a well-formed ceiling (an
 * allowlist that is `null`, not an array or holds a non-string; a flag,
 * credential or quota value of the wrong shape; an invalid scope boundary).
 * Such a policy cannot be baked: the strictest merge of a malformed value is
 * undefined, and treating it as absent would lift a limit the runtime
 * composition refuses on (fail closed). It stays a runtime ceiling with the
 * old composition and the bake tool refuses its apps.
 */
export function malformedWorkspacePolicyKeys(
  policy: PolicyConfig | undefined,
): string[] {
  if (!isPlainObject(policy)) return [];
  const record = policy as Record<string, unknown>;
  return WORKSPACE_POLICY_CEILING_KEYS.filter((key) =>
    record[key] !== undefined && !wellFormedCeilingValue(key, record[key])
  );
}

function wellFormedCeilingValue(
  key: (typeof WORKSPACE_POLICY_CEILING_KEYS)[number],
  value: unknown,
): boolean {
  switch (key) {
    case "allowedProviders":
    case "allowedResourceTypes":
    case "allowedDataSourceTypes":
    case "allowedProvisionerTypes":
      return isStringList(value);
    case "destructiveChanges":
      return hasOptionalBooleans(value, ["requireExplicitConfirmation"]);
    case "providerLockfile":
      return hasOptionalBooleans(value, ["requireDigest"]);
    case "providerInstallation":
      return hasOptionalBooleans(value, ["requireMirror"]);
    case "providerCredentials": {
      if (!hasOptionalBooleans(value, ["requireTemporary", "requireTtlEnforced"])) {
        return false;
      }
      const credentials = value as Record<string, unknown>;
      return [
        "requiredProviders",
        "allowedConnectionIds",
        "forbiddenConnectionIds",
        "allowedConnectionScopes",
        "requiredCredentialCapabilities",
      ].every((field) =>
        credentials[field] === undefined || isStringList(credentials[field])
      ) &&
        (credentials.allowedCredentialRecipes === undefined ||
          (Array.isArray(credentials.allowedCredentialRecipes) &&
            credentials.allowedCredentialRecipes.every((recipe: unknown) =>
              isPlainObject(recipe) &&
              typeof (recipe as Record<string, unknown>).id === "string" &&
              typeof (recipe as Record<string, unknown>).authMode === "string"
            )));
    }
    case "scopeBoundary":
      if (!isPlainObject(value)) return false;
      try {
        normalizeScopeBoundaryPolicy(value);
        return true;
      } catch {
        return false;
      }
    case "quota":
      return isPlainObject(value) &&
        Object.values(value as Record<string, unknown>).every((limit) =>
          typeof limit === "number" && Number.isFinite(limit)
        );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasOptionalBooleans(value: unknown, fields: readonly string[]): boolean {
  return isPlainObject(value) &&
    fields.every((field) =>
      value[field] === undefined || typeof value[field] === "boolean"
    );
}

/** Canonical form of one baked ceiling value (see {@link bakeWorkspacePolicy}). */
function canonicalCeilingValue(
  key: (typeof WORKSPACE_POLICY_CEILING_KEYS)[number],
  value: unknown,
): unknown {
  if (value === undefined || value === null) return undefined;
  switch (key) {
    case "allowedProviders":
    case "allowedResourceTypes":
    case "allowedDataSourceTypes":
    case "allowedProvisionerTypes":
      return sortedSet(value as readonly string[]);
    case "destructiveChanges": {
      const policy = value as NonNullable<PolicyConfig["destructiveChanges"]>;
      return {
        requireExplicitConfirmation: policy.requireExplicitConfirmation === true,
      };
    }
    case "providerLockfile":
      return {
        requireDigest:
          (value as NonNullable<PolicyConfig["providerLockfile"]>)
            .requireDigest === true,
      };
    case "providerInstallation":
      return {
        requireMirror:
          (value as NonNullable<PolicyConfig["providerInstallation"]>)
            .requireMirror === true,
      };
    case "providerCredentials":
      return canonicalProviderCredentials(
        value as NonNullable<PolicyConfig["providerCredentials"]>,
      );
    case "scopeBoundary":
      return withoutDuplicateScopeRules(
        value as NonNullable<PolicyConfig["scopeBoundary"]>,
      );
    case "quota":
      return Object.fromEntries(
        Object.entries(value as Readonly<Record<string, number>>)
          .filter(([, limit]) => limit !== undefined)
          .sort(([left], [right]) => left.localeCompare(right)),
      );
  }
}

function canonicalProviderCredentials(
  policy: NonNullable<PolicyConfig["providerCredentials"]>,
): NonNullable<PolicyConfig["providerCredentials"]> {
  const recipes = policy.allowedCredentialRecipes === undefined
    ? undefined
    : Array.from(
        new Map(
          policy.allowedCredentialRecipes.map((recipe) => [
            credentialRecipeKey(recipe),
            { id: recipe.id, authMode: recipe.authMode },
          ]),
        ).values(),
      ).sort(compareCredentialRecipes);
  const requiredProviders = sortedSet(policy.requiredProviders ?? []);
  const forbiddenConnectionIds = sortedSet(policy.forbiddenConnectionIds ?? []);
  return {
    ...(requiredProviders.length > 0 ? { requiredProviders } : {}),
    ...(policy.allowedConnectionIds !== undefined
      ? { allowedConnectionIds: sortedSet(policy.allowedConnectionIds) }
      : {}),
    ...(forbiddenConnectionIds.length > 0 ? { forbiddenConnectionIds } : {}),
    ...(policy.allowedConnectionScopes !== undefined
      ? {
          allowedConnectionScopes: sortedSet(
            policy.allowedConnectionScopes,
          ) as readonly ConnectionScopeKind[],
        }
      : {}),
    ...(recipes !== undefined ? { allowedCredentialRecipes: recipes } : {}),
    ...(policy.requiredCredentialCapabilities !== undefined
      ? {
          requiredCredentialCapabilities: sortedSet(
            policy.requiredCredentialCapabilities,
          ),
        }
      : {}),
    requireTemporary: policy.requireTemporary === true,
    requireTtlEnforced: policy.requireTtlEnforced === true,
  };
}

function sortedSet(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

/**
 * Whether the Workspace policy's ceiling is already contained in the
 * InstallConfig policy, i.e. baking would change nothing. A Workspace policy
 * without a ceiling is trivially baked. The comparison is over canonical JSON,
 * so a widened Workspace policy stays baked while a tightened one is unbaked
 * again (and is enforced again, see {@link effectiveProviderPolicy}).
 */
export function workspacePolicyBakedInto(
  workspacePolicy: PolicyConfig | undefined,
  installPolicy: PolicyConfig | undefined,
): boolean {
  const ceiling = workspacePolicyCeiling(workspacePolicy);
  if (!ceiling) return true;
  // A malformed ceiling is never baked: keep the old composition, which
  // refuses on it (fail closed), instead of reading it as no limit.
  if (malformedWorkspacePolicyKeys(ceiling).length > 0) return false;
  return canonicalPolicyJson(bakeWorkspacePolicy(ceiling, installPolicy)) ===
    canonicalPolicyJson(installPolicy);
}

/**
 * The provider policy a Capsule runs under (TASK-0118 P9.1-g).
 *
 * The Workspace policy stops being a runtime ceiling only for an
 * InstallConfig that already contains it ({@link workspacePolicyBakedInto});
 * the decision is then identical, because the InstallConfig policy alone is
 * at least as strict as the old composition. Every other InstallConfig keeps
 * the Workspace ceiling, so nothing is loosened before the operator bake tool
 * (`scripts/bake-workspace-policies.ts`) reports zero unbaked apps. Stage 9.5
 * removes the Workspace read once it does.
 */
export function effectiveProviderPolicy(
  workspacePolicy: PolicyConfig | undefined,
  installPolicy: PolicyConfig | undefined,
): PolicyConfig | undefined {
  return workspacePolicyBakedInto(workspacePolicy, installPolicy)
    ? mergePolicyConfigs(undefined, installPolicy)
    : mergePolicyConfigs(workspacePolicy, installPolicy);
}

/** Canonical JSON of a policy: sorted keys, `undefined` members dropped. */
export function canonicalPolicyJson(policy: PolicyConfig | undefined): string {
  return stableStringify(
    policy === undefined ? null : JSON.parse(JSON.stringify(policy)),
  );
}

function strictestDestructiveChanges(
  ceiling: PolicyConfig["destructiveChanges"] | undefined,
  local: PolicyConfig["destructiveChanges"] | undefined,
): PolicyConfig["destructiveChanges"] | undefined {
  if (!ceiling) return local;
  if (!local) return ceiling;
  return {
    requireExplicitConfirmation:
      ceiling.requireExplicitConfirmation === true ||
      local.requireExplicitConfirmation === true,
  };
}

function withoutDuplicateScopeRules(
  policy: PolicyConfig["scopeBoundary"] | undefined,
): PolicyConfig["scopeBoundary"] | undefined {
  if (!policy) return undefined;
  const seen = new Set<string>();
  const rules = policy.rules.filter((rule) => {
    const key = stableStringify(JSON.parse(JSON.stringify(rule)));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...(policy.mode !== undefined ? { mode: policy.mode } : {}), rules };
}

export function evaluateConfiguredProviderAllowlist(
  requiredProviders: readonly string[],
  policy: PolicyConfig | undefined,
  allowNoProviders: boolean,
): ProviderAllowlistResult | undefined {
  if (policy?.allowedProviders === undefined) return undefined;
  return evaluateProviderAllowlist(
    requiredProviders.filter(
      (provider) => !isOpenTofuBuiltinProviderSource(provider),
    ),
    {
      allowed: policy.allowedProviders,
      ...(allowNoProviders ? { allowNoProviders: true } : {}),
    },
  );
}

export function evaluateCompatibilityReportAgainstPolicy(
  report: CapsuleCompatibilityReport,
  policy: PolicyConfig | undefined,
): { readonly runnable: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  const providerReasons = compatibilityProviderPolicyReasons(report, policy);
  const resourceReasons = compatibilityResourcePolicyReasons(report, policy);
  const dataSourceReasons = compatibilityDataSourcePolicyReasons(
    report,
    policy,
  );
  const provisionerReasons = compatibilityProvisionerPolicyReasons(
    report,
    policy,
  );
  reasons.push(
    ...providerReasons,
    ...resourceReasons,
    ...dataSourceReasons,
    ...provisionerReasons,
  );
  if (report.level === "ready") {
    return { runnable: reasons.length === 0, reasons };
  }
  if (report.level === "needs_patch") {
    return {
      runnable: false,
      reasons: [
        `compatibility_report_not_runnable: report ${report.id} is ${report.level}`,
        ...reasons,
      ],
    };
  }
  const fatalFindings = report.findings.filter((finding) => {
    if (finding.severity !== "error") return false;
    if (finding.code === "provider_not_allowed") {
      return providerReasons.length > 0;
    }
    if (finding.code === "resource_type_not_allowed") {
      return resourceReasons.length > 0;
    }
    if (finding.code === "external_data_source_unsupported") {
      return dataSourceReasons.length > 0;
    }
    if (finding.code === "provisioner_unsupported") {
      return provisionerReasons.length > 0;
    }
    return true;
  });
  if (fatalFindings.length === 0 && reasons.length === 0) {
    return { runnable: true, reasons: [] };
  }
  return {
    runnable: false,
    reasons: [
      `compatibility_report_not_runnable: report ${report.id} is ${report.level}`,
      ...fatalFindings.map(
        (finding) => `capsule_gate_${finding.code}: ${finding.message}`,
      ),
      ...reasons,
    ],
  };
}

function compatibilityProviderPolicyReasons(
  report: CapsuleCompatibilityReport,
  policy: PolicyConfig | undefined,
): readonly string[] {
  const allowed = policy?.allowedProviders;
  const denied = report.providerPackages
    .filter(
      (providerPackage) =>
        !isOpenTofuBuiltinProviderSource(providerPackage.source),
    )
    .filter((providerPackage) => {
      if (allowed === undefined) return !providerPackage.allowed;
      const canonical = canonicalProviderAddress(providerPackage.source);
      return !allowed.some(
        (entry) => entry === "*" || providerMatches(canonical, entry),
      );
    });
  return denied.map(
    (providerPackage) =>
      `capsule provider ${providerPackage.source} is not allowed by Workspace/InstallConfig policy`,
  );
}

function compatibilityResourcePolicyReasons(
  report: CapsuleCompatibilityReport,
  policy: PolicyConfig | undefined,
): readonly string[] {
  const allowed = policy?.allowedResourceTypes;
  const denied = report.resources.filter((resource) => {
    if (allowed === undefined) return !resource.allowed;
    return !allowed.includes(resource.type);
  });
  return denied.map(
    (resource) =>
      `capsule resource type ${resource.type} is not allowed by Workspace/InstallConfig policy`,
  );
}

function compatibilityDataSourcePolicyReasons(
  report: CapsuleCompatibilityReport,
  policy: PolicyConfig | undefined,
): readonly string[] {
  const allowed = policy?.allowedDataSourceTypes;
  const denied = report.dataSources.filter((dataSource) => {
    if (allowed === undefined) return !dataSource.allowed;
    return !allowed.includes(dataSource.type);
  });
  return denied.map(
    (dataSource) =>
      `capsule data source ${dataSource.type} is not allowed by Workspace/InstallConfig policy`,
  );
}

function compatibilityProvisionerPolicyReasons(
  report: CapsuleCompatibilityReport,
  policy: PolicyConfig | undefined,
): readonly string[] {
  const allowed = policy?.allowedProvisionerTypes;
  const denied = report.provisioners.filter((provisioner) => {
    if (allowed === undefined) return !provisioner.allowed;
    return !allowed.includes(provisioner.type);
  });
  return denied.map(
    (provisioner) =>
      `capsule provisioner ${provisioner.type} is not allowed by Workspace/InstallConfig policy`,
  );
}

export function requiredProvidersFromCompatibilityReport(
  report: CapsuleCompatibilityReport | undefined,
  allowedProviders: readonly string[],
): readonly string[] {
  if (!report || report.providerPackages.length === 0) return [];
  return normalizeProviders(
    report.providerPackages
      .filter(
        (providerPackage) =>
          !isOpenTofuBuiltinProviderSource(providerPackage.source),
      )
      .filter((providerPackage) => providerPackage.allowed)
      .map((providerPackage) => providerPackage.source)
      .filter((source) => source.trim().length > 0)
      .map(canonicalProviderAddress)
      .filter((source) =>
        allowedProviders.some(
          (allowed) => allowed === "*" || providerMatches(source, allowed),
        ),
      ),
  );
}

function mergeProviderLockfilePolicy(
  ceiling: PolicyConfig["providerLockfile"] | undefined,
  local: PolicyConfig["providerLockfile"] | undefined,
): PolicyConfig["providerLockfile"] | undefined {
  if (!ceiling) return local;
  if (!local) return ceiling;
  return {
    requireDigest: ceiling.requireDigest || local.requireDigest,
  };
}

export function withDefaultProviderSupplyChainPolicy(
  policy: PolicyConfig | undefined,
  defaults: {
    readonly providerLockfileRequireDigest?: boolean;
    readonly providerInstallationRequireMirror?: boolean;
  } = {},
): PolicyConfig {
  const providerLockfileRequireDigest =
    defaults.providerLockfileRequireDigest ?? true;
  const providerInstallationRequireMirror =
    defaults.providerInstallationRequireMirror ?? true;
  return {
    ...(policy ?? {}),
    providerLockfile:
      policy?.providerLockfile ??
      (providerLockfileRequireDigest ? { requireDigest: true } : undefined),
    providerInstallation:
      policy?.providerInstallation ??
      (providerInstallationRequireMirror
        ? { requireMirror: true }
        : { requireMirror: false }),
    ...(policy?.providerCredentials
      ? { providerCredentials: policy.providerCredentials }
      : {}),
  };
}

function mergeProviderInstallationPolicy(
  ceiling: PolicyConfig["providerInstallation"] | undefined,
  local: PolicyConfig["providerInstallation"] | undefined,
): PolicyConfig["providerInstallation"] | undefined {
  if (!ceiling) return local;
  if (!local) return ceiling;
  return {
    requireMirror: ceiling.requireMirror || local.requireMirror,
  };
}

function mergeProviderCredentialPolicy(
  ceiling: PolicyConfig["providerCredentials"] | undefined,
  local: PolicyConfig["providerCredentials"] | undefined,
): PolicyConfig["providerCredentials"] | undefined {
  if (!ceiling && !local) return undefined;
  const requiredProviders = Array.from(
    new Set([
      ...(ceiling?.requiredProviders ?? []),
      ...(local?.requiredProviders ?? []),
    ]),
  ).sort();
  const allowedConnectionIds = intersectOptionalLists(
    ceiling?.allowedConnectionIds,
    local?.allowedConnectionIds,
  );
  const forbiddenConnectionIds = Array.from(
    new Set([
      ...(ceiling?.forbiddenConnectionIds ?? []),
      ...(local?.forbiddenConnectionIds ?? []),
    ]),
  ).sort();
  const allowedConnectionScopes = intersectOptionalLists(
    ceiling?.allowedConnectionScopes,
    local?.allowedConnectionScopes,
  ) as readonly ConnectionScopeKind[] | undefined;
  const allowedCredentialRecipes = intersectOptionalCredentialRecipes(
    ceiling?.allowedCredentialRecipes,
    local?.allowedCredentialRecipes,
  );
  const requiredCredentialCapabilities = unionRequiredCapabilities(
    ceiling?.requiredCredentialCapabilities,
    local?.requiredCredentialCapabilities,
  );
  return {
    ...(requiredProviders.length > 0 ? { requiredProviders } : {}),
    ...(allowedConnectionIds !== undefined ? { allowedConnectionIds } : {}),
    ...(forbiddenConnectionIds.length > 0 ? { forbiddenConnectionIds } : {}),
    ...(allowedConnectionScopes !== undefined
      ? { allowedConnectionScopes }
      : {}),
    ...(allowedCredentialRecipes !== undefined
      ? { allowedCredentialRecipes }
      : {}),
    ...(requiredCredentialCapabilities !== undefined
      ? { requiredCredentialCapabilities }
      : {}),
    requireTemporary:
      ceiling?.requireTemporary === true || local?.requireTemporary === true,
    requireTtlEnforced:
      ceiling?.requireTtlEnforced === true ||
      local?.requireTtlEnforced === true,
  };
}

/**
 * Evaluates the non-secret identity of a Provider Connection against the
 * composed InstallConfig/Workspace credential policy. A present allowlist is
 * closed: missing metadata is a rejection, never an implicit wildcard.
 */
export function evaluateProviderConnectionCredentialPolicy(
  connection: Pick<
    ProviderConnection,
    "id" | "scope" | "credentialRecipe" | "credentialVerification"
  >,
  policy: PolicyConfig | undefined,
): readonly string[] {
  const credentialPolicy = policy?.providerCredentials;
  if (!credentialPolicy) return [];
  const reasons: string[] = [];
  if (
    credentialPolicy.allowedConnectionIds !== undefined &&
    !credentialPolicy.allowedConnectionIds.includes(connection.id)
  ) {
    reasons.push(
      `provider credential policy rejects connection ${connection.id} (not in allowed connection ids)`,
    );
  }
  if (credentialPolicy.forbiddenConnectionIds?.includes(connection.id)) {
    reasons.push(
      `provider credential policy rejects connection ${connection.id} (forbidden connection id)`,
    );
  }
  if (
    credentialPolicy.allowedConnectionScopes !== undefined &&
    !credentialPolicy.allowedConnectionScopes.includes(connection.scope)
  ) {
    reasons.push(
      `provider credential policy rejects connection ${connection.id} scope ${connection.scope}`,
    );
  }
  if (credentialPolicy.allowedCredentialRecipes !== undefined) {
    const recipe = connection.credentialRecipe;
    const allowed = credentialPolicy.allowedCredentialRecipes.some(
      (candidate) =>
        candidate.id === recipe?.id && candidate.authMode === recipe?.authMode,
    );
    if (!allowed) {
      const actual = recipe
        ? `${recipe.id}:${recipe.authMode}`
        : "missing";
      reasons.push(
        `provider credential policy rejects connection ${connection.id} credential recipe ${actual}`,
      );
    }
  }
  if (credentialPolicy.requiredCredentialCapabilities !== undefined) {
    const verification = connection.credentialVerification;
    const capabilities =
      verification?.kind === "takosumi.credential-verification@v1"
        ? new Set(verification.capabilities ?? [])
        : new Set<string>();
    const missing = credentialPolicy.requiredCredentialCapabilities.filter(
      (capability) => !capabilities.has(capability),
    );
    if (missing.length > 0) {
      reasons.push(
        `provider credential policy rejects connection ${connection.id} credential capabilities missing ${missing.join(", ")}`,
      );
    }
  }
  return reasons;
}

export interface ProviderLockfilePolicyResult {
  readonly digestPresent: boolean;
  readonly reasons: readonly string[];
}

export interface ProviderInstallationPolicyResult {
  readonly requireMirror: boolean;
  readonly evidenceCount: number;
  readonly missingEvidenceProviders: readonly string[];
  readonly unmirroredProviders: readonly string[];
  readonly reasons: readonly string[];
}

export interface ProviderCredentialMintPolicyResult {
  readonly reasons: readonly string[];
}

export function evaluateProviderCredentialMintPolicy(
  evidence: readonly ProviderCredentialMintEvidence[],
  policy: PolicyConfig | undefined,
  requiredProviders: readonly string[] = [],
  expectedCredentialEvidenceCount = 0,
  resolvedConnections: readonly Pick<
    ProviderConnection,
    "id" | "scope" | "credentialRecipe" | "credentialVerification"
  >[] = [],
): ProviderCredentialMintPolicyResult {
  const credentialPolicy = policy?.providerCredentials;
  if (!credentialPolicy) return { reasons: [] };
  const reasons: string[] = [];
  for (const connection of resolvedConnections) {
    reasons.push(
      ...evaluateProviderConnectionCredentialPolicy(connection, policy),
    );
  }
  if (credentialPolicy.allowedConnectionIds !== undefined) {
    const allowed = new Set(credentialPolicy.allowedConnectionIds);
    const disallowed = evidence
      .filter((row) => !allowed.has(row.connectionId))
      .map((row) => row.connectionId)
      .sort();
    if (disallowed.length > 0) {
      reasons.push(
        `provider credential policy rejects unselected connections: ${[...new Set(disallowed)].join(", ")}`,
      );
    }
  }
  if (credentialPolicy.forbiddenConnectionIds !== undefined) {
    const forbidden = new Set(credentialPolicy.forbiddenConnectionIds);
    const selected = evidence
      .filter((row) => forbidden.has(row.connectionId))
      .map((row) => row.connectionId)
      .sort();
    if (selected.length > 0) {
      reasons.push(
        `provider credential policy rejects forbidden connections: ${[...new Set(selected)].join(", ")}`,
      );
    }
  }
  if (
    expectedCredentialEvidenceCount > 0 &&
    evidence.length < expectedCredentialEvidenceCount
  ) {
    reasons.push(
      `provider credential policy requires mint evidence for providers: ${requiredProviders
        .slice()
        .sort()
        .join(", ")}`,
    );
  }
  if (expectedCredentialEvidenceCount > 0) {
    const requiredProviderSet = Array.from(
      new Set(requiredProviders.map(canonicalProviderAddress)),
    );
    const evidenceProviders = evidence.map((row) => row.provider);
    const missingEvidenceProviders = requiredProviderSet
      .filter(
        (provider) =>
          !evidenceProviders.some((evidenceProvider) =>
            providerMatches(provider, evidenceProvider),
          ),
      )
      .sort();
    if (missingEvidenceProviders.length > 0) {
      reasons.push(
        `provider credential policy requires mint evidence for providers: ${missingEvidenceProviders.join(", ")}`,
      );
    }
  }
  const nonTemporary = evidence.filter((row) => row.temporary !== true);
  if (credentialPolicy.requireTemporary === true && nonTemporary.length > 0) {
    reasons.push(
      `provider credential policy requires temporary credentials; non-temporary providers: ${credentialEvidenceProviderList(nonTemporary)}`,
    );
  }
  const nonTtl = evidence.filter((row) => row.ttlEnforced !== true);
  if (credentialPolicy.requireTtlEnforced === true && nonTtl.length > 0) {
    reasons.push(
      `provider credential policy requires ttl-enforced credentials; providers without ttl evidence: ${credentialEvidenceProviderList(nonTtl)}`,
    );
  }
  return { reasons };
}

function credentialEvidenceProviderList(
  evidence: readonly ProviderCredentialMintEvidence[],
): string {
  return [
    ...new Set(
      evidence.map(
        (row) =>
          `${row.provider}:${row.issuer ?? "unknown"}:${row.connectionId}`,
      ),
    ),
  ]
    .sort()
    .join(", ");
}

export function evaluateProviderLockfilePolicy(
  providerLockDigest: string | undefined,
  policy: PolicyConfig | undefined,
  requiredProviders: readonly string[],
): ProviderLockfilePolicyResult | undefined {
  if (policy?.providerLockfile?.requireDigest !== true) return undefined;
  if (
    requiredProviders.every((provider) =>
      isOpenTofuBuiltinProviderSource(provider),
    )
  ) {
    return undefined;
  }
  const digestPresent =
    providerLockDigest !== undefined && providerLockDigest.trim().length > 0;
  return {
    digestPresent,
    reasons: digestPresent
      ? []
      : [
          "provider lockfile digest is required by policy but was not returned by the runner",
        ],
  };
}

export function evaluateProviderInstallationPolicy(
  evidence: readonly ProviderInstallationEvidence[] | undefined,
  policy: PolicyConfig | undefined,
  requiredProviders: readonly string[],
): ProviderInstallationPolicyResult | undefined {
  if (policy?.providerInstallation?.requireMirror !== true) return undefined;
  const installableProviders = requiredProviders.filter(
    (provider) => !isOpenTofuBuiltinProviderSource(provider),
  );
  if (installableProviders.length === 0) {
    return {
      requireMirror: true,
      evidenceCount: 0,
      missingEvidenceProviders: [],
      unmirroredProviders: [],
      reasons: [],
    };
  }
  const rows = (evidence ?? []).filter(
    (row) => !isOpenTofuBuiltinProviderSource(row.provider),
  );
  const requiredProviderSet = new Set(
    installableProviders.map(canonicalProviderAddress),
  );
  const evidenceByProvider = new Map(
    rows.map((row) => [canonicalProviderAddress(row.provider), row]),
  );
  const requiredCanonicalProviders = Array.from(requiredProviderSet).sort();
  const missingEvidenceProviders = requiredCanonicalProviders
    .filter((provider) => !evidenceByProvider.has(provider))
    .sort();
  const unmirroredProviders = rows
    .filter(
      (row) =>
        requiredProviderSet.has(canonicalProviderAddress(row.provider)) &&
        (row.mirrored !== true ||
          row.attested !== true ||
          row.installationMethod !== "filesystem_mirror"),
    )
    .map((row) => canonicalProviderAddress(row.provider))
    .sort();
  const reasons: string[] = [];
  if (rows.length === 0) {
    reasons.push(
      "provider installation attestation is required by policy but was not returned by the runner",
    );
  }
  if (missingEvidenceProviders.length > 0) {
    reasons.push(
      `provider installation attestation is missing for required providers: ${missingEvidenceProviders.join(", ")}`,
    );
  }
  if (unmirroredProviders.length > 0) {
    reasons.push(
      `provider mirror is required by policy but these providers were not attested as installed from the filesystem mirror: ${unmirroredProviders.join(", ")}`,
    );
  }
  return {
    requireMirror: true,
    evidenceCount: rows.length,
    missingEvidenceProviders,
    unmirroredProviders,
    reasons,
  };
}

export function compactLayeredPolicy(input: {
  readonly provider?: ProviderAllowlistResult;
  readonly providerLockfile?: ProviderLockfilePolicyResult;
  readonly providerInstallation?: ProviderInstallationPolicyResult;
}): {
  readonly provider?: ProviderAllowlistResult;
  readonly providerLockfile?: ProviderLockfilePolicyResult;
  readonly providerInstallation?: ProviderInstallationPolicyResult;
} {
  return {
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.providerLockfile
      ? { providerLockfile: input.providerLockfile }
      : {}),
    ...(input.providerInstallation
      ? { providerInstallation: input.providerInstallation }
      : {}),
  };
}

function intersectOptionalLists(
  ceiling: readonly string[] | undefined,
  local: readonly string[] | undefined,
): readonly string[] | undefined {
  if (ceiling === undefined) return local;
  if (local === undefined) return ceiling;
  const allowed = new Set(ceiling);
  return local.filter((entry) => allowed.has(entry)).sort();
}

function unionRequiredCapabilities(
  ceiling: readonly string[] | undefined,
  local: readonly string[] | undefined,
): readonly string[] | undefined {
  if (ceiling === undefined && local === undefined) return undefined;
  return Array.from(
    new Set([...(ceiling ?? []), ...(local ?? [])]),
  ).sort();
}

function intersectOptionalCredentialRecipes(
  ceiling: AllowedCredentialRecipes | undefined,
  local: AllowedCredentialRecipes | undefined,
): AllowedCredentialRecipes | undefined {
  if (ceiling === undefined) return local;
  if (local === undefined) return ceiling;
  const allowed = new Set(ceiling.map(credentialRecipeKey));
  return local
    .filter((entry) => allowed.has(credentialRecipeKey(entry)))
    .sort(compareCredentialRecipes);
}

function credentialRecipeKey(recipe: { id: string; authMode: string }): string {
  return `${recipe.id}\u0000${recipe.authMode}`;
}

function compareCredentialRecipes(
  left: { id: string; authMode: string },
  right: { id: string; authMode: string },
): number {
  return (
    left.id.localeCompare(right.id) || left.authMode.localeCompare(right.authMode)
  );
}

function mergeScopeBoundary(
  ceiling: PolicyConfig["scopeBoundary"] | undefined,
  local: PolicyConfig["scopeBoundary"] | undefined,
): PolicyConfig["scopeBoundary"] | undefined {
  const normalizedCeiling = normalizeScopeBoundaryPolicy(ceiling);
  const normalizedLocal = normalizeScopeBoundaryPolicy(local);
  if (!normalizedCeiling) return normalizedLocal;
  if (!normalizedLocal) return normalizedCeiling;
  return {
    mode:
      normalizedCeiling.mode === "strict" || normalizedLocal.mode === "strict"
        ? "strict"
        : (normalizedCeiling.mode ?? normalizedLocal.mode),
    // Both layers remain independently enforceable. Concatenation is the
    // provider-neutral equivalent of intersecting each provider-specific list.
    rules: [...normalizedCeiling.rules, ...normalizedLocal.rules],
  };
}

function mergeQuota(
  ceiling: Readonly<Record<string, number>> | undefined,
  local: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> | undefined {
  if (!ceiling) return local;
  if (!local) return ceiling;
  const out: Record<string, number> = {};
  const keys = new Set([...Object.keys(ceiling), ...Object.keys(local)]);
  for (const key of keys) {
    const a = ceiling[key];
    const b = local[key];
    out[key] = a === undefined ? b! : b === undefined ? a : Math.min(a, b);
  }
  return out;
}
