import { TAKOSUMI_ACCOUNTS_CAPSULE_DELEGATION_SCOPES } from "@takosjp/takosumi-accounts-contract";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { Source, SourceSnapshot } from "takosumi-contract/sources";
import type { InstallConfig } from "takosumi-contract/install-configs";
import {
  isRepositoryManifestInterfaceCapableApiVersion,
  TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_1,
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
        | "repository_install_ux_default_module_invalid"
        | "repository_install_ux_default_module_missing"
        | "repository_install_ux_interface_blueprint_conflict"
        | "repository_install_ux_output_allowlist_conflict"
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
      readonly outputAllowlist: InstallConfig["outputAllowlist"];
      /**
       * Compiled from the repository's own runtime requirements. A service or
       * operator declaration on the base config keeps final authority.
       */
      readonly hostRuntimeMaterialization?: InstallConfig["hostRuntimeMaterialization"];
      /** Exact repository module compiled into the derived InstallConfig. */
      readonly modulePath: string;
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
 * InstallConfig fields. Present invalid metadata is never silently ignored;
 * absent/legacy observations preserve the ordinary generic install flow
 * unless the operator policy requires an exact manifest API version.
 */
export async function adoptRepoOwnedInstallConfig(
  input: RepoOwnedInstallConfigAdoptionInput,
): Promise<RepoOwnedInstallConfigAdoptionResult> {
  const observation = input.sourceSnapshot?.repositoryManifest;
  const requiredManifestApiVersion =
    input.baseConfig.policy.repositoryInstallUx?.requiredManifestApiVersion;
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
    return {
      status: "invalid",
      diagnostic: invalidRepositoryManifestDiagnostic(observation.diagnostic),
    };
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

  const moduleSelection = resolveRepoOwnedInstallModulePath({
    sourceSnapshot: input.sourceSnapshot,
    modulePath: input.modulePath,
  });
  if (!moduleSelection.ok) {
    return { status: "invalid", diagnostic: moduleSelection.diagnostic };
  }
  const modulePath = moduleSelection.modulePath;
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
    document: observation.document,
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
      allowedOidcScopes: TAKOSUMI_ACCOUNTS_CAPSULE_DELEGATION_SCOPES,
      allowedInterfacePermissions:
        input.baseConfig.policy?.repositoryInstallUx
          ?.allowedInterfacePermissions ?? [],
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

  return {
    status: "accepted",
    variablePresentation: mergeVariablePresentation(
      compiled.compiled.variablePresentation,
      input.baseConfig.variablePresentation,
    ),
    installExperience: mergeInstallExperience(
      compiled.compiled.installExperience,
      input.baseConfig.installExperience,
    ),
    // Repository-derived and reviewed values are proposals. Existing
    // service/operator values retain final authority on collisions.
    variableMapping: mergeRecords(
      compiled.compiled.variableMapping,
      input.baseConfig.variableMapping,
    ),
    interfaceBlueprints: interfaceBlueprints.value,
    outputAllowlist: outputAllowlist.value,
    ...((input.baseConfig.hostRuntimeMaterialization ??
    compiled.compiled.hostRuntimeMaterialization)
      ? {
          hostRuntimeMaterialization:
            input.baseConfig.hostRuntimeMaterialization ??
            compiled.compiled.hostRuntimeMaterialization,
        }
      : {}),
    sourceSnapshotId: input.sourceSnapshot!.id,
    digest: observation.digest,
    repositoryManifestApiVersion,
    modulePath,
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
  },
): Promise<RepoOwnedInstallConfigPreviewResult> {
  const adoption = await adoptRepoOwnedInstallConfig({
    ...input,
    requireReviewedValues: false,
  });
  if (adoption.status !== "accepted") return adoption;
  const repositoryInterfaceDigestFields =
    isRepositoryManifestInterfaceCapableApiVersion(
      adoption.repositoryManifestApiVersion,
    )
      ? {
          interfaceBlueprints: adoption.interfaceBlueprints ?? [],
          outputAllowlist: adoption.outputAllowlist,
        }
      : {};
  // The Store base config is only a policy ceiling. Its legacy presentation
  // paths must not leak into the workspace-scoped config or choose the
  // executable module. Bind the derived config to the exact synced Source;
  // `modulePath` below independently records the repository-selected module.
  const sourceSelector = {
    url: input.source.url,
    path: input.source.defaultPath,
  };

  const digest = await stableJsonDigest({
    sourceSnapshotId: adoption.sourceSnapshotId,
    repositoryInstallUxDigest: adoption.digest,
    modulePath: adoption.modulePath,
    baseInstallConfigId: input.baseConfig.id,
    baseInstallConfigUpdatedAt: input.baseConfig.updatedAt,
    capsuleName: input.capsuleName,
    sourceSelector,
    variablePresentation: adoption.variablePresentation ?? [],
    installExperience: adoption.installExperience ?? {},
    hostRuntimeMaterialization: adoption.hostRuntimeMaterialization ?? null,
    variableMapping: adoption.variableMapping,
    ...repositoryInterfaceDigestFields,
    policy: input.baseConfig.policy,
  });
  const id = `icfg_${digest.replace(/^sha256:/u, "").slice(0, 16)}`;
  try {
    const existing = await input.operations.capsules.getInstallConfig(id);
    if (
      existing.internal?.sourceSnapshotId !== adoption.sourceSnapshotId ||
      existing.internal?.repositoryInstallUxDigest !== adoption.digest
    ) {
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
    // concurrent retry converge through the InstallConfig store upsert.
  }

  const now = new Date().toISOString();
  const selectedPath = adoption.modulePath;
  const { modulePath: _baseModulePath, ...baseConfigWithoutModulePath } =
    input.baseConfig;
  const config = await input.operations.capsules.putInstallConfig({
    ...baseConfigWithoutModulePath,
    id,
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
    outputAllowlist: adoption.outputAllowlist,
    ...(adoption.interfaceBlueprints !== undefined
      ? { interfaceBlueprints: adoption.interfaceBlueprints }
      : {}),
    ...(adoption.hostRuntimeMaterialization
      ? { hostRuntimeMaterialization: adoption.hostRuntimeMaterialization }
      : {}),
    sourceSelector,
    modulePath: selectedPath,
    createdAt: now,
    updatedAt: now,
  });
  return { status: "accepted", installConfig: config };
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

export type RepoOwnedInstallModulePathResolution =
  | { readonly ok: true; readonly modulePath: string }
  | {
      readonly ok: false;
      readonly diagnostic: RepoOwnedInstallConfigAdoptionDiagnostic;
    };

/**
 * Select the repository-owned install module without consulting Store, Source,
 * or base InstallConfig paths. An explicit path remains available to the
 * ordinary manual Git flow; Store preflight calls this with no explicit path.
 */
export function resolveRepoOwnedInstallModulePath(input: {
  readonly sourceSnapshot: SourceSnapshot | undefined;
  readonly modulePath?: string;
}): RepoOwnedInstallModulePathResolution {
  const observation = input.sourceSnapshot?.repositoryManifest;
  if (!observation || observation.status === "absent") {
    return {
      ok: false,
      diagnostic: {
        code: "repository_install_ux_default_module_missing",
        message:
          "Repository install UX cannot select a module because the repository manifest is absent.",
      },
    };
  }
  if (observation.status === "invalid") {
    return {
      ok: false,
      diagnostic: invalidRepositoryManifestDiagnostic(observation.diagnostic),
    };
  }

  if (input.modulePath !== undefined) {
    return {
      ok: true,
      modulePath: input.modulePath === "" ? "." : input.modulePath,
    };
  }

  const document = observation.document;
  const modulePaths = Object.keys(document.install.modules);
  if (document.apiVersion === TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_1) {
    const defaultModule = document.install.defaultModule;
    if (
      defaultModule !== undefined &&
      !Object.prototype.hasOwnProperty.call(
        document.install.modules,
        defaultModule,
      )
    ) {
      return {
        ok: false,
        diagnostic: {
          code: "repository_install_ux_default_module_invalid",
          message:
            "Repository install UX defaultModule must name an exact canonical install.modules key.",
        },
      };
    }
    if (defaultModule !== undefined) {
      return { ok: true, modulePath: defaultModule };
    }
  }
  if (modulePaths.length === 1) {
    return { ok: true, modulePath: modulePaths[0]! };
  }
  return {
    ok: false,
    diagnostic: {
      code: "repository_install_ux_default_module_missing",
      message:
        "Repository install UX declares multiple modules; takosumi.com/v2.1 install.defaultModule is required.",
    },
  };
}

function invalidRepositoryManifestDiagnostic(
  parserDiagnostic: string | undefined,
): RepoOwnedInstallConfigAdoptionDiagnostic {
  if (parserDiagnostic?.startsWith("install.defaultModule")) {
    return {
      code: "repository_install_ux_default_module_invalid",
      message:
        "The repository install UX default module declaration is invalid; update the pinned repository metadata and sync the Source again.",
    };
  }
  return {
    code: "repository_install_ux_document_invalid",
    message:
      "The repository install UX document is invalid; update the pinned repository metadata and sync the Source again.",
  };
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
): InstallConfig["installExperience"] {
  if (!operator) return proposed;
  const projections = new Map(
    (proposed.projections ?? []).map((projection) => [
      projection.kind,
      projection,
    ]),
  );
  for (const projection of operator.projections ?? []) {
    projections.set(projection.kind, projection);
  }
  return {
    ...(projections.size > 0 ? { projections: [...projections.values()] } : {}),
    ...(proposed.features ? { features: proposed.features } : {}),
    repositoryInstallUx: { status: "accepted" },
  };
}

function mergeRecords(
  proposed: Readonly<Record<string, unknown>>,
  operator: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { ...proposed, ...operator };
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
