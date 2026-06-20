/**
 * Control-backup contract and R2_BACKUPS object layout.
 *
 * A {@link BackupRecord} is the ledger pointer to one sealed control-backup
 * bundle written to the R2_BACKUPS bucket. The bundle is a compressed JSON
 * export of a Space's control ledger (spaces / sources / source snapshots /
 * install configs / installations / dependencies / deployments /
 * state-snapshot metadata / output-snapshot projections / run groups /
 * activity / connection PUBLIC records), then sealed with the at-rest
 * secret-boundary crypto the state/secret lanes already use. The bundle NEVER
 * contains secret material:
 * no connection blobs, no hook secret hashes, no raw state bytes, no raw output
 * values — only public ledger metadata + the projected `publicOutputs` /
 * `spaceOutputs`.
 *
 * Service data backup (messages / files / posts / etc.) is represented as a
 * separate sealed `service-data.tar.zst.enc` archive when Installations opt
 * into a `BackupConfig` mode. The control path records metadata + pointers from
 * an isolated backup runner or the Installation's projected OpenTofu output.
 *
 * Canonical R2_BACKUPS keys:
 *   - `control.json.zst.enc`
 *   - `state.tar.zst.enc`
 *   - `artifacts.manifest.json`
 *   - `service-data.tar.zst.enc`
 */

import { INTERNAL_V1_PREFIX } from "./api-surface.ts";
import type { Run } from "./runs.ts";

/** Object-key prefix for a Space's control backups in R2_BACKUPS. */
export const BACKUPS_KEY_PREFIX = (spaceId: string): string =>
  `spaces/${spaceId}/backups`;

/**
 * Full object key for one control-backup bundle in R2_BACKUPS.
 *
 */
export const CONTROL_BACKUP_OBJECT_KEY = (
  spaceId: string,
  backupId: string,
): string => `${BACKUPS_KEY_PREFIX(spaceId)}/${backupId}/control.json.zst.enc`;

/** Full object key for exported encrypted state snapshots in R2_BACKUPS. */
export const STATE_BACKUP_OBJECT_KEY = (
  spaceId: string,
  backupId: string,
): string => `${BACKUPS_KEY_PREFIX(spaceId)}/${backupId}/state.tar.zst.enc`;

/** Full object key for the standalone backup artifact inventory. */
export const ARTIFACTS_MANIFEST_OBJECT_KEY = (
  spaceId: string,
  backupId: string,
): string =>
  `${BACKUPS_KEY_PREFIX(spaceId)}/${backupId}/artifacts.manifest.json`;

/**
 * Full object key for the service-data backup archive/pointer bundle.
 */
export const SERVICE_DATA_BACKUP_OBJECT_KEY = (
  spaceId: string,
  backupId: string,
): string =>
  `${BACKUPS_KEY_PREFIX(spaceId)}/${backupId}/service-data.tar.zst.enc`;

/** Content type of the sealed control-backup object as stored in R2. */
export const CONTROL_BACKUP_CONTENT_TYPE = "application/octet-stream" as const;

/** Path of the Space-scoped control-backup REST surface. */
export const SPACE_BACKUPS_PATH = (spaceId: string): string =>
  `${INTERNAL_V1_PREFIX}/spaces/${encodeURIComponent(spaceId)}/backups`;

/** Path of the Space-scoped destructive restore trigger REST surface. */
export const SPACE_BACKUP_RESTORES_PATH = (
  spaceId: string,
  backupId: string,
): string =>
  `${SPACE_BACKUPS_PATH(spaceId)}/${encodeURIComponent(backupId)}/restores`;

/** Path of the Installation-scoped backup trigger REST surface. */
export const INSTALLATION_BACKUPS_PATH = (installationId: string): string =>
  `${INTERNAL_V1_PREFIX}/installations/${encodeURIComponent(
    installationId,
  )}/backups`;

/**
 * Ledger pointer to one sealed control-backup bundle.
 *
 *   - `id`            — service-assigned backup id (`bkp_…`).
 *   - `spaceId`       — the owning Space (the listing key).
 *   - `objectKey`     — R2_BACKUPS key of the sealed bundle
 *                       (`spaces/{spaceId}/backups/{backupId}/control.json.zst.enc`).
 *   - `digest`        — `sha256:<hex>` over the SEALED bytes written to R2.
 *   - `sizeBytes`     — length of the sealed object in bytes.
 *   - `createdByRunId`— optional run id that triggered the backup (operator /
 *                       scheduled flows); absent for an ad-hoc API-triggered
 *                       backup.
 *   - `createdAt`     — ISO-8601 timestamp.
 */
export interface BackupRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId?: string;
  readonly environment?: string;
  readonly objectKey: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly stateArchive?: BackupArtifactPointer;
  readonly artifactsManifest?: BackupArtifactPointer;
  readonly serviceData?: ServiceDataBackupPointer;
  readonly createdByRunId?: string;
  readonly createdAt: string;
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

/** Body of `POST .../spaces/:spaceId/backups/:backupId/restores`. */
export interface CreateRestoreRequest {
  /**
   * Target Installation to restore. Optional only when the BackupRecord was
   * created from an Installation-scoped backup and already carries it.
   */
  readonly installationId?: string;
  readonly environment?: string;
  /**
   * Backup-time StateSnapshot generation to restore from. The controller
   * verifies that the selected snapshot exists and writes it as a NEW current
   * StateSnapshot generation after approval.
   */
  readonly stateGeneration: number;
  /** Optional client-side guard over BackupRecord.digest. */
  readonly expectedBackupDigest?: string;
  /**
   * Service-data restore is intentionally explicit. `true` currently returns
   * not_implemented; omitted/false performs control/state restore only.
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
