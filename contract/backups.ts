/**
 * Control-backup contract and R2_BACKUPS object layout.
 *
 * A {@link BackupRecord} is the ledger pointer to one sealed control-backup
 * bundle written to the R2_BACKUPS bucket. The bundle is a compressed JSON
 * export of a Workspace's control ledger (spaces / sources / source snapshots /
 * install configs / installations / dependencies / deployments /
 * state-snapshot metadata / output-snapshot projections / run groups /
 * activity / connection PUBLIC records), then sealed with the at-rest
 * secret-boundary crypto the state/secret lanes already use. The bundle NEVER
 * contains secret material:
 * no connection blobs, no hook secret hashes, no raw state bytes, no raw output
 * values — only public ledger metadata + the projected `publicOutputs` /
 * `workspaceOutputs`.
 *
 * Service data backup (messages / files / posts / etc.) is represented as a
 * separate sealed `service-data.tar.zst.enc` archive when Capsules opt
 * into a `BackupConfig` mode. The control path records metadata + pointers from
 * an isolated backup runner or the Capsule's projected OpenTofu output.
 *
 * Canonical R2_BACKUPS keys:
 *   - `control.json.zst.enc`
 *   - `state.tar.zst.enc`
 *   - `artifacts.manifest.json`
 *   - `service-data.tar.zst.enc`
 */

import { INTERNAL_V1_PREFIX } from "./api-surface.ts";
import type { Run } from "./runs.ts";

/** Object-key prefix for a Workspace's control backups in R2_BACKUPS. */
export const BACKUPS_KEY_PREFIX = (workspaceId: string): string =>
  `spaces/${workspaceId}/backups`;

/**
 * Full object key for one control-backup bundle in R2_BACKUPS.
 *
 */
export const CONTROL_BACKUP_OBJECT_KEY = (
  workspaceId: string,
  backupId: string,
): string => `${BACKUPS_KEY_PREFIX(workspaceId)}/${backupId}/control.json.zst.enc`;

/** Full object key for exported encrypted state snapshots in R2_BACKUPS. */
export const STATE_BACKUP_OBJECT_KEY = (
  workspaceId: string,
  backupId: string,
): string => `${BACKUPS_KEY_PREFIX(workspaceId)}/${backupId}/state.tar.zst.enc`;

/** Full object key for the standalone backup artifact inventory. */
export const ARTIFACTS_MANIFEST_OBJECT_KEY = (
  workspaceId: string,
  backupId: string,
): string =>
  `${BACKUPS_KEY_PREFIX(workspaceId)}/${backupId}/artifacts.manifest.json`;

/**
 * Full object key for the service-data backup archive/pointer bundle.
 */
export const SERVICE_DATA_BACKUP_OBJECT_KEY = (
  workspaceId: string,
  backupId: string,
): string =>
  `${BACKUPS_KEY_PREFIX(workspaceId)}/${backupId}/service-data.tar.zst.enc`;

/** Content type of the sealed control-backup object as stored in R2. */
export const CONTROL_BACKUP_CONTENT_TYPE = "application/octet-stream" as const;

/** Path of the Workspace-scoped control-backup REST surface. */
export const WORKSPACE_BACKUPS_PATH = (workspaceId: string): string =>
  `${INTERNAL_V1_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/backups`;

/** Path of the Workspace-scoped destructive restore trigger REST surface. */
export const WORKSPACE_BACKUP_RESTORES_PATH = (
  workspaceId: string,
  backupId: string,
): string =>
  `${WORKSPACE_BACKUPS_PATH(workspaceId)}/${encodeURIComponent(
    backupId,
  )}/restores`;

/** Path of the Capsule-scoped backup trigger REST surface. */
export const CAPSULE_BACKUPS_PATH = (capsuleId: string): string =>
  `${INTERNAL_V1_PREFIX}/capsules/${encodeURIComponent(capsuleId)}/backups`;

/**
 * Ledger pointer to one sealed control-backup bundle.
 *
 *   - `id`            — service-assigned backup id (`bkp_…`).
 *   - `workspaceId`       — the owning Workspace (the listing key).
 *   - `objectKey`     — R2_BACKUPS key of the sealed bundle
 *                       (`spaces/{workspaceId}/backups/{backupId}/control.json.zst.enc`).
 *   - `digest`        — `sha256:<hex>` over the SEALED bytes written to R2.
 *   - `sizeBytes`     — length of the sealed object in bytes.
 *   - `createdByRunId`— optional run id that triggered the backup (operator /
 *                       scheduled flows); absent for an ad-hoc API-triggered
 *                       backup.
 *   - `createdAt`     — ISO-8601 timestamp.
 */
export interface BackupRecord {
  readonly id: string;
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId: string;
  readonly capsuleId?: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  readonly environment?: string;
  readonly restoreTarget?: BackupRestoreTarget;
  readonly objectKey: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly stateArchive?: BackupArtifactPointer;
  readonly artifactsManifest?: BackupArtifactPointer;
  readonly serviceData?: ServiceDataBackupPointer;
  readonly createdByRunId?: string;
  readonly createdAt: string;
}

/** Public pointer to the state generation this backup can restore. */
export interface BackupRestoreTarget {
  readonly capsuleId: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  readonly environment: string;
  readonly stateGeneration: number;
  readonly stateVersionId: string;
  /** @deprecated Use stateVersionId. */
  readonly stateSnapshotId?: string;
}

/** Pointer to a backup object, when present. */
export interface BackupArtifactPointer {
  readonly objectKey: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

/** Pointer to the sealed service-data backup archive, when present. */
export interface ServiceDataBackupPointer {
  readonly objectKey: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly exportedCount: number;
  readonly unsupportedCount: number;
  readonly missingCount: number;
}

/** Response body for a created control backup (`POST .../backups`). */
export interface CreateBackupResponse {
  readonly backup: BackupRecord;
}

/** Body of `POST .../spaces/:workspaceId/backups/:backupId/restores`. */
export interface CreateRestoreRequest {
  /**
   * Target Capsule to restore. Optional only when the BackupRecord was
   * created from an Capsule-scoped backup and already carries it.
   */
  readonly capsuleId?: string;
  readonly environment?: string;
  /**
   * Backup-time StateVersion generation to restore from. The controller
   * verifies that the selected snapshot exists and writes it as a NEW current
   * StateVersion generation after approval.
   */
  readonly stateGeneration: number;
  /** Optional client-side guard over BackupRecord.digest. */
  readonly expectedBackupDigest?: string;
  /**
   * Service-data restore is intentionally explicit. `true` requires the
   * selected BackupRecord to carry a service-data artifact and the restore
   * runner to acknowledge that artifact as restored.
   */
  readonly restoreServiceData?: boolean;
}

/** Response body for a created restore Run. */
export interface CreateRestoreResponse {
  readonly run: Run;
}

/** Response body for a control-backup listing (`GET .../backups`). */
export interface ListBackupsResponse {
  readonly backups: readonly BackupRecord[];
  /**
   * Opaque keyset cursor for the next page when the listing was capped (spec §30
   * pagination; newest-first descending keyset). Absent on the last page.
   * Additive: readers that ignore it are unaffected.
   */
  readonly nextCursor?: string;
}
