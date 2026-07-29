import { TAKOSUMI_ACCOUNTS_CAPSULE_DELEGATION_SCOPES } from "@takosjp/takosumi-accounts-contract";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { Source, SourceSnapshot } from "takosumi-contract/sources";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { JsonValue } from "takosumi-contract/types";

import type { ControlPlaneOperations } from "../control-operations.ts";
import {
  compileRepositoryInstallUx,
  type RepositoryInstallUxDiagnostic,
} from "../../../../core/domains/capsules/repository_install_ux_compiler.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
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
  readonly compatibilityReport?: CapsuleCompatibilityReport;
  readonly requireReviewedValues?: boolean;
}

export type RepoOwnedInstallConfigAdoptionResult =
  | { readonly status: "absent" }
  | {
      readonly status: "invalid";
      readonly diagnostic: RepositoryInstallUxDiagnostic;
    }
  | {
      readonly status: "accepted";
      readonly variablePresentation: InstallConfig["variablePresentation"];
      readonly installExperience: InstallConfig["installExperience"];
      readonly variableMapping: InstallConfig["variableMapping"];
      readonly sourceSnapshotId: string;
      readonly digest: string;
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
 * absent/legacy observations preserve the ordinary generic install flow.
 */
export async function adoptRepoOwnedInstallConfig(
  input: RepoOwnedInstallConfigAdoptionInput,
): Promise<RepoOwnedInstallConfigAdoptionResult> {
  const observation = input.sourceSnapshot?.repositoryInstallUx;
  if (!observation || observation.status === "absent") {
    return { status: "absent" };
  }
  if (observation.status === "invalid") {
    return {
      status: "invalid",
      diagnostic: {
        code: "repository_install_ux_document_invalid",
        message:
          "The repository install UX document is invalid; update the pinned repository metadata and sync the Source again.",
      },
    };
  }

  const modulePath = selectedModulePath(input);
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
    },
  });
  if (!compiled.ok) {
    return { status: "invalid", diagnostic: compiled.diagnostic };
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
    sourceSnapshotId: input.sourceSnapshot!.id,
    digest: observation.digest,
  };
}

export type RepoOwnedInstallConfigPreviewResult =
  | { readonly status: "absent" }
  | {
      readonly status: "invalid";
      readonly diagnostic: RepositoryInstallUxDiagnostic;
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
  },
): Promise<RepoOwnedInstallConfigPreviewResult> {
  const adoption = await adoptRepoOwnedInstallConfig({
    ...input,
    requireReviewedValues: false,
  });
  if (adoption.status !== "accepted") return adoption;

  const digest = await stableJsonDigest({
    sourceSnapshotId: adoption.sourceSnapshotId,
    repositoryInstallUxDigest: adoption.digest,
    modulePath: selectedModulePath(input),
    baseInstallConfigId: input.baseConfig.id,
    baseInstallConfigUpdatedAt: input.baseConfig.updatedAt,
    capsuleName: input.capsuleName,
    variablePresentation: adoption.variablePresentation ?? [],
    installExperience: adoption.installExperience ?? {},
    variableMapping: adoption.variableMapping,
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
  const selectedPath = selectedModulePath(input);
  const { modulePath: _baseModulePath, ...baseConfigWithoutModulePath } =
    input.baseConfig;
  const config = await input.operations.capsules.putInstallConfig({
    ...(selectedPath === "." ? baseConfigWithoutModulePath : input.baseConfig),
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
    ...(selectedPath !== "." ? { modulePath: selectedPath } : {}),
    createdAt: now,
    updatedAt: now,
  });
  return { status: "accepted", installConfig: config };
}

function selectedModulePath(
  input: RepoOwnedInstallConfigAdoptionInput,
): string {
  const selected =
    input.modulePath ?? input.baseConfig.modulePath ?? input.source.defaultPath;
  return !selected || selected === "" ? "." : selected;
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
