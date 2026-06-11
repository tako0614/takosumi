/**
 * Provider / Capsule policy evaluation for the deploy-control domain.
 *
 * Pure functions over contract types that layer Space policy and InstallConfig
 * policy, gate a Capsule Compatibility Report, and evaluate the provider
 * lockfile / installation-mirror / credential-mint policies. These were lifted
 * verbatim out of `mod.ts`; they take no controller or store state. The
 * controller composes them with run-execution ceremony in `mod.ts`.
 */

import type { PolicyConfig } from "@takosumi/internal/deploy-control-api";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";
import { providerMatches } from "./policy.ts";
import { normalizeProviders } from "./validation.ts";
import {
  evaluateProviderAllowlist,
  type ProviderAllowlistResult,
} from "takosumi-policy";
import type { ProviderInstallationEvidence } from "./mod.ts";

/**
 * Canonicalizes a provider rule to a fully-qualified OpenTofu registry address.
 * A bare `namespace/type` (the OpenTofu source form templates declare) is
 * prefixed with the default registry host; an already-qualified address (3+
 * segments) is returned unchanged.
 */
export function canonicalProviderAddress(rule: string): string {
  const segments = rule.split("/").filter((part) => part.length > 0);
  if (segments.length === 2) return `registry.opentofu.org/${rule}`;
  return rule;
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

export function evaluateConfiguredProviderAllowlist(
  requiredProviders: readonly string[],
  policy: PolicyConfig | undefined,
  allowNoProviders: boolean,
): ProviderAllowlistResult | undefined {
  if (policy?.allowedProviders === undefined) return undefined;
  return evaluateProviderAllowlist(requiredProviders, {
    allowed: policy.allowedProviders,
    ...(allowNoProviders ? { allowNoProviders: true } : {}),
  });
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
  if (report.level === "ready" || report.level === "auto_capsulized") {
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
  const denied = report.providers.filter((provider) => {
    if (allowed === undefined) return !provider.allowed;
    const canonical = canonicalProviderAddress(provider.source);
    return !allowed.some(
      (entry) => entry === "*" || providerMatches(canonical, entry),
    );
  });
  return denied.map(
    (provider) =>
      `capsule provider ${provider.source} is not allowed by Space/InstallConfig policy`,
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
      `capsule resource type ${resource.type} is not allowed by Space/InstallConfig policy`,
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
      `capsule data source ${dataSource.type} is not allowed by Space/InstallConfig policy`,
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
      `capsule provisioner ${provisioner.type} is not allowed by Space/InstallConfig policy`,
  );
}

export function requiredProvidersFromCompatibilityReport(
  report: CapsuleCompatibilityReport | undefined,
  allowedProviders: readonly string[],
): readonly string[] {
  if (!report || report.providers.length === 0) return [];
  return normalizeProviders(
    report.providers
      .filter((provider) => provider.allowed)
      .map((provider) => provider.source)
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
): PolicyConfig {
  return {
    ...(policy ?? {}),
    providerLockfile: mergeProviderLockfilePolicy(
      { requireDigest: true },
      policy?.providerLockfile,
    ),
    providerInstallation: mergeProviderInstallationPolicy(
      { requireMirror: true },
      policy?.providerInstallation,
    ),
    providerCredentials: mergeProviderCredentialPolicy(
      {
        requireTemporary: true,
        requireTtlEnforced: true,
      },
      policy?.providerCredentials,
    ),
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
  if (!ceiling) return local;
  if (!local) return ceiling;
  return {
    requireTemporary:
      ceiling.requireTemporary === true || local.requireTemporary === true,
    requireTtlEnforced:
      ceiling.requireTtlEnforced === true || local.requireTtlEnforced === true,
    requireRootOnly:
      ceiling.requireRootOnly === true || local.requireRootOnly === true,
  };
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
): ProviderCredentialMintPolicyResult {
  const credentialPolicy = policy?.providerCredentials;
  if (!credentialPolicy) return { reasons: [] };
  const reasons: string[] = [];
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
            providerMatches(provider, evidenceProvider)
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
  const nonRootOnly = evidence.filter((row) => row.rootOnly !== true);
  if (credentialPolicy.requireRootOnly === true && nonRootOnly.length > 0) {
    reasons.push(
      `provider credential policy requires generated-root-only delivery; non-root-only providers: ${credentialEvidenceProviderList(nonRootOnly)}`,
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
          `${row.provider}:${row.issuer ?? "unknown"}:${row.delivery}:${
            row.connectionId
          }`,
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
  if (requiredProviders.length === 0) return undefined;
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
  if (requiredProviders.length === 0) {
    return {
      requireMirror: true,
      evidenceCount: 0,
      missingEvidenceProviders: [],
      unmirroredProviders: [],
      reasons: [],
    };
  }
  const rows = evidence ?? [];
  const requiredProviderSet = new Set(
    requiredProviders.map(canonicalProviderAddress),
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

function mergeScopeBoundary(
  ceiling: PolicyConfig["scopeBoundary"] | undefined,
  local: PolicyConfig["scopeBoundary"] | undefined,
): PolicyConfig["scopeBoundary"] | undefined {
  if (!ceiling) return local;
  if (!local) return ceiling;
  const cloudflare = mergeScopeProvider(ceiling.cloudflare, local.cloudflare);
  const aws = mergeScopeProvider(ceiling.aws, local.aws);
  return {
    mode:
      ceiling.mode === "strict" || local.mode === "strict"
        ? "strict"
        : (ceiling.mode ?? local.mode),
    ...(cloudflare ? { cloudflare } : {}),
    ...(aws ? { aws } : {}),
  };
}

function mergeScopeProvider<
  T extends Readonly<Record<string, readonly string[] | undefined>>,
>(ceiling: T | undefined, local: T | undefined): T | undefined {
  if (!ceiling) return local;
  if (!local) return ceiling;
  const out: Record<string, readonly string[]> = {};
  const keys = new Set([...Object.keys(ceiling), ...Object.keys(local)]);
  for (const key of keys) {
    const merged = intersectOptionalLists(ceiling[key], local[key]);
    if (merged !== undefined) out[key] = merged;
  }
  return out as T;
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
