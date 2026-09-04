import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import {
  parseRepositoryModulesSnapshot,
  type RepositoryModuleRootProviderRequirement,
  type Source,
  type SourceSnapshot,
} from "takosumi-contract/sources";
import type { InstallConfig } from "takosumi-contract/install-configs";
import {
  isRepositoryManifestInterfaceCapableApiVersion,
  type RepositoryManifestDocument,
} from "takosumi-contract/repository-manifest";
import type { JsonValue } from "takosumi-contract/types";
import { resolveCapsuleInterfaceBlueprintInstallingPrincipal } from "takosumi-contract/interfaces";

import type { ControlPlaneOperations } from "../control-operations.ts";
import {
  compileRepositoryInstallUx,
  type RepositoryInstallUxDiagnostic,
} from "../../../../core/domains/capsules/repository_install_ux_compiler.ts";
import {
  stableJsonDigest,
  stableStringify,
} from "../../../../core/adapters/source/digest.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import {
  installConfigStoreValue,
  isPlainJsonObject,
  modulePathValue,
} from "./parse.ts";

export interface RepoOwnedStoreHydrationInput {
  readonly operations: ControlPlaneOperations;
  readonly source: Source;
  readonly sourceSnapshot: SourceSnapshot | undefined;
  readonly storeMetadata: InstallConfig["store"] | undefined;
  readonly modulePath: string | undefined;
}

export interface RepoOwnedStoreHydrationResult {
  readonly storeMetadata: InstallConfig["store"] | undefined;
  readonly modulePath: string | undefined;
}

export interface RepoOwnedInstallConfigAdoptionInput {
  readonly operations: ControlPlaneOperations;
  readonly source: Source;
  readonly sourceSnapshot: SourceSnapshot | undefined;
  readonly baseConfig: InstallConfig;
  readonly modulePath: string | undefined;
  readonly capsuleName: string;
  readonly workspaceId: string;
  readonly reviewedVariables?: Readonly<Record<string, JsonValue>>;
  /**
   * Explicit service-side declarations reviewed in the authenticated Capsule
   * create request. v1 keeps its replacement behavior; v2 merges them with
   * the repository proposal and rejects stable-key conflicts.
   */
  readonly reviewedInterfaceBlueprints?: InstallConfig["interfaceBlueprints"];
  readonly reviewedOutputAllowlist?: InstallConfig["outputAllowlist"];
  /** Exact authenticated Principal used only to resolve v2 binding requests. */
  readonly installingPrincipalId?: string;
  readonly compatibilityReport?: CapsuleCompatibilityReport;
  readonly requireReviewedValues?: boolean;
}

export type RepoOwnedInstallConfigAdoptionDiagnostic =
  | RepositoryInstallUxDiagnostic
  | {
      readonly code:
        | "repository_install_module_index_unavailable"
        | "repository_install_module_selection_required"
        | "repository_install_ux_oidc_endpoint_conflict"
        | "repository_install_ux_interface_blueprint_conflict"
        | "repository_install_ux_output_allowlist_conflict"
        | "repository_install_ux_runtime_binding_profile_conflict"
        | "repository_install_ux_installing_principal_invalid"
        | "repository_install_ux_manifest_api_version_required";
      readonly message: string;
    };

export type RepoOwnedInstallConfigAdoptionResult =
  | { readonly status: "absent" }
  | {
      readonly status: "invalid";
      readonly diagnostic: RepoOwnedInstallConfigAdoptionDiagnostic;
    }
  | {
      readonly status: "accepted";
      readonly variablePresentation: InstallConfig["variablePresentation"];
      readonly installExperience: InstallConfig["installExperience"];
      readonly variableMapping: InstallConfig["variableMapping"];
      readonly interfaceBlueprints: InstallConfig["interfaceBlueprints"];
      readonly requiredInterfaces?: InstallConfig["requiredInterfaces"];
      readonly outputAllowlist: InstallConfig["outputAllowlist"];
      /** Repository sourceBuild is a proposal; an existing base value wins. */
      readonly sourceBuild?: InstallConfig["sourceBuild"];
      /**
       * Private runtime binding materialization. An absent repository proposal
       * preserves the operator/base profile; a differing proposal is rejected
       * rather than merged field-by-field.
       */
      readonly runtimeBindingMaterialization?:
        InstallConfig["runtimeBindingMaterialization"];
      /** Exact repository module compiled into the derived InstallConfig. */
      readonly modulePath: string;
      /**
       * Provider tuples captured by source sync for the selected module. This
       * is advisory preflight evidence; compatibility/init remains the binding
       * authority for provider resolution.
       */
      readonly rootProviderRequirements: readonly RepositoryModuleRootProviderRequirement[];
      readonly sourceSnapshotId: string;
      readonly digest: string;
      readonly repositoryManifestApiVersion: RepositoryManifestDocument["apiVersion"];
    };

/**
 * Reads the repository's optional presentation document without granting it
 * execution authority. Only display text/icon can be adopted. The selected
 * module path, inputs, projections, Output policy, lifecycle actions, artifact
 * coordinates, domain defaults, and OIDC wiring stay in the Source and
 * Takosumi-owned InstallConfig.
 */
export async function hydrateRepoOwnedStoreConfig(
  input: RepoOwnedStoreHydrationInput,
): Promise<RepoOwnedStoreHydrationResult> {
  const inspectionModulePath =
    input.modulePath ??
    modulePathValue(input.storeMetadata?.source?.path) ??
    undefined;
  const metadata = await readRepoOwnedTcsMetadata({
    operations: input.operations,
    sourceSnapshot: input.sourceSnapshot,
    modulePath: inspectionModulePath,
  });
  if (!metadata) {
    return {
      storeMetadata: input.storeMetadata,
      modulePath: input.modulePath,
    };
  }

  const mergedStore = repoPresentationStoreMetadata({
    metadata,
    listing: input.storeMetadata,
  });
  return {
    storeMetadata: mergedStore ?? input.storeMetadata,
    modulePath: input.modulePath,
  };
}

export async function latestSourceSnapshotForSource(
  operations: ControlPlaneOperations,
  source: Source,
): Promise<SourceSnapshot | undefined> {
  try {
    const { snapshots } = await operations.listSourceSnapshots(source.id);
    return [...snapshots]
      .filter(
        (snapshot): snapshot is SourceSnapshot =>
          snapshot.origin === "git" &&
          snapshot.sourceId === source.id &&
          snapshot.ref === source.defaultRef &&
          snapshot.path === source.defaultPath &&
          Boolean(snapshot.resolvedCommit.trim()),
      )
      .sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))[0];
  } catch {
    return undefined;
  }
}

/**
 * Validate and compile the immutable repository proposal into DB-owned
 * InstallConfig fields. Invalid optional metadata disables repository
 * assistance and preserves the ordinary generic install flow unless the
 * operator policy requires an exact manifest API version.
 */
export async function adoptRepoOwnedInstallConfig(
  input: RepoOwnedInstallConfigAdoptionInput,
): Promise<RepoOwnedInstallConfigAdoptionResult> {
  const observation = input.sourceSnapshot?.repositoryManifest;
  const requiredManifestApiVersion =
    input.baseConfig.policy.repositoryInstallUx?.requiredManifestApiVersion;

  // Module selection is always grounded in the immutable source-sync index,
  // even when the optional repository manifest is absent. An old/malformed
  // snapshot therefore cannot fall back to Source/default or base config paths.
  const selectedModule = resolveRepoOwnedInstallModulePath({
    sourceSnapshot: input.sourceSnapshot,
    modulePath: input.modulePath,
  });
  if (!selectedModule.ok) {
    return { status: "invalid", diagnostic: selectedModule.diagnostic };
  }
  if (!observation || observation.status === "absent") {
    if (requiredManifestApiVersion) {
      return {
        status: "invalid",
        diagnostic: {
          code: "repository_install_ux_manifest_api_version_required",
          message: `Repository install UX requires manifest API ${requiredManifestApiVersion}; observed absent.`,
        },
      };
    }
    return { status: "absent" };
  }
  if (observation.status === "invalid") {
    if (requiredManifestApiVersion) {
      return {
        status: "invalid",
        diagnostic: {
          code: "repository_install_ux_manifest_api_version_required",
          message: `Repository install UX requires manifest API ${requiredManifestApiVersion}; observed invalid repository metadata.`,
        },
      };
    }
    // Manifest metadata is optional assistance. Keep the generic scanner
    // install path available while disabling malformed presentation/UX data.
    return { status: "absent" };
  }
  if (
    requiredManifestApiVersion &&
    observation.document.apiVersion !== requiredManifestApiVersion
  ) {
    return {
      status: "invalid",
      diagnostic: {
        code: "repository_install_ux_manifest_api_version_required",
        message: `Repository install UX requires manifest API ${requiredManifestApiVersion}; observed ${observation.document.apiVersion}.`,
      },
    };
  }

  // The manifest can assist only an actual file-derived module. A valid
  // manifest with no matching entry is simply absent for this module; it does
  // not make the real OpenTofu configuration uninstallable.
  const manifestModulePath = repositoryManifestModulePath(
    input.sourceSnapshot!,
    selectedModule.modulePath,
  );
  if (
    !manifestModulePath ||
    !Object.prototype.hasOwnProperty.call(
      observation.document.install.modules,
      manifestModulePath,
    )
  ) {
    return { status: "absent" };
  }

  const installingPrincipalId = input.installingPrincipalId?.trim();
  if (
    input.installingPrincipalId !== undefined &&
    installingPrincipalId === ""
  ) {
    return {
      status: "invalid",
      diagnostic: {
        code: "repository_install_ux_installing_principal_invalid",
        message:
          "Repository install UX review requires an exact authenticated installing Principal.",
      },
    };
  }

  const modulePath = selectedModule.modulePath;
  const manifestDocument = remapRepositoryManifestModule(
    observation.document,
    manifestModulePath,
    modulePath,
  );
  let compatibilityReport = input.compatibilityReport;
  if (!compatibilityReport) {
    try {
      compatibilityReport = (
        await input.operations.createSourceCompatibilityCheck(input.source.id, {
          sourceSnapshotId: input.sourceSnapshot!.id,
          modulePath,
          installConfigId: input.baseConfig.id,
        })
      ).report;
    } catch {
      return {
        status: "invalid",
        diagnostic: {
          code: "repository_install_ux_compatibility_report_mismatch",
          message:
            "Takosumi could not produce an exact compatibility report for the repository install UX.",
        },
      };
    }
  }
  const compiled = compileRepositoryInstallUx({
    document: manifestDocument,
    sourceSnapshotId: input.sourceSnapshot!.id,
    modulePath,
    compatibilityReport,
    capsuleName: input.capsuleName,
    workspaceId: input.workspaceId,
    ...(input.reviewedVariables
      ? { reviewedVariables: input.reviewedVariables }
      : {}),
    ...(input.requireReviewedValues !== undefined
      ? { requireReviewedValues: input.requireReviewedValues }
      : {}),
    policy: {
      ...(input.baseConfig.policy?.repositoryInstallUx
        ?.allowedRequirementKinds
        ? {
            allowedRequirementKinds:
              input.baseConfig.policy.repositoryInstallUx
                .allowedRequirementKinds,
          }
        : {}),
      ...(input.baseConfig.policy?.repositoryInstallUx?.allowedOidcScopes
        ? {
            allowedOidcScopes:
              input.baseConfig.policy.repositoryInstallUx.allowedOidcScopes,
          }
        : {}),
      allowedInterfacePermissions:
        input.baseConfig.policy?.repositoryInstallUx
          ?.allowedInterfacePermissions ?? [],
      ...(input.baseConfig.policy?.repositoryInstallUx
        ?.allowedInterfaceDeliveryTypes
        ? {
            allowedInterfaceDeliveryTypes:
              input.baseConfig.policy.repositoryInstallUx
                .allowedInterfaceDeliveryTypes,
          }
        : {}),
      ...(input.baseConfig.policy?.repositoryInstallUx
        ?.allowedInterfaceBindingProfiles
        ? {
            allowedInterfaceBindingProfiles:
              input.baseConfig.policy.repositoryInstallUx
                .allowedInterfaceBindingProfiles,
          }
        : {}),
    },
  });
  if (!compiled.ok) {
    return { status: "invalid", diagnostic: compiled.diagnostic };
  }

  const repositoryManifestApiVersion = observation.document.apiVersion;
  const proposedInterfaceBlueprints =
    resolveInterfaceInstallingPrincipalBlueprints(
      repositoryManifestApiVersion,
      compiled.compiled.interfaceBlueprints,
      installingPrincipalId,
    ) ?? [];

  const interfaceBlueprints = mergeReviewedInterfaceBlueprints({
    repositoryManifestApiVersion,
    base: resolveInterfaceInstallingPrincipalBlueprints(
      repositoryManifestApiVersion,
      input.baseConfig.interfaceBlueprints,
      installingPrincipalId,
    ),
    proposed: proposedInterfaceBlueprints,
    reviewed: resolveInterfaceInstallingPrincipalBlueprints(
      repositoryManifestApiVersion,
      input.reviewedInterfaceBlueprints,
      installingPrincipalId,
    ),
  });
  if (!interfaceBlueprints.ok) {
    return { status: "invalid", diagnostic: interfaceBlueprints.diagnostic };
  }
  const outputAllowlist = mergeReviewedOutputAllowlist({
    repositoryManifestApiVersion,
    base: input.baseConfig.outputAllowlist,
    proposed: compiled.compiled.outputAllowlist,
    reviewed: input.reviewedOutputAllowlist,
  });
  if (!outputAllowlist.ok) {
    return { status: "invalid", diagnostic: outputAllowlist.diagnostic };
  }
  const sourceBuild =
    input.baseConfig.sourceBuild ?? compiled.compiled.sourceBuild;
  const installExperience = mergeInstallExperience(
    compiled.compiled.installExperience,
    input.baseConfig.installExperience,
  );
  if (!installExperience.ok) {
    return { status: "invalid", diagnostic: installExperience.diagnostic };
  }
  const runtimeBindingMaterialization = mergeRuntimeBindingMaterialization(
    input.baseConfig.runtimeBindingMaterialization,
    compiled.compiled.runtimeBindingMaterialization,
  );
  if (!runtimeBindingMaterialization.ok) {
    return {
      status: "invalid",
      diagnostic: runtimeBindingMaterialization.diagnostic,
    };
  }

  return {
    status: "accepted",
    variablePresentation: mergeVariablePresentation(
      compiled.compiled.variablePresentation,
      input.baseConfig.variablePresentation,
    ),
    installExperience: installExperience.value,
    // Repository-derived and reviewed values are proposals. Existing
    // service/operator values retain final authority on collisions.
    variableMapping: mergeRecords(
      compiled.compiled.variableMapping,
      input.baseConfig.variableMapping,
    ),
    interfaceBlueprints: interfaceBlueprints.value,
    ...(compiled.compiled.requiredInterfaces.length > 0
      ? { requiredInterfaces: compiled.compiled.requiredInterfaces }
      : {}),
    outputAllowlist: outputAllowlist.value,
    ...(sourceBuild ? { sourceBuild } : {}),
    ...(runtimeBindingMaterialization.value
      ? { runtimeBindingMaterialization: runtimeBindingMaterialization.value }
      : {}),
    sourceSnapshotId: input.sourceSnapshot!.id,
    digest: observation.digest,
    repositoryManifestApiVersion,
    modulePath,
    rootProviderRequirements: selectedModule.rootProviderRequirements,
  };
}

export type RepoOwnedInstallConfigPreviewResult =
  | { readonly status: "absent" }
  | {
      readonly status: "invalid";
      readonly diagnostic: RepoOwnedInstallConfigAdoptionDiagnostic;
    }
  | {
      readonly status: "accepted";
      readonly installConfig: InstallConfig;
    };

/**
 * Persist an idempotent DB-owned preview before the dashboard renders setup.
 * Its identity is derived from the exact snapshot/module/base configuration and
 * compiled result, so retries cannot create unbounded catalog rows.
 */
export async function previewRepoOwnedInstallConfig(
  input: RepoOwnedInstallConfigAdoptionInput & {
    readonly compatibilityReport: CapsuleCompatibilityReport;
    readonly installingPrincipalId: string;
    /** Optional coordinator scope for one create-only initial authority. */
    readonly identityScope?: string;
    /** False returns the exact row without writing it ahead of the atomic create. */
    readonly persist?: boolean;
  },
): Promise<RepoOwnedInstallConfigPreviewResult> {
  const adoption = await adoptRepoOwnedInstallConfig({
    ...input,
    requireReviewedValues: input.requireReviewedValues ?? false,
  });
  if (adoption.status !== "accepted") return adoption;
  // The Store base config is only a policy ceiling. Its legacy presentation
  // paths must not leak into the workspace-scoped config or choose the
  // executable module. Bind the derived config to the exact synced Source;
  // `modulePath` below independently records the repository-selected module.
  const sourceSelector = {
    url: input.source.url,
    path: input.source.defaultPath,
  };

  const selectedPath = adoption.modulePath;
  const {
    id: _baseId,
    name: _baseName,
    workspaceId: _baseWorkspaceId,
    internal: _baseInternal,
    modulePath: _baseModulePath,
    sourceSelector: _baseSourceSelector,
    store: _baseStore,
    createdAt: _baseCreatedAt,
    updatedAt: _baseUpdatedAt,
    ...baseConfigMaterial
  } = input.baseConfig;
  const installConfigMaterial: Omit<
    InstallConfig,
    "id" | "createdAt" | "updatedAt"
  > = {
    ...baseConfigMaterial,
    workspaceId: input.workspaceId,
    name: `${input.capsuleName}-repository-install`,
    internal: {
      reason: "per_install_overrides",
      sourceSnapshotId: adoption.sourceSnapshotId,
      repositoryInstallUxDigest: adoption.digest,
    },
    variablePresentation: adoption.variablePresentation,
    installExperience: adoption.installExperience,
    variableMapping: adoption.variableMapping,
    ...(adoption.sourceBuild ? { sourceBuild: adoption.sourceBuild } : {}),
    outputAllowlist: adoption.outputAllowlist,
    ...(adoption.interfaceBlueprints !== undefined
      ? { interfaceBlueprints: adoption.interfaceBlueprints }
      : {}),
    ...(adoption.requiredInterfaces !== undefined
      ? { requiredInterfaces: adoption.requiredInterfaces }
      : {}),
    ...(adoption.runtimeBindingMaterialization !== undefined
      ? { runtimeBindingMaterialization: adoption.runtimeBindingMaterialization }
      : {}),
    sourceSelector,
    modulePath: selectedPath,
  };
  const digest = await stableJsonDigest({
    baseInstallConfigId: input.baseConfig.id,
    ...(input.identityScope ? { identityScope: input.identityScope } : {}),
    installConfig: installConfigMaterial,
  });
  const id = `icfg_${digest.replace(/^sha256:/u, "").slice(0, 16)}`;
  const now = new Date().toISOString();
  const expected: InstallConfig = {
    id,
    ...installConfigMaterial,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const existing = await input.operations.capsules.getInstallConfig(id);
    if (!(await installConfigIdentityEqual(existing, expected))) {
      return {
        status: "invalid",
        diagnostic: {
          code: "repository_install_ux_compatibility_report_mismatch",
          message:
            "The deterministic repository install UX preview identity conflicts with another configuration.",
        },
      };
    }
    return { status: "accepted", installConfig: existing };
  } catch (error) {
    if (
      !(error instanceof OpenTofuControllerError) ||
      error.code !== "not_found"
    ) {
      throw error;
    }
    // Missing is the ordinary first compilation. The deterministic id makes a
    // concurrent retry converge through the create-if-absent store seam.
  }

  if (input.persist === false) {
    return { status: "accepted", installConfig: expected };
  }
  const created = await input.operations.capsules.createInstallConfigIfAbsent(
    expected,
  );
  const config = created
    ? expected
    : await input.operations.capsules.getInstallConfig(expected.id);
  if (!(await installConfigIdentityEqual(config, expected))) {
    return {
      status: "invalid",
      diagnostic: {
        code: "repository_install_ux_compatibility_report_mismatch",
        message:
          "The deterministic repository install UX preview did not persist its exact configuration identity.",
      },
    };
  }
  return { status: "accepted", installConfig: config };
}

async function installConfigIdentityEqual(
  left: InstallConfig,
  right: InstallConfig,
): Promise<boolean> {
  const identity = (config: InstallConfig) => {
    const {
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...material
    } = config;
    return material;
  };
  return (
    (await stableJsonDigest(identity(left))) ===
    (await stableJsonDigest(identity(right)))
  );
}

type DeclarationMergeResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly diagnostic: RepoOwnedInstallConfigAdoptionDiagnostic;
    };

function resolveInterfaceInstallingPrincipalBlueprints(
  repositoryManifestApiVersion: RepositoryManifestDocument["apiVersion"],
  blueprints: InstallConfig["interfaceBlueprints"],
  installingPrincipalId: string | undefined,
): InstallConfig["interfaceBlueprints"] {
  if (
    !isRepositoryManifestInterfaceCapableApiVersion(
      repositoryManifestApiVersion,
    ) || !installingPrincipalId
  ) {
    return blueprints;
  }
  return resolveCapsuleInterfaceBlueprintInstallingPrincipal(
    blueprints,
    installingPrincipalId,
  );
}

function mergeReviewedInterfaceBlueprints(input: {
  readonly repositoryManifestApiVersion: RepositoryManifestDocument["apiVersion"];
  readonly base: InstallConfig["interfaceBlueprints"];
  readonly proposed: readonly NonNullable<
    InstallConfig["interfaceBlueprints"]
  >[number][];
  readonly reviewed: InstallConfig["interfaceBlueprints"];
}): DeclarationMergeResult<InstallConfig["interfaceBlueprints"]> {
  if (
    !isRepositoryManifestInterfaceCapableApiVersion(
      input.repositoryManifestApiVersion,
    )
  ) {
    return { ok: true, value: input.reviewed ?? input.base };
  }
  const proposedMerge = mergeInterfaceBlueprintsByKey(
    input.base,
    input.proposed,
  );
  if (!proposedMerge.ok) return proposedMerge;
  if (input.reviewed === undefined) return proposedMerge;
  return mergeInterfaceBlueprintsByKey(proposedMerge.value, input.reviewed);
}

function mergeInterfaceBlueprintsByKey(
  base: InstallConfig["interfaceBlueprints"],
  incoming: readonly NonNullable<
    InstallConfig["interfaceBlueprints"]
  >[number][],
): DeclarationMergeResult<InstallConfig["interfaceBlueprints"]> {
  const merged = [...(base ?? [])];
  const byKey = new Map(merged.map((blueprint) => [blueprint.key, blueprint]));
  const keyByName = new Map(
    merged.map((blueprint) => [blueprint.name, blueprint.key]),
  );
  for (const blueprint of incoming) {
    const existing = byKey.get(blueprint.key);
    if (existing) {
      if (normalizedInterfaceBlueprintEqual(existing, blueprint)) continue;
      return {
        ok: false,
        diagnostic: {
          code: "repository_install_ux_interface_blueprint_conflict",
          message: `Interface blueprint key ${boundedMergeIdentifier(blueprint.key)} conflicts with the reviewed service declaration.`,
        },
      };
    }
    const existingKey = keyByName.get(blueprint.name);
    if (existingKey !== undefined) {
      return {
        ok: false,
        diagnostic: {
          code: "repository_install_ux_interface_blueprint_conflict",
          message: `Interface blueprint name ${boundedMergeIdentifier(blueprint.name)} is already owned by key ${boundedMergeIdentifier(existingKey)}.`,
        },
      };
    }
    merged.push(blueprint);
    byKey.set(blueprint.key, blueprint);
    keyByName.set(blueprint.name, blueprint.key);
  }
  if (base === undefined && incoming.length === 0) {
    return { ok: true, value: undefined };
  }
  return { ok: true, value: merged };
}

function mergeReviewedOutputAllowlist(input: {
  readonly repositoryManifestApiVersion: RepositoryManifestDocument["apiVersion"];
  readonly base: InstallConfig["outputAllowlist"];
  readonly proposed: InstallConfig["outputAllowlist"];
  readonly reviewed: InstallConfig["outputAllowlist"] | undefined;
}): DeclarationMergeResult<InstallConfig["outputAllowlist"]> {
  if (
    !isRepositoryManifestInterfaceCapableApiVersion(
      input.repositoryManifestApiVersion,
    )
  ) {
    return { ok: true, value: input.reviewed ?? input.base };
  }
  const proposedMerge = mergeOutputAllowlistByKey(input.base, input.proposed);
  if (!proposedMerge.ok) return proposedMerge;
  if (input.reviewed === undefined) return proposedMerge;
  return mergeOutputAllowlistByKey(proposedMerge.value, input.reviewed);
}

function mergeOutputAllowlistByKey(
  base: InstallConfig["outputAllowlist"],
  incoming: InstallConfig["outputAllowlist"],
): DeclarationMergeResult<InstallConfig["outputAllowlist"]> {
  const merged = { ...base };
  for (const [key, entry] of Object.entries(incoming)) {
    const existing = merged[key];
    if (existing !== undefined) {
      if (normalizedDeclarationEqual(existing, entry)) continue;
      return {
        ok: false,
        diagnostic: {
          code: "repository_install_ux_output_allowlist_conflict",
          message: `Output allowlist key ${boundedMergeIdentifier(key)} conflicts with the reviewed service declaration.`,
        },
      };
    }
    merged[key] = entry;
  }
  return { ok: true, value: merged };
}

function normalizedDeclarationEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function normalizedInterfaceBlueprintEqual(
  left: NonNullable<InstallConfig["interfaceBlueprints"]>[number],
  right: NonNullable<InstallConfig["interfaceBlueprints"]>[number],
): boolean {
  return normalizedDeclarationEqual(
    normalizedInterfaceBlueprint(left),
    normalizedInterfaceBlueprint(right),
  );
}

function normalizedInterfaceBlueprint(
  blueprint: NonNullable<InstallConfig["interfaceBlueprints"]>[number],
): unknown {
  const { bindings, labels, spec, ...identity } = blueprint;
  const { inputs, ...specWithoutInputs } = spec;
  const normalizedBindings = (bindings ?? [])
    .map((binding) => ({
      ...binding,
      permissions: [...binding.permissions].sort((left, right) =>
        left.localeCompare(right),
      ),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return {
    ...identity,
    ...(labels && Object.keys(labels).length > 0 ? { labels } : {}),
    spec: {
      ...specWithoutInputs,
      ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
    },
    ...(normalizedBindings.length > 0 ? { bindings: normalizedBindings } : {}),
  };
}

function boundedMergeIdentifier(value: string): string {
  return JSON.stringify(value.replace(/[\0-\u001f\u007f]/gu, "").slice(0, 96));
}

/** Match the source-sync module index's canonical directory spelling. */
function isCanonicalRepositoryModulePath(value: string): boolean {
  if (
    !value ||
    value.trim() !== value ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  if (value === ".") return true;
  return !value
    .split("/")
    .some((segment) => !segment || segment === "." || segment === "..");
}

/** Individual OpenTofu files are not install-module directory choices. */
function isRepositoryModuleDirectoryPath(value: string): boolean {
  return !/(?:\.tf|\.tofu)(?:\.json)?$/iu.test(value);
}

export type RepoOwnedInstallModulePathResolution =
  | {
      readonly ok: true;
      readonly modulePath: string;
      readonly rootProviderRequirements: readonly RepositoryModuleRootProviderRequirement[];
    }
  | {
      readonly ok: false;
      readonly diagnostic: RepoOwnedInstallConfigAdoptionDiagnostic;
    };

/**
 * Select an actual OpenTofu root observed from the immutable Git tree. Store,
 * Source defaults, base InstallConfig paths, and manifest-only keys are never
 * consulted. An omitted choice auto-selects exactly one candidate; zero or
 * multiple candidates require an actionable caller decision.
 */
export function resolveRepoOwnedInstallModulePath(input: {
  readonly sourceSnapshot: SourceSnapshot | undefined;
  readonly modulePath?: string;
}): RepoOwnedInstallModulePathResolution {
  const observation = parseRepositoryModulesSnapshot(
    input.sourceSnapshot?.repositoryModules,
  );
  if (
    !observation ||
    observation.status === "invalid" ||
    !input.sourceSnapshot ||
    observation.scopePath !== canonicalSourceSnapshotPath(input.sourceSnapshot)
  ) {
    return {
      ok: false,
      diagnostic: {
        code: "repository_install_module_index_unavailable",
        message:
          "The pinned SourceSnapshot has no complete OpenTofu module index; sync and review the source again.",
      },
    };
  }
  const modules = observation.modules;
  if (input.modulePath !== undefined) {
    // A URL path is only a selection hint until it is proven against the exact
    // source-sync index. Never consult Source/default/base/manifest paths as a
    // fallback for an explicit request.
    const parsedModulePath = modulePathValue(input.modulePath);
    const canonicalModulePath =
      parsedModulePath === "" ? "." : parsedModulePath;
    if (
      canonicalModulePath === undefined ||
      (input.modulePath !== "." && input.modulePath !== canonicalModulePath) ||
      !isCanonicalRepositoryModulePath(canonicalModulePath) ||
      !isRepositoryModuleDirectoryPath(canonicalModulePath)
    ) {
      return {
        ok: false,
        diagnostic: {
          code: "repository_install_ux_module_path_invalid",
          message:
            "The selected module path is not a canonical relative path.",
        },
      };
    }
    const selected = modules.find(
      (module) => module.path === canonicalModulePath,
    );
    if (!selected) {
      return {
        ok: false,
        diagnostic: {
          code: "repository_install_ux_module_missing",
          message: `The pinned Git tree does not contain the selected OpenTofu module ${boundedMergeIdentifier(canonicalModulePath)}.`,
        },
      };
    }
    return {
      ok: true,
      modulePath: canonicalModulePath,
      rootProviderRequirements: selected.rootProviderRequirements,
    };
  }

  if (modules.length === 1) {
    return {
      ok: true,
      modulePath: modules[0]!.path,
      rootProviderRequirements: modules[0]!.rootProviderRequirements,
    };
  }
  return {
    ok: false,
    diagnostic: {
      code:
        modules.length === 0
          ? "repository_install_ux_module_missing"
          : "repository_install_module_selection_required",
      message:
        modules.length === 0
          ? "The pinned Git tree contains no installable OpenTofu root module."
          : "The pinned Git tree contains multiple OpenTofu root modules; choose one exact path.",
    },
  };
}

function canonicalSourceSnapshotPath(snapshot: SourceSnapshot): string {
  const parsed = modulePathValue(snapshot.path);
  return parsed === "" ? "." : parsed ?? "";
}

/**
 * Repository manifests use repository-root-relative module keys while the
 * source-sync module index (and compatibility runner) uses paths relative to
 * SourceSnapshot.path. Map only for the optional presentation/Install UX
 * lookup; executable modulePath remains subtree-relative.
 */
function repositoryManifestModulePath(
  snapshot: SourceSnapshot,
  modulePath: string,
): string | undefined {
  const scopePath = canonicalSourceSnapshotPath(snapshot);
  if (!scopePath) return undefined;
  if (scopePath === ".") return modulePath;
  if (modulePath === ".") return scopePath;
  return `${scopePath}/${modulePath}`;
}

function remapRepositoryManifestModule(
  document: RepositoryManifestDocument,
  repositoryModulePath: string,
  selectedModulePath: string,
): RepositoryManifestDocument {
  const selected = document.install.modules[repositoryModulePath];
  if (!selected) return document;
  return {
    ...document,
    install: {
      ...document.install,
      modules: { [selectedModulePath]: selected },
    },
  } as RepositoryManifestDocument;
}

function mergeVariablePresentation(
  proposed: readonly NonNullable<
    InstallConfig["variablePresentation"]
  >[number][],
  operator: InstallConfig["variablePresentation"],
): InstallConfig["variablePresentation"] {
  const merged = new Map(proposed.map((entry) => [entry.name, entry]));
  for (const entry of operator ?? []) merged.set(entry.name, entry);
  return [...merged.values()];
}

function mergeInstallExperience(
  proposed: NonNullable<InstallConfig["installExperience"]>,
  operator: InstallConfig["installExperience"],
):
  | { readonly ok: true; readonly value: InstallConfig["installExperience"] }
  | {
      readonly ok: false;
      readonly diagnostic: RepoOwnedInstallConfigAdoptionDiagnostic;
    } {
  if (!operator) return { ok: true, value: proposed };
  const projections = new Map(
    (proposed.projections ?? []).map((projection) => [
      projection.kind,
      projection,
    ]),
  );
  const repositoryOidcRequested = (proposed.projections ?? []).some(
    (projection) => projection.kind === "oidc_client",
  );
  if (
    repositoryOidcRequested &&
    (operator.projections ?? []).some(
      (projection) => projection.kind === "public_endpoint",
    )
  ) {
    return {
      ok: false,
      diagnostic: {
        code: "repository_install_ux_oidc_endpoint_conflict",
        message:
          "The repository OIDC capability and its public endpoint are one reviewed manifest pair; remove the base public endpoint before adoption.",
      },
    };
  }
  for (const projection of operator.projections ?? []) {
    if (projection.kind === "oidc_client") {
      // Dynamic Capsule registration is available only when this exact
      // repository snapshot requested and compiled identity.oidc. A catalog
      // or manual presentation projection must not be promoted merely because
      // another repository declaration caused a derived InstallConfig row.
      continue;
    }
    projections.set(projection.kind, projection);
  }
  return {
    ok: true,
    value: {
      ...(projections.size > 0
        ? { projections: [...projections.values()] }
        : {}),
      ...(proposed.features ? { features: proposed.features } : {}),
      repositoryInstallUx: { status: "accepted" },
    },
  };
}

function mergeRecords(
  proposed: Readonly<Record<string, unknown>>,
  operator: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { ...proposed, ...operator };
}

/**
 * Runtime materialization is a private host profile, not a set of independent
 * repository fields. Keep an operator profile when the repository is silent;
 * accept a repository proposal only when it is byte-for-byte compatible with
 * the existing profile, and fail closed on any collision.
 */
function mergeRuntimeBindingMaterialization(
  base: InstallConfig["runtimeBindingMaterialization"],
  proposed: InstallConfig["runtimeBindingMaterialization"],
): DeclarationMergeResult<InstallConfig["runtimeBindingMaterialization"]> {
  if (proposed === undefined) return { ok: true, value: base };
  if (base === undefined) return { ok: true, value: proposed };
  if (normalizedDeclarationEqual(base, proposed)) {
    return { ok: true, value: base };
  }
  return {
    ok: false,
    diagnostic: {
      code: "repository_install_ux_runtime_binding_profile_conflict",
      message:
        "The repository runtime binding profile conflicts with the operator profile.",
    },
  };
}

function repoPresentationStoreMetadata(input: {
  readonly metadata: Record<string, unknown>;
  readonly listing: InstallConfig["store"] | undefined;
}): InstallConfig["store"] | undefined {
  if (!input.listing) return undefined;
  return installConfigStoreValue({
    ...input.listing,
    ...(input.metadata.name !== undefined ? { name: input.metadata.name } : {}),
    ...(input.metadata.description !== undefined
      ? { description: input.metadata.description }
      : {}),
    ...(input.metadata.badge !== undefined
      ? { badge: input.metadata.badge }
      : {}),
    ...(input.metadata.iconUrl !== undefined
      ? { iconUrl: input.metadata.iconUrl }
      : {}),
  });
}

async function readRepoOwnedTcsMetadata(input: {
  readonly operations: ControlPlaneOperations;
  readonly sourceSnapshot: SourceSnapshot | undefined;
  readonly modulePath?: string;
}): Promise<Record<string, unknown> | undefined> {
  if (!input.sourceSnapshot) return undefined;
  const captured = input.sourceSnapshot.repositoryInstallMetadata;
  if (captured) {
    if (captured.status !== "present") return undefined;
    try {
      return repoMetadataRecord(JSON.parse(captured.text));
    } catch {
      return undefined;
    }
  }
  try {
    const files = await input.operations.readSourceSnapshotFiles(
      input.sourceSnapshot.id,
      input.modulePath ? { modulePath: input.modulePath } : undefined,
    );
    const metadataFile = files.find(
      (file) => file.path === ".well-known/tcs.json",
    );
    return metadataFile
      ? repoMetadataRecord(JSON.parse(metadataFile.text))
      : undefined;
  } catch {
    return undefined;
  }
}

function repoMetadataRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const schemaVersion =
    typeof value.schemaVersion === "string" ? value.schemaVersion.trim() : "";
  if (schemaVersion && schemaVersion !== "tcs.repo/v1") return undefined;
  return {
    ...(schemaVersion ? { schemaVersion } : {}),
    ...(value.name !== undefined ? { name: value.name } : {}),
    ...(value.description !== undefined
      ? { description: value.description }
      : {}),
    ...(value.badge !== undefined ? { badge: value.badge } : {}),
    ...(value.iconUrl !== undefined ? { iconUrl: value.iconUrl } : {}),
  };
}
