/**
 * Shared test fixture for the Space-direct Installation model (core-spec §4 /
 * §5 / §11). Seeds the minimal ledger rows an installation-driven run needs:
 * Space -> StoredSource -> SourceSnapshot -> InstallConfig -> Installation.
 *
 * Tests that previously planned from a raw module source now create the
 * Installation first (the create-on-apply legacy path is removed) and call
 * `controller.createInstallationPlan(installationId)`.
 */
import type { InstallConfig, Installation } from "takosumi-contract/deploy-control-api";
import type { SourceSnapshot } from "takosumi-contract/sources";
import type { Space } from "takosumi-contract/spaces";
import type { OpenTofuDeploymentStore, StoredSource } from "./store.ts";

export interface SeededModel {
  readonly space: Space;
  readonly source: StoredSource;
  readonly snapshot: SourceSnapshot;
  readonly installConfig: InstallConfig;
  readonly installation: Installation;
}

export interface SeedModelOptions {
  readonly spaceId?: string;
  readonly sourceId?: string;
  readonly snapshotId?: string;
  readonly installConfigId?: string;
  readonly installationId?: string;
  readonly environment?: string;
  readonly name?: string;
  readonly sourceUrl?: string;
  readonly ref?: string;
  /** Skip seeding the SourceSnapshot (to exercise source_sync_required). */
  readonly withoutSnapshot?: boolean;
  /** Extra InstallConfig fields (e.g. templateBinding for template runs). */
  readonly installConfig?: Partial<InstallConfig>;
}

export const FIXTURE_ARCHIVE_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Seeds Space + Source + Snapshot + InstallConfig + Installation. */
export async function seedInstallationModel(
  store: OpenTofuDeploymentStore,
  options: SeedModelOptions = {},
): Promise<SeededModel> {
  const now = "2026-06-06T00:00:00.000Z";
  const spaceId = options.spaceId ?? "space_test";
  const sourceId = options.sourceId ?? "src_fixture";
  const environment = options.environment ?? "production";
  const name = options.name ?? "app";
  const space: Space = {
    id: spaceId,
    handle: spaceId.replace(/_/g, "-"),
    displayName: "Test Space",
    type: "personal",
    ownerUserId: "user_test",
    createdAt: now,
    updatedAt: now,
  };
  await store.putSpace(space);
  const source: StoredSource = {
    id: sourceId,
    spaceId,
    name: `${name}-source`,
    url: options.sourceUrl ?? "https://git.example.com/example/app.git",
    defaultRef: options.ref ?? "main",
    defaultPath: ".",
    status: "active",
    createdAt: now,
    updatedAt: now,
    hookSecretHash: "test-hook-hash",
    autoSync: false,
  };
  await store.putSource(source);
  const snapshot: SourceSnapshot = {
    id: options.snapshotId ?? "snap_fixture",
    sourceId,
    url: source.url,
    ref: source.defaultRef,
    resolvedCommit: "abcdef0123456789abcdef0123456789abcdef01",
    path: ".",
    archiveObjectKey:
      `spaces/${spaceId}/sources/${sourceId}/snapshots/snap_fixture/source.tar.zst`,
    archiveDigest: FIXTURE_ARCHIVE_DIGEST,
    archiveSizeBytes: 1024,
    fetchedByRunId: "run_fixture_sync",
    fetchedAt: now,
  };
  if (!options.withoutSnapshot) {
    await store.putSourceSnapshot(snapshot);
  }
  const installConfig: InstallConfig = {
    id: options.installConfigId ?? "cfg_fixture",
    name: `${name}-config`,
    installType: "opentofu_module",
    trustLevel: "official",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: now,
    updatedAt: now,
    ...options.installConfig,
  };
  await store.putInstallConfig(installConfig);
  const installation: Installation = {
    id: options.installationId ?? "inst_fixture",
    spaceId,
    name,
    slug: name,
    sourceId,
    installType: installConfig.installType,
    installConfigId: installConfig.id,
    environment,
    currentStateGeneration: 0,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await store.putInstallation(installation);
  return { space, source, snapshot, installConfig, installation };
}
