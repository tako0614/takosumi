import type { Source, SourceSnapshot } from "takosumi-contract/sources";
import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";

import type { ControlPlaneOperations } from "../control-operations.ts";
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
  readonly outputAllowlist: InstallConfig["outputAllowlist"] | undefined;
  readonly modulePath: string | undefined;
}

export interface RepoOwnedStoreHydrationResult {
  readonly storeMetadata: InstallConfig["store"] | undefined;
  readonly outputAllowlist: InstallConfig["outputAllowlist"] | undefined;
  readonly modulePath: string | undefined;
  readonly metadataUnavailable?: boolean;
}

/**
 * Replaces presentation and install-experience metadata from the immutable Git
 * snapshot while preserving the Store listing as a discovery pointer only.
 */
export async function hydrateRepoOwnedStoreConfig(
  input: RepoOwnedStoreHydrationInput,
): Promise<RepoOwnedStoreHydrationResult> {
  const listingBacked = input.storeMetadata?.source !== undefined;
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
    if (
      !listingBacked &&
      !repositoryMetadataWasDeclared(input.sourceSnapshot)
    ) {
      return input;
    }
    return {
      storeMetadata: scrubbedStoreMetadata(input.storeMetadata),
      outputAllowlist: undefined,
      modulePath: input.modulePath,
      metadataUnavailable: true,
    };
  }

  const modulePath =
    input.modulePath ?? modulePathValue(metadata.modulePath) ?? undefined;
  const mergedStore = repoOwnedStoreMetadata({
    metadata,
    listing: input.storeMetadata,
    source: input.source,
    modulePath,
  });
  if (!mergedStore) {
    return {
      storeMetadata: scrubbedStoreMetadata(input.storeMetadata),
      outputAllowlist: undefined,
      modulePath: input.modulePath,
      metadataUnavailable: true,
    };
  }
  return {
    storeMetadata: mergedStore,
    outputAllowlist: undefined,
    modulePath,
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
          Boolean(snapshot.resolvedCommit.trim()),
      )
      .sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))[0];
  } catch {
    return undefined;
  }
}

/**
 * Refreshes an existing Capsule's repo-owned setup contract before planning.
 * Git is the authority for inputs and install projections; a Store listing or
 * an older per-install config must not pin stale OIDC scopes or callback rules.
 */
export async function refreshRepoOwnedInstallConfigForCapsule(input: {
  readonly operations: ControlPlaneOperations;
  readonly capsule: Capsule;
  readonly installConfig: InstallConfig;
}): Promise<InstallConfig> {
  if (!input.capsule.sourceId) {
    return input.installConfig;
  }
  const { source } = await input.operations.getSource(input.capsule.sourceId);
  const sourceSnapshot = await latestSourceSnapshotForSource(
    input.operations,
    source,
  );
  const hydrated = await hydrateRepoOwnedStoreConfig({
    operations: input.operations,
    source,
    sourceSnapshot,
    storeMetadata: input.installConfig.store,
    outputAllowlist: input.installConfig.outputAllowlist,
    modulePath: input.installConfig.modulePath,
  });
  if (hydrated.metadataUnavailable) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "repo_metadata_unavailable: repository install metadata could not be loaded from the latest Git SourceSnapshot; sync the Source and retry",
    );
  }
  if (!hydrated.storeMetadata) return input.installConfig;
  const nextModulePath = hydrated.modulePath ?? input.installConfig.modulePath;
  if (
    JSON.stringify(hydrated.storeMetadata) ===
      JSON.stringify(input.installConfig.store) &&
    nextModulePath === input.installConfig.modulePath
  ) {
    return input.installConfig;
  }
  return await input.operations.installations.putInstallConfig({
    ...input.installConfig,
    store: hydrated.storeMetadata,
    ...(nextModulePath === undefined ? {} : { modulePath: nextModulePath }),
    updatedAt: new Date().toISOString(),
  });
}

function repositoryMetadataWasDeclared(
  snapshot: SourceSnapshot | undefined,
): boolean {
  const observation = snapshot?.repositoryInstallMetadata;
  return observation !== undefined && observation.status !== "absent";
}

function scrubbedStoreMetadata(
  store: InstallConfig["store"] | undefined,
): InstallConfig["store"] | undefined {
  if (!store) return undefined;
  const {
    inputs: _inputs,
    installExperience: _installExperience,
    ...baseStore
  } = store;
  return installConfigStoreValue({
    ...baseStore,
    inputs: [],
  });
}

function repoOwnedStoreMetadata(input: {
  readonly metadata: Record<string, unknown>;
  readonly listing: InstallConfig["store"] | undefined;
  readonly source: Source;
  readonly modulePath: string | undefined;
}): InstallConfig["store"] | undefined {
  const {
    inputs: _listingInputs,
    installExperience: _listingInstallExperience,
    source: _listingSource,
    ...listingBase
  } = input.listing ?? {};
  const path =
    input.modulePath !== undefined
      ? input.modulePath === ""
        ? "."
        : input.modulePath
      : input.source.defaultPath || ".";
  return installConfigStoreValue({
    ...listingBase,
    ...input.metadata,
    order:
      typeof input.metadata.order === "number"
        ? input.metadata.order
        : (input.listing?.order ?? 1000),
    source: {
      git: input.source.url,
      path,
    },
    inputs: Array.isArray(input.metadata.inputs) ? input.metadata.inputs : [],
    ...(input.metadata.installExperience !== undefined
      ? { installExperience: input.metadata.installExperience }
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
  return value;
}
