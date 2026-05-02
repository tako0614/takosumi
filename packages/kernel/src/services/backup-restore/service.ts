// Backup / restore service — Deployment-centric port.
//
// Resource-side restore semantics (snapshot / point-in-time / provider-native)
// remain owned by this service because they live below the Deployment record
// and operate on `ResourceInstance` lifecycle entries directly. Group-level
// "rollback the whole deployment" is delegated to
// `DeploymentService.rollbackGroup()`, which atomically advances the
// `GroupHead` pointer back to the previous Deployment. The retained
// `Deployment.input.manifest_snapshot` and
// `Deployment.resolution.descriptor_closure` provide the required artefacts.

import type { Deployment, GroupHead, JsonObject } from "takosumi-contract";
import type {
  ResourceInstance,
  ResourceInstanceId,
  ResourceInstanceStore,
} from "../../domains/resources/mod.ts";
import type { ResourceOperationService } from "../resources/mod.ts";
import { conflict, notFound } from "../../shared/errors.ts";
import type { IsoTimestamp } from "../../shared/time.ts";
import type { BackupRestoreStore } from "./store.ts";
import type {
  BackupMetadataDto,
  BackupMetadataId,
  BackupResourceMetadataDto,
  ResourceRestoreSupportDto,
  RestoreMode,
  RestoreOperationRecordDto,
  RestorePlanDto,
  RestorePlanResourceDto,
} from "./types.ts";

/**
 * Subset of the deploy-domain `DeploymentService` used by backup/restore for
 * group-level rollback. Kept as a structural interface so this service stays
 * decoupled from the concrete `DeploymentService` class while Phase 3 Agent A
 * finalises it.
 */
export interface BackupRestoreDeploymentClient {
  rollbackGroup(input: BackupRestoreRollbackGroupInput): Promise<{
    readonly deployment: Deployment;
    readonly groupHead: GroupHead;
  }>;
}

export interface BackupRestoreRollbackGroupInput {
  readonly spaceId: string;
  readonly groupId: string;
  /**
   * Optional target Deployment id. When omitted, the deployment service
   * rolls the GroupHead back one step (current -> previous).
   */
  readonly targetDeploymentId?: string;
  readonly reason?: string;
  readonly actor?: { readonly accountId?: string };
}

export interface BackupRestoreServiceStores {
  readonly backupRestore: BackupRestoreStore;
  readonly resources: ResourceInstanceStore;
  readonly resourceOperations?: Pick<
    ResourceOperationService,
    "restoreResource"
  >;
}

export interface BackupRestoreProviderSupport {
  readonly provider: string;
  readonly restoreModes: readonly RestoreMode[];
}

export interface BackupRestoreServiceOptions {
  readonly stores: BackupRestoreServiceStores;
  readonly providerSupport?: readonly BackupRestoreProviderSupport[];
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  /**
   * Optional deployment-domain client used for group-level rollback. When
   * absent, callers must perform Deployment rollback themselves.
   */
  readonly deploymentService?: BackupRestoreDeploymentClient;
}

export interface RegisterBackupMetadataInput {
  readonly id?: BackupMetadataId;
  readonly spaceId: string;
  readonly groupId?: string;
  readonly status?: BackupMetadataDto["status"];
  readonly resources: BackupMetadataDto["resources"];
  readonly createdAt?: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly metadata?: JsonObject;
}

export interface PlanRestoreInput {
  readonly id?: string;
  readonly backupId: BackupMetadataId;
  readonly resourceInstanceIds: readonly ResourceInstanceId[];
  readonly mode: RestoreMode;
  readonly createdBy?: string;
  readonly metadata?: JsonObject;
}

export interface StartRestoreInput {
  readonly id?: string;
  readonly planId: string;
  readonly metadata?: JsonObject;
}

export interface CompleteRestoreInput {
  readonly operationId: string;
  readonly error?: string;
}

export class BackupRestoreService {
  readonly #stores: BackupRestoreServiceStores;
  readonly #providerSupport: ReadonlyMap<string, readonly RestoreMode[]>;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;
  readonly #deploymentService?: BackupRestoreDeploymentClient;

  constructor(options: BackupRestoreServiceOptions) {
    this.#stores = options.stores;
    this.#providerSupport = new Map(
      (options.providerSupport ?? []).map((item) => [
        item.provider,
        [...item.restoreModes],
      ]),
    );
    this.#idFactory = options.idFactory ?? crypto.randomUUID;
    this.#clock = options.clock ?? (() => new Date());
    this.#deploymentService = options.deploymentService;
  }

  /**
   * Group-level rollback. Delegates to `DeploymentService.rollbackGroup`,
   * which atomically advances the `GroupHead` pointer back to the previous
   * Deployment. Resource-level restore (snapshot / point-in-time /
   * provider-native) is a separate concern and goes through `planRestore`.
   */
  async rollbackGroup(
    input: BackupRestoreRollbackGroupInput,
  ): Promise<
    { readonly deployment: Deployment; readonly groupHead: GroupHead }
  > {
    if (!this.#deploymentService) {
      throw conflict(
        "Deployment service is required for group rollback",
        { spaceId: input.spaceId, groupId: input.groupId },
      );
    }
    return await this.#deploymentService.rollbackGroup(input);
  }

  async registerBackupMetadata(
    input: RegisterBackupMetadataInput,
  ): Promise<BackupMetadataDto> {
    const now = this.#now();
    const resources: BackupResourceMetadataDto[] = [];
    for (const backupResource of input.resources) {
      const resource = await this.#getResource(
        backupResource.resourceInstanceId,
      );
      if (resource.spaceId !== input.spaceId) {
        throw conflict("Backup resource belongs to a different space", {
          backupId: input.id,
          resourceInstanceId: resource.id,
          resourceSpaceId: resource.spaceId,
          backupSpaceId: input.spaceId,
        });
      }
      if (input.groupId !== undefined && resource.groupId !== input.groupId) {
        throw conflict("Backup resource belongs to a different group", {
          backupId: input.id,
          resourceInstanceId: resource.id,
          resourceGroupId: resource.groupId,
          backupGroupId: input.groupId,
        });
      }
      assertBackupResourceMatchesCurrent(backupResource, resource);
      resources.push({
        ...backupResource,
        provider: backupResource.provider ?? resource.provider,
        providerResourceId: backupResource.providerResourceId ??
          resource.providerResourceId,
        providerMaterializationId: backupResource.providerMaterializationId ??
          resource.providerMaterializationId,
        capturedGeneration: backupResource.capturedGeneration ??
          resource.lifecycle.generation,
      });
    }
    return await this.#stores.backupRestore.putBackupMetadata({
      id: input.id ?? this.#idFactory(),
      spaceId: input.spaceId,
      groupId: input.groupId,
      status: input.status ?? "available",
      resources,
      createdAt: input.createdAt ?? now,
      expiresAt: input.expiresAt,
      metadata: input.metadata,
    });
  }

  async checkResourceRestoreSupport(
    resourceInstanceId: ResourceInstanceId,
    mode?: RestoreMode,
  ): Promise<ResourceRestoreSupportDto> {
    const resource = await this.#getResource(resourceInstanceId);
    return this.#supportForResource(resource, mode);
  }

  async planRestore(input: PlanRestoreInput): Promise<RestorePlanDto> {
    const backup = await this.#getBackup(input.backupId);
    if (backup.status !== "available") {
      throw conflict("Backup is not available for restore", {
        backupId: backup.id,
        status: backup.status,
      });
    }
    const now = this.#now();
    if (backup.expiresAt && backup.expiresAt <= now) {
      throw conflict("Backup rollback window expired", {
        backupId: backup.id,
        expiresAt: backup.expiresAt,
        now,
      });
    }

    const resources: RestorePlanResourceDto[] = [];
    for (const resourceInstanceId of input.resourceInstanceIds) {
      const resource = await this.#getResource(resourceInstanceId);
      if (resource.spaceId !== backup.spaceId) {
        throw conflict("Restore target belongs to a different space", {
          backupId: backup.id,
          resourceInstanceId,
          resourceSpaceId: resource.spaceId,
          backupSpaceId: backup.spaceId,
        });
      }
      const backupResource = backup.resources.find((item) =>
        item.resourceInstanceId === resourceInstanceId
      );
      if (!backupResource) {
        throw conflict("Backup does not contain requested resource", {
          backupId: backup.id,
          resourceInstanceId,
        });
      }
      assertResourceRestorable(resource, input.mode);
      assertBackupResourceMatchesCurrent(backupResource, resource);
      const support = this.#supportForResource(resource, input.mode);
      if (!support.supported) {
        throw conflict("Resource provider does not support restore", {
          resourceInstanceId,
          provider: resource.provider,
          mode: input.mode,
          reason: support.reason,
        });
      }
      if (input.mode === "provider-native") {
        assertProviderNativeRestoreSafe(resource, backupResource);
      }
      resources.push({
        resourceInstanceId,
        backupId: backup.id,
        mode: input.mode,
        provider: resource.provider,
        providerResourceId: resource.providerResourceId,
        providerMaterializationId: resource.providerMaterializationId,
        providerBackupRef: backupResource.providerBackupRef,
        checksum: backupResource.checksum,
        targetGeneration: resource.lifecycle.generation,
        support,
      });
    }

    return await this.#stores.backupRestore.createRestorePlan({
      id: input.id ?? this.#idFactory(),
      kind: "restore-plan",
      spaceId: backup.spaceId,
      groupId: backup.groupId,
      resources,
      createdAt: this.#now(),
      createdBy: input.createdBy,
      metadata: input.metadata,
    });
  }

  async startRestore(
    input: StartRestoreInput,
  ): Promise<RestoreOperationRecordDto> {
    const plan = await this.#stores.backupRestore.getRestorePlan(input.planId);
    if (!plan) {
      throw notFound("RestorePlan not found", { planId: input.planId });
    }
    for (const planResource of plan.resources) {
      const resource = await this.#getResource(planResource.resourceInstanceId);
      if (
        resource.lifecycle.generation !== planResource.targetGeneration ||
        resource.providerResourceId !== planResource.providerResourceId ||
        resource.providerMaterializationId !==
          planResource.providerMaterializationId
      ) {
        throw conflict("Restore target changed after plan", {
          planId: plan.id,
          resourceInstanceId: resource.id,
          plannedGeneration: planResource.targetGeneration,
          actualGeneration: resource.lifecycle.generation,
          plannedProviderResourceId: planResource.providerResourceId,
          actualProviderResourceId: resource.providerResourceId,
          plannedProviderMaterializationId:
            planResource.providerMaterializationId,
          actualProviderMaterializationId: resource.providerMaterializationId,
        });
      }
    }
    const now = this.#now();
    return await this.#stores.backupRestore.createRestoreOperation({
      id: input.id ?? this.#idFactory(),
      planId: plan.id,
      kind: "restore",
      status: "running",
      spaceId: plan.spaceId,
      groupId: plan.groupId,
      resourceInstanceIds: plan.resources.map((item) =>
        item.resourceInstanceId
      ),
      startedAt: now,
      metadata: input.metadata,
    });
  }

  async completeRestore(
    input: CompleteRestoreInput,
  ): Promise<RestoreOperationRecordDto> {
    const record = await this.#stores.backupRestore.getRestoreOperation(
      input.operationId,
    );
    if (!record) {
      throw notFound("RestoreOperation not found", {
        operationId: input.operationId,
      });
    }
    if (record.status !== "running") {
      throw conflict("RestoreOperation is not running", {
        operationId: input.operationId,
        status: record.status,
      });
    }
    const completedAt = this.#now();
    const restoreResults = input.error
      ? []
      : await this.#applyResourceRestoreOperations(record, completedAt);
    return await this.#stores.backupRestore.updateRestoreOperation({
      ...record,
      status: input.error ? "failed" : "completed",
      completedAt,
      error: input.error,
      metadata: restoreResults.length > 0
        ? {
          ...(record.metadata ?? {}),
          resourceRestoreLedgerIds: restoreResults.map((result) =>
            result.ledgerEntry.id
          ),
        }
        : record.metadata,
    });
  }

  async #applyResourceRestoreOperations(
    record: RestoreOperationRecordDto,
    completedAt: IsoTimestamp,
  ): Promise<
    readonly Awaited<
      ReturnType<ResourceOperationService["restoreResource"]>
    >[]
  > {
    const resourceOperations = this.#stores.resourceOperations;
    if (!resourceOperations) {
      throw conflict(
        "Restore completion requires resource operation restore semantics",
        { operationId: record.id, planId: record.planId },
      );
    }
    const plan = await this.#stores.backupRestore.getRestorePlan(record.planId);
    if (!plan) {
      throw notFound("RestorePlan not found", { planId: record.planId });
    }
    const results: Awaited<
      ReturnType<ResourceOperationService["restoreResource"]>
    >[] = [];
    for (const resource of plan.resources) {
      results.push(
        await resourceOperations.restoreResource({
          id: `resource-restore:${record.id}:${resource.resourceInstanceId}`,
          resourceInstanceId: resource.resourceInstanceId,
          restoreRef: resource.backupId,
          mode: resource.mode,
          sourceBackupRef: resource.providerBackupRef,
          sourceProviderResourceId: resource.providerResourceId,
          sourceProviderMaterializationId: resource.providerMaterializationId,
          expectedResourceGeneration: resource.targetGeneration,
          expectedProvider: resource.provider,
          expectedProviderResourceId: resource.providerResourceId,
          expectedProviderMaterializationId: resource.providerMaterializationId,
          checksum: resource.checksum,
          completedAt,
        }),
      );
    }
    return results;
  }

  async #getBackup(id: BackupMetadataId): Promise<BackupMetadataDto> {
    const backup = await this.#stores.backupRestore.getBackupMetadata(id);
    if (!backup) throw notFound("BackupMetadata not found", { backupId: id });
    return backup;
  }

  async #getResource(id: ResourceInstanceId): Promise<ResourceInstance> {
    const resource = await this.#stores.resources.get(id);
    if (!resource) {
      throw notFound("ResourceInstance not found", { resourceInstanceId: id });
    }
    return resource;
  }

  #supportForResource(
    resource: ResourceInstance,
    mode?: RestoreMode,
  ): ResourceRestoreSupportDto {
    const provider = resource.provider;
    const supportedModes = provider
      ? this.#providerSupport.get(provider) ?? []
      : [];
    if (!provider) {
      return {
        resourceInstanceId: resource.id,
        provider,
        supported: false,
        supportedModes,
        reason: "resource has no provider",
      };
    }
    if (supportedModes.length === 0) {
      return {
        resourceInstanceId: resource.id,
        provider,
        supported: false,
        supportedModes,
        reason: "provider has no registered restore support",
      };
    }
    if (mode && !supportedModes.includes(mode)) {
      return {
        resourceInstanceId: resource.id,
        provider,
        supported: false,
        supportedModes,
        reason: "restore mode is not supported by provider",
      };
    }
    return {
      resourceInstanceId: resource.id,
      provider,
      supported: true,
      supportedModes,
    };
  }

  #now(): IsoTimestamp {
    return this.#clock().toISOString();
  }
}

function assertBackupResourceMatchesCurrent(
  backupResource: BackupResourceMetadataDto,
  resource: ResourceInstance,
): void {
  if (backupResource.contract !== resource.contract) {
    throw conflict("Backup resource contract does not match current resource", {
      resourceInstanceId: resource.id,
      backupContract: backupResource.contract,
      currentContract: resource.contract,
    });
  }
  if (
    backupResource.provider !== undefined &&
    backupResource.provider !== resource.provider
  ) {
    throw conflict("Backup resource provider does not match current resource", {
      resourceInstanceId: resource.id,
      backupProvider: backupResource.provider,
      currentProvider: resource.provider,
    });
  }
  if (
    backupResource.providerResourceId !== undefined &&
    backupResource.providerResourceId !== resource.providerResourceId
  ) {
    throw conflict(
      "Backup resource provider identity does not match current resource",
      {
        resourceInstanceId: resource.id,
        backupProviderResourceId: backupResource.providerResourceId,
        currentProviderResourceId: resource.providerResourceId,
      },
    );
  }
}

function assertResourceRestorable(
  resource: ResourceInstance,
  mode: RestoreMode,
): void {
  if (resource.lifecycle.status === "deleting") {
    throw conflict("Deleting resources cannot be restored", {
      resourceInstanceId: resource.id,
      lifecycleStatus: resource.lifecycle.status,
      mode,
    });
  }
  if (resource.lifecycle.status === "deleted") {
    throw conflict("Deleted resources cannot be restored", {
      resourceInstanceId: resource.id,
      lifecycleStatus: resource.lifecycle.status,
      mode,
    });
  }
  if (resource.origin === "imported-bind-only") {
    throw conflict("Imported bind-only resources cannot be restored", {
      resourceInstanceId: resource.id,
      origin: resource.origin,
      mode,
    });
  }
  if (resource.origin === "external") {
    throw conflict("External resources cannot be restored by Takos", {
      resourceInstanceId: resource.id,
      origin: resource.origin,
      mode,
    });
  }
  if (resource.sharingMode === "shared-readonly") {
    throw conflict("Shared readonly resources cannot be restored", {
      resourceInstanceId: resource.id,
      sharingMode: resource.sharingMode,
      mode,
    });
  }
}

function assertProviderNativeRestoreSafe(
  resource: ResourceInstance,
  backupResource: BackupResourceMetadataDto,
): void {
  if (!backupResource.providerBackupRef) {
    throw conflict("Provider-native restore requires provider backup ref", {
      resourceInstanceId: resource.id,
    });
  }
  if (!resource.provider || !resource.providerResourceId) {
    throw conflict(
      "Provider-native restore requires managed provider identity",
      {
        resourceInstanceId: resource.id,
        provider: resource.provider,
        providerResourceId: resource.providerResourceId,
      },
    );
  }
  if (backupResource.provider !== resource.provider) {
    throw conflict("Provider-native restore requires same provider", {
      resourceInstanceId: resource.id,
      backupProvider: backupResource.provider,
      currentProvider: resource.provider,
    });
  }
  if (!backupResource.providerResourceId) {
    throw conflict(
      "Provider-native restore requires backup provider identity",
      {
        resourceInstanceId: resource.id,
        provider: resource.provider,
      },
    );
  }
  if (backupResource.providerResourceId !== resource.providerResourceId) {
    throw conflict("Provider-native restore target changed", {
      resourceInstanceId: resource.id,
      backupProviderResourceId: backupResource.providerResourceId,
      currentProviderResourceId: resource.providerResourceId,
    });
  }
  if (!backupResource.providerMaterializationId) {
    throw conflict(
      "Provider-native restore requires backup materialization identity",
      {
        resourceInstanceId: resource.id,
        provider: resource.provider,
      },
    );
  }
  if (!resource.providerMaterializationId) {
    throw conflict(
      "Provider-native restore requires current materialization identity",
      {
        resourceInstanceId: resource.id,
        provider: resource.provider,
      },
    );
  }
  if (
    backupResource.providerMaterializationId !==
      resource.providerMaterializationId
  ) {
    throw conflict("Provider-native restore materialization changed", {
      resourceInstanceId: resource.id,
      backupProviderMaterializationId: backupResource.providerMaterializationId,
      currentProviderMaterializationId: resource.providerMaterializationId,
    });
  }
}
