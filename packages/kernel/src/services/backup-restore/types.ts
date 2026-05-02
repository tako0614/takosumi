import type { JsonObject } from "takosumi-contract";
import type { ResourceInstanceId } from "../../domains/resources/mod.ts";
import type { IsoTimestamp } from "../../shared/time.ts";

export type BackupMetadataId = string;
export type RestorePlanId = string;
export type RestoreOperationId = string;
export type RestoreMode = "snapshot" | "point-in-time" | "provider-native";
export type BackupStatus = "available" | "expired" | "failed";
export type RestoreOperationStatus =
  | "planned"
  | "running"
  | "completed"
  | "failed";

export interface BackupResourceMetadataDto {
  readonly resourceInstanceId: ResourceInstanceId;
  readonly contract: string;
  readonly provider?: string;
  readonly providerResourceId?: string;
  readonly providerMaterializationId?: string;
  readonly providerBackupRef?: string;
  readonly checksum?: string;
  readonly capturedGeneration?: number;
  readonly metadata?: JsonObject;
}

export interface BackupMetadataDto {
  readonly id: BackupMetadataId;
  readonly spaceId: string;
  readonly groupId?: string;
  readonly status: BackupStatus;
  readonly resources: readonly BackupResourceMetadataDto[];
  readonly createdAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly metadata?: JsonObject;
}

export interface ResourceRestoreSupportDto {
  readonly resourceInstanceId: ResourceInstanceId;
  readonly provider?: string;
  readonly supported: boolean;
  readonly supportedModes: readonly RestoreMode[];
  readonly reason?: string;
}

export interface RestorePlanResourceDto {
  readonly resourceInstanceId: ResourceInstanceId;
  readonly backupId: BackupMetadataId;
  readonly mode: RestoreMode;
  readonly provider?: string;
  readonly providerResourceId?: string;
  readonly providerMaterializationId?: string;
  readonly providerBackupRef?: string;
  readonly checksum?: string;
  readonly targetGeneration: number;
  readonly support: ResourceRestoreSupportDto;
}

export interface RestorePlanDto {
  readonly id: RestorePlanId;
  readonly kind: "restore-plan";
  readonly spaceId: string;
  readonly groupId?: string;
  /** Restore plans are intentionally separate from deploy rollback plans. */
  readonly rollbackPlanId?: never;
  readonly resources: readonly RestorePlanResourceDto[];
  readonly createdAt: IsoTimestamp;
  readonly createdBy?: string;
  readonly metadata?: JsonObject;
}

export interface RestoreOperationRecordDto {
  readonly id: RestoreOperationId;
  readonly planId: RestorePlanId;
  readonly kind: "restore";
  readonly status: RestoreOperationStatus;
  readonly spaceId: string;
  readonly groupId?: string;
  readonly resourceInstanceIds: readonly ResourceInstanceId[];
  readonly startedAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly error?: string;
  readonly metadata?: JsonObject;
}
