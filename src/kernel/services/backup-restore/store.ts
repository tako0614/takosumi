import type {
  BackupMetadataDto,
  BackupMetadataId,
  RestoreOperationId,
  RestoreOperationRecordDto,
  RestorePlanDto,
  RestorePlanId,
} from "./types.ts";

export interface BackupRestoreStore {
  putBackupMetadata(metadata: BackupMetadataDto): Promise<BackupMetadataDto>;
  getBackupMetadata(
    id: BackupMetadataId,
  ): Promise<BackupMetadataDto | undefined>;
  createRestorePlan(plan: RestorePlanDto): Promise<RestorePlanDto>;
  getRestorePlan(id: RestorePlanId): Promise<RestorePlanDto | undefined>;
  createRestoreOperation(
    record: RestoreOperationRecordDto,
  ): Promise<RestoreOperationRecordDto>;
  updateRestoreOperation(
    record: RestoreOperationRecordDto,
  ): Promise<RestoreOperationRecordDto>;
  getRestoreOperation(
    id: RestoreOperationId,
  ): Promise<RestoreOperationRecordDto | undefined>;
}

export class InMemoryBackupRestoreStore implements BackupRestoreStore {
  readonly backups = new Map<BackupMetadataId, BackupMetadataDto>();
  readonly restorePlans = new Map<RestorePlanId, RestorePlanDto>();
  readonly restoreOperations = new Map<
    RestoreOperationId,
    RestoreOperationRecordDto
  >();

  putBackupMetadata(metadata: BackupMetadataDto): Promise<BackupMetadataDto> {
    const frozen = deepFreeze(structuredClone(metadata));
    this.backups.set(metadata.id, frozen);
    return Promise.resolve(frozen);
  }

  getBackupMetadata(
    id: BackupMetadataId,
  ): Promise<BackupMetadataDto | undefined> {
    return Promise.resolve(this.backups.get(id));
  }

  createRestorePlan(plan: RestorePlanDto): Promise<RestorePlanDto> {
    if (this.restorePlans.has(plan.id)) {
      throw new Error(`restore plan already exists: ${plan.id}`);
    }
    const frozen = deepFreeze(structuredClone(plan));
    this.restorePlans.set(plan.id, frozen);
    return Promise.resolve(frozen);
  }

  getRestorePlan(id: RestorePlanId): Promise<RestorePlanDto | undefined> {
    return Promise.resolve(this.restorePlans.get(id));
  }

  createRestoreOperation(
    record: RestoreOperationRecordDto,
  ): Promise<RestoreOperationRecordDto> {
    if (this.restoreOperations.has(record.id)) {
      throw new Error(`restore operation already exists: ${record.id}`);
    }
    const frozen = deepFreeze(structuredClone(record));
    this.restoreOperations.set(record.id, frozen);
    return Promise.resolve(frozen);
  }

  updateRestoreOperation(
    record: RestoreOperationRecordDto,
  ): Promise<RestoreOperationRecordDto> {
    if (!this.restoreOperations.has(record.id)) {
      throw new Error(`unknown restore operation: ${record.id}`);
    }
    const frozen = deepFreeze(structuredClone(record));
    this.restoreOperations.set(record.id, frozen);
    return Promise.resolve(frozen);
  }

  getRestoreOperation(
    id: RestoreOperationId,
  ): Promise<RestoreOperationRecordDto | undefined> {
    return Promise.resolve(this.restoreOperations.get(id));
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
