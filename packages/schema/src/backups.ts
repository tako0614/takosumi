/**
 * Control-backup contract (Core Specification §33 "Backup / Export" layer 1 +
 * §26 R2_BACKUPS object layout).
 *
 * A {@link BackupRecord} is the ledger pointer to one sealed control-backup
 * bundle written to the R2_BACKUPS bucket. The bundle is a JSON export of a
 * Space's control ledger (spaces / sources / source snapshots / install configs
 * / installations / dependencies / deployments / state-snapshot metadata /
 * output-snapshot projections / run groups / activity / connection PUBLIC
 * records), gzip-compressed then sealed with the at-rest secret-boundary crypto
 * the state/secret lanes already use. The bundle NEVER contains secret material:
 * no connection blobs, no hook secret hashes, no raw state bytes, no raw output
 * values — only public ledger metadata + the projected `publicOutputs` /
 * `spaceOutputs`.
 *
 * Spec §33 layer 2 ("service data backup": messages / files / posts / …) stays
 * out of this contract; it is per-Installation data owned by the Installation,
 * driven by `BackupConfig.mode` (`none` for the control plane).
 *
 * DIVERGENCE (object key): spec §26 names the object `control.json.zst.enc`
 * (zstd). zstd has no streaming primitive in workerd, so the control backup is
 * gzip-compressed (`CompressionStream("gzip")`) and the object key is
 * `control.json.gz.enc`. The seal is the same secret-boundary AES-GCM used for
 * state/secret artifacts; `digest` is the SHA-256 over the SEALED bytes that are
 * written to R2.
 */

/** Object-key prefix for a Space's control backups (spec §26 R2_BACKUPS). */
export const BACKUPS_KEY_PREFIX = (spaceId: string): string =>
  `spaces/${spaceId}/backups`;

/**
 * Full object key for one control-backup bundle in R2_BACKUPS.
 *
 * DIVERGENCE: `.gz.enc` (gzip), not the spec's `.zst.enc` (zstd unavailable in
 * workerd). See the module header.
 */
export const CONTROL_BACKUP_OBJECT_KEY = (
  spaceId: string,
  backupId: string,
): string => `${BACKUPS_KEY_PREFIX(spaceId)}/${backupId}/control.json.gz.enc`;

/** Content type of the sealed control-backup object as stored in R2. */
export const CONTROL_BACKUP_CONTENT_TYPE =
  "application/octet-stream" as const;

/** Path of the Space-scoped control-backup REST surface (§30 `/api`). */
export const SPACE_BACKUPS_PATH = (spaceId: string): string =>
  `/api/spaces/${encodeURIComponent(spaceId)}/backups`;

/**
 * Ledger pointer to one sealed control-backup bundle.
 *
 *   - `id`            — service-assigned backup id (`bkp_…`).
 *   - `spaceId`       — the owning Space (the listing key).
 *   - `objectKey`     — R2_BACKUPS key of the sealed bundle
 *                       (`spaces/{spaceId}/backups/{backupId}/control.json.gz.enc`).
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
  readonly objectKey: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly createdByRunId?: string;
  readonly createdAt: string;
}

/** Response body for a created control backup (`POST .../backups`). */
export interface CreateBackupResponse {
  readonly backup: BackupRecord;
}

/** Response body for a control-backup listing (`GET .../backups`). */
export interface ListBackupsResponse {
  readonly backups: readonly BackupRecord[];
}
