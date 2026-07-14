import type { Source, SourceSnapshot } from "takosumi-contract/sources";
import type { InstallConfig } from "takosumi-contract/install-configs";

import type { ControlPlaneOperations } from "../control-operations.ts";
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
          Boolean(snapshot.resolvedCommit.trim()),
      )
      .sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))[0];
  } catch {
    return undefined;
  }
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
