import type {
  Condition,
  CoreBindingResolutionInput,
  CoreBindingValueResolution,
  JsonObject,
} from "takosumi-contract";
import { objectAddress } from "takosumi-contract";
import type {
  BindingSetRevision,
  BindingSetRevisionStore,
  MigrationCheckpoint,
  MigrationLedgerEntry,
  MigrationLedgerStore,
  ResourceBinding,
  ResourceBindingRole,
  ResourceBindingStore,
  ResourceInstance,
  ResourceInstanceId,
  ResourceInstanceStore,
  ResourceLifecycleStatus,
  ResourceOrigin,
  ResourceSharingMode,
  SecretBindingRef,
  SecretResolutionPolicy,
} from "../../domains/resources/mod.ts";
import type {
  SecretRecord,
  SecretStorePort,
} from "../../adapters/secret-store/mod.ts";
import { conflict, notFound } from "../../shared/errors.ts";
import type { IsoTimestamp } from "../../shared/time.ts";

export interface ResourceOperationStores {
  readonly instances: ResourceInstanceStore;
  readonly bindings: ResourceBindingStore;
  readonly bindingSetRevisions: BindingSetRevisionStore;
  readonly migrationLedger: MigrationLedgerStore;
  readonly secrets?: SecretStorePort;
}

export interface ResourceOperationServiceOptions {
  readonly stores: ResourceOperationStores;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
}

export interface CreateResourceInput {
  readonly id?: string;
  readonly spaceId: string;
  readonly groupId?: string;
  readonly contract: string;
  readonly origin?: ResourceOrigin;
  readonly sharingMode?: ResourceSharingMode;
  readonly provider?: string;
  readonly providerResourceId?: string;
  readonly providerMaterializationId?: string;
  readonly lifecycleStatus?: ResourceLifecycleStatus;
  readonly properties?: JsonObject;
}

export interface BindResourceInput {
  readonly id?: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly claimAddress: string;
  readonly instanceId: ResourceInstanceId;
  readonly role?: ResourceBindingRole;
  readonly revisionId?: string;
  readonly deploymentId?: string;
}

export interface BindResourceResult {
  readonly binding: ResourceBinding;
  readonly revision: BindingSetRevision;
}

export interface UnbindResourceInput {
  readonly bindingId: string;
  readonly revisionId?: string;
  readonly deploymentId?: string;
}

export interface UnbindResourceResult {
  readonly binding: ResourceBinding;
  readonly revision: BindingSetRevision;
}

export interface BindSecretInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly bindingName: string;
  readonly secretName: string;
  readonly resolution?: SecretResolutionPolicy;
  readonly pinnedVersionId?: string;
  readonly rollbackPolicy?: SecretBindingRef["rollbackPolicy"];
  readonly revisionId?: string;
  readonly deploymentId?: string;
}

export interface BindSecretResult {
  readonly revision: BindingSetRevision;
}

export interface MigrationCheckpointInput {
  readonly name: string;
  readonly checksum?: string;
  readonly metadata?: JsonObject;
}

export interface ValidateMigrationInput {
  readonly resourceInstanceId: ResourceInstanceId;
  readonly migrationRef: string;
  readonly checksum?: string;
  readonly checkpoints?: readonly MigrationCheckpointInput[];
}

export interface RecordMigrationInput extends ValidateMigrationInput {
  readonly id?: string;
  readonly spaceId?: string;
  readonly fromVersion?: string;
  readonly toVersion?: string;
  readonly status?: MigrationLedgerEntry["status"];
  readonly metadata?: JsonObject;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
}

export interface MigrationValidationResult {
  readonly resource: ResourceInstance;
  readonly reusable: true;
}

export interface RestoreResourceInput {
  readonly id?: string;
  readonly resourceInstanceId: ResourceInstanceId;
  readonly restoreRef: string;
  readonly mode: "snapshot" | "point-in-time" | "provider-native";
  readonly sourceBackupRef?: string;
  readonly sourceProviderResourceId?: string;
  readonly sourceProviderMaterializationId?: string;
  readonly expectedResourceGeneration?: number;
  readonly expectedProvider?: string;
  readonly expectedProviderResourceId?: string;
  readonly expectedProviderMaterializationId?: string;
  readonly checksum?: string;
  readonly completedAt?: IsoTimestamp;
}

export interface ResourceOperationResult {
  readonly kind: "restore";
  readonly resource: ResourceInstance;
  readonly ledgerEntry: MigrationLedgerEntry;
}

export class ResourceOperationService {
  readonly #stores: ResourceOperationStores;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;

  constructor(options: ResourceOperationServiceOptions) {
    this.#stores = options.stores;
    this.#idFactory = options.idFactory ?? crypto.randomUUID;
    this.#clock = options.clock ?? (() => new Date());
  }

  async createResource(input: CreateResourceInput): Promise<ResourceInstance> {
    const now = this.#now();
    return await this.#stores.instances.create({
      id: input.id ?? this.#idFactory(),
      spaceId: input.spaceId,
      groupId: input.groupId,
      contract: input.contract,
      origin: input.origin ?? "managed",
      sharingMode: input.sharingMode ?? "exclusive",
      provider: input.provider,
      providerResourceId: input.providerResourceId,
      providerMaterializationId: input.providerMaterializationId,
      lifecycle: {
        status: input.lifecycleStatus ?? "ready",
        generation: 1,
        updatedAt: now,
      },
      properties: input.properties,
      createdAt: now,
      updatedAt: now,
    });
  }

  async bindResource(input: BindResourceInput): Promise<BindResourceResult> {
    const instance = await this.#stores.instances.get(input.instanceId);
    if (!instance) {
      throw notFound("ResourceInstance not found", {
        resourceInstanceId: input.instanceId,
      });
    }
    if (instance.spaceId !== input.spaceId) {
      throw conflict("ResourceInstance belongs to a different space", {
        resourceInstanceId: input.instanceId,
        resourceSpaceId: instance.spaceId,
        requestedSpaceId: input.spaceId,
      });
    }
    const activeBindingIds = await this.#activeResourceBindingIds(
      input.groupId,
    );
    await this.#assertBindingAllowed(instance, input);
    const existing = (await this.#stores.bindings.listByGroup(input.groupId))
      .find((binding) =>
        activeBindingIds.has(binding.id) &&
        binding.claimAddress === input.claimAddress
      );
    if (existing) {
      throw conflict("Resource claim is already bound", {
        groupId: input.groupId,
        claimAddress: input.claimAddress,
        bindingId: existing.id,
      });
    }

    const now = this.#now();
    const binding = await this.#stores.bindings.create({
      id: input.id ?? this.#idFactory(),
      spaceId: input.spaceId,
      groupId: input.groupId,
      claimAddress: input.claimAddress,
      instanceId: input.instanceId,
      role: input.role ?? defaultBindingRole(instance),
      createdAt: now,
      updatedAt: now,
    });
    const revision = await this.#writeBindingSetRevision({
      groupId: input.groupId,
      spaceId: input.spaceId,
      revisionId: input.revisionId,
      deploymentId: input.deploymentId,
      resourceBindingIds: [...activeBindingIds, binding.id],
      now,
    });
    return Object.freeze({ binding, revision });
  }

  async unbindResource(
    input: UnbindResourceInput,
  ): Promise<UnbindResourceResult> {
    const binding = await this.#stores.bindings.get(input.bindingId);
    if (!binding) {
      throw notFound("ResourceBinding not found", {
        bindingId: input.bindingId,
      });
    }
    const now = this.#now();
    const activeBindingIds = await this.#activeResourceBindingIds(
      binding.groupId,
    );
    if (!activeBindingIds.has(binding.id)) {
      throw conflict("ResourceBinding is not active", {
        bindingId: binding.id,
        groupId: binding.groupId,
      });
    }
    const remainingBindingIds = [...activeBindingIds].filter((id) =>
      id !== binding.id
    );
    const revision = await this.#writeBindingSetRevision({
      groupId: binding.groupId,
      spaceId: binding.spaceId,
      revisionId: input.revisionId,
      deploymentId: input.deploymentId,
      resourceBindingIds: remainingBindingIds,
      now,
    });
    return Object.freeze({ binding, revision });
  }

  async bindSecret(input: BindSecretInput): Promise<BindSecretResult> {
    if (!this.#stores.secrets) {
      throw conflict("Secret store is not configured", {
        groupId: input.groupId,
        bindingName: input.bindingName,
      });
    }
    const latest = await this.#activeBindingSet(input.groupId);
    const secretBinding: SecretBindingRef = {
      bindingName: input.bindingName,
      secretName: input.secretName,
      resolution: input.resolution ?? "latest-at-activation",
      pinnedVersionId: input.pinnedVersionId,
      rollbackPolicy: input.rollbackPolicy ?? "reuse-pinned-version",
    };
    if (
      secretBinding.resolution === "pinned-version" &&
      !secretBinding.pinnedVersionId
    ) {
      throw conflict("Pinned secret binding requires a version", {
        groupId: input.groupId,
        bindingName: input.bindingName,
        secretName: input.secretName,
      });
    }
    const revision = await this.#writeBindingSetRevision({
      groupId: input.groupId,
      spaceId: input.spaceId,
      revisionId: input.revisionId,
      deploymentId: input.deploymentId,
      resourceBindingIds: latest.resourceBindingIds,
      secretBindings: [
        ...latest.secretBindings.filter((binding) =>
          binding.bindingName !== input.bindingName
        ),
        secretBinding,
      ],
      now: this.#now(),
    });
    return Object.freeze({ revision });
  }

  async validateMigration(
    input: ValidateMigrationInput,
  ): Promise<MigrationValidationResult> {
    const resource = await this.#migrationResource(input.resourceInstanceId);
    const entries = await this.#stores.migrationLedger.listByResource(
      input.resourceInstanceId,
    );
    for (const entry of entries) {
      if (entry.migrationRef !== input.migrationRef) continue;
      assertMigrationChecksumUnchanged(entry, input);
    }
    return Object.freeze({ resource, reusable: true });
  }

  async recordMigration(
    input: RecordMigrationInput,
  ): Promise<MigrationLedgerEntry> {
    const validation = await this.validateMigration(input);
    const now = this.#now();
    const status = input.status ?? "completed";
    const ledgerEntry = await this.#stores.migrationLedger.append({
      id: input.id ?? this.#idFactory(),
      spaceId: input.spaceId ?? validation.resource.spaceId,
      resourceInstanceId: input.resourceInstanceId,
      migrationRef: input.migrationRef,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      status,
      checkpoints: toLedgerCheckpoints(input.checkpoints ?? [], now),
      startedAt: input.startedAt ?? now,
      completedAt: input.completedAt ??
        (status === "completed" || status === "rolled-forward"
          ? now
          : undefined),
      metadata: withMigrationChecksum(input.metadata, input.checksum),
    });
    if (status === "completed" || status === "rolled-forward") {
      await this.#stores.instances.update({
        ...validation.resource,
        lifecycle: {
          ...validation.resource.lifecycle,
          status: "ready",
          generation: validation.resource.lifecycle.generation + 1,
          conditions: upsertCondition(
            validation.resource.lifecycle.conditions,
            {
              type: "ResourceMigrationApplied",
              status: "true",
              message:
                `Migration ${input.migrationRef} advanced durable resource state.`,
              observedGeneration: validation.resource.lifecycle.generation + 1,
              lastTransitionAt: ledgerEntry.completedAt ?? now,
            },
          ),
          updatedAt: ledgerEntry.completedAt ?? now,
        },
        updatedAt: ledgerEntry.completedAt ?? now,
      });
    }
    return ledgerEntry;
  }

  async restoreResource(
    input: RestoreResourceInput,
  ): Promise<ResourceOperationResult> {
    const resource = await this.#getResource(input.resourceInstanceId);
    this.#assertRestoreAllowed(resource, input);
    const completedAt = input.completedAt ?? this.#now();
    const ledgerEntry = await this.#stores.migrationLedger.append({
      id: input.id ?? this.#idFactory(),
      spaceId: resource.spaceId,
      resourceInstanceId: resource.id,
      migrationRef: `restore:${input.restoreRef}`,
      status: "completed",
      checkpoints: [{
        name: "restore-completed",
        checksum: input.checksum,
        metadata: input.sourceBackupRef
          ? { sourceBackupRef: input.sourceBackupRef }
          : undefined,
        recordedAt: completedAt,
      }],
      startedAt: completedAt,
      completedAt,
      metadata: compactJsonObject({
        operationKind: "restore",
        restoreRef: input.restoreRef,
        restoreMode: input.mode,
        sourceBackupRef: input.sourceBackupRef,
        sourceProviderResourceId: input.sourceProviderResourceId,
        sourceProviderMaterializationId: input.sourceProviderMaterializationId,
        checksum: input.checksum,
      }),
    });
    const updated = await this.#stores.instances.update({
      ...resource,
      lifecycle: {
        ...resource.lifecycle,
        status: "ready",
        generation: resource.lifecycle.generation + 1,
        updatedAt: completedAt,
      },
      updatedAt: completedAt,
    });
    return Object.freeze({ kind: "restore", resource: updated, ledgerEntry });
  }

  async #migrationResource(
    resourceInstanceId: ResourceInstanceId,
  ): Promise<ResourceInstance> {
    const resource = await this.#getResource(resourceInstanceId);
    if (resource.lifecycle.status === "deleting") {
      throw conflict("Deleting resources cannot be migrated", {
        resourceInstanceId,
        lifecycleStatus: resource.lifecycle.status,
      });
    }
    if (resource.lifecycle.status === "deleted") {
      throw conflict("Deleted resources cannot be migrated", {
        resourceInstanceId,
        lifecycleStatus: resource.lifecycle.status,
      });
    }
    if (resource.origin === "imported-bind-only") {
      throw conflict("Imported bind-only resources cannot be migrated", {
        resourceInstanceId,
        origin: resource.origin,
      });
    }
    if (resource.sharingMode === "shared-readonly") {
      throw conflict("Shared readonly resources cannot be migrated", {
        resourceInstanceId,
        sharingMode: resource.sharingMode,
      });
    }
    return resource;
  }

  async #assertBindingAllowed(
    instance: ResourceInstance,
    input: BindResourceInput,
  ): Promise<void> {
    const requestedRole = input.role ?? defaultBindingRole(instance);
    if (
      instance.origin === "imported-bind-only" && requestedRole !== "bind-only"
    ) {
      throw conflict("Imported bind-only resources only allow bind-only role", {
        resourceInstanceId: instance.id,
        requestedRole,
      });
    }
    if (
      instance.sharingMode === "shared-readonly" &&
      requestedRole !== "readonly-consumer"
    ) {
      throw conflict("Shared readonly resources only allow readonly bindings", {
        resourceInstanceId: instance.id,
        requestedRole,
      });
    }
    if (
      instance.sharingMode === "shared-managed" &&
      requestedRole === "owner" &&
      instance.groupId !== undefined &&
      input.groupId !== instance.groupId
    ) {
      throw conflict(
        "Shared managed resources require consumer role outside owner group",
        {
          resourceInstanceId: instance.id,
          ownerGroupId: instance.groupId,
          requestedGroupId: input.groupId,
        },
      );
    }
    if (instance.sharingMode !== "exclusive") return;
    const existingBindings = await this.#stores.bindings.listByInstance(
      instance.id,
    );
    for (const binding of existingBindings) {
      if (binding.groupId === input.groupId) continue;
      const activeIds = await this.#activeResourceBindingIds(binding.groupId);
      if (!activeIds.has(binding.id)) continue;
      throw conflict("Exclusive resources cannot be shared across groups", {
        resourceInstanceId: instance.id,
        existingGroupId: binding.groupId,
        requestedGroupId: input.groupId,
      });
    }
  }

  #assertRestoreAllowed(
    resource: ResourceInstance,
    input: RestoreResourceInput,
  ): void {
    if (resource.lifecycle.status === "deleting") {
      throw conflict("Deleting resources cannot be restored", {
        resourceInstanceId: resource.id,
        lifecycleStatus: resource.lifecycle.status,
      });
    }
    if (resource.lifecycle.status === "deleted") {
      throw conflict("Deleted resources cannot be restored", {
        resourceInstanceId: resource.id,
        lifecycleStatus: resource.lifecycle.status,
      });
    }
    if (resource.origin === "imported-bind-only") {
      throw conflict("Imported bind-only resources cannot be restored", {
        resourceInstanceId: resource.id,
        origin: resource.origin,
      });
    }
    if (resource.origin === "external") {
      throw conflict("External resources cannot be restored by Takos", {
        resourceInstanceId: resource.id,
        origin: resource.origin,
      });
    }
    if (resource.sharingMode === "shared-readonly") {
      throw conflict("Shared readonly resources cannot be restored", {
        resourceInstanceId: resource.id,
        sharingMode: resource.sharingMode,
      });
    }
    if (
      input.expectedResourceGeneration !== undefined &&
      input.expectedResourceGeneration !== resource.lifecycle.generation
    ) {
      throw conflict("Restore target generation changed", {
        resourceInstanceId: resource.id,
        expectedGeneration: input.expectedResourceGeneration,
        actualGeneration: resource.lifecycle.generation,
      });
    }
    if (input.mode !== "provider-native") return;
    if (!input.sourceBackupRef) {
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
    assertExpectedValue("Provider-native restore provider changed", {
      resourceInstanceId: resource.id,
      expected: input.expectedProvider,
      actual: resource.provider,
      detailKey: "provider",
    });
    assertExpectedValue("Provider-native restore target changed", {
      resourceInstanceId: resource.id,
      expected: input.expectedProviderResourceId ??
        input.sourceProviderResourceId,
      actual: resource.providerResourceId,
      detailKey: "providerResourceId",
    });
    assertExpectedValue("Provider-native restore materialization changed", {
      resourceInstanceId: resource.id,
      expected: input.expectedProviderMaterializationId ??
        input.sourceProviderMaterializationId,
      actual: resource.providerMaterializationId,
      detailKey: "providerMaterializationId",
    });
  }

  async #getResource(
    resourceInstanceId: ResourceInstanceId,
  ): Promise<ResourceInstance> {
    const resource = await this.#stores.instances.get(resourceInstanceId);
    if (!resource) {
      throw notFound("ResourceInstance not found", { resourceInstanceId });
    }
    return resource;
  }

  async #writeBindingSetRevision(input: {
    readonly groupId: string;
    readonly spaceId: string;
    readonly revisionId?: string;
    readonly deploymentId?: string;
    readonly resourceBindingIds: readonly string[];
    readonly secretBindings?: readonly SecretBindingRef[];
    readonly now: IsoTimestamp;
  }): Promise<BindingSetRevision> {
    const revisionId = input.revisionId ?? this.#idFactory();
    const inputs = [
      ...await this.#bindingResolutionInputs(input.resourceBindingIds),
    ];
    const secretResolution = await this.#secretBindingResolutionInputs(
      revisionId,
      input.secretBindings ?? [],
      input.now,
    );
    inputs.push(...secretResolution.inputs);
    return await this.#stores.bindingSetRevisions.create({
      id: revisionId,
      spaceId: input.spaceId,
      groupId: input.groupId,
      componentAddress: objectAddress("group", input.groupId),
      structureDigest: await structureDigest(inputs),
      inputs,
      bindingValueResolutions: secretResolution.resolutions,
      conditions: secretResolution.conditions,
      deploymentId: input.deploymentId,
      resourceBindingIds: [...input.resourceBindingIds],
      secretBindings: [...(input.secretBindings ?? [])],
      publicationBindings: [],
      createdAt: input.now,
    });
  }

  async #activeResourceBindingIds(groupId: string): Promise<Set<string>> {
    return new Set((await this.#activeBindingSet(groupId)).resourceBindingIds);
  }

  async #activeBindingSet(groupId: string): Promise<{
    readonly resourceBindingIds: readonly string[];
    readonly secretBindings: readonly SecretBindingRef[];
  }> {
    const revisions = await this.#stores.bindingSetRevisions.listByGroup(
      groupId,
    );
    const latest =
      [...revisions].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
      )[0];
    if (latest) {
      return {
        resourceBindingIds: latest.resourceBindingIds,
        secretBindings: latest.secretBindings,
      };
    }
    return {
      resourceBindingIds: (await this.#stores.bindings.listByGroup(groupId))
        .map((binding) => binding.id),
      secretBindings: [],
    };
  }

  async #bindingResolutionInputs(
    resourceBindingIds: readonly string[],
  ): Promise<readonly CoreBindingResolutionInput[]> {
    const inputs: CoreBindingResolutionInput[] = [];
    for (const bindingId of resourceBindingIds) {
      const binding = await this.#stores.bindings.get(bindingId);
      if (!binding) continue;
      const resource = await this.#stores.instances.get(binding.instanceId);
      inputs.push({
        bindingName: binding.claimAddress,
        source: "resource",
        sourceAddress: resource
          ? `resource:${resource.id}`
          : `resource-binding:${binding.id}`,
        access: resource
          ? { contract: resource.contract, mode: binding.role }
          : undefined,
        injection: { mode: "runtime-binding", target: binding.claimAddress },
        sensitivity: "credential",
        enforcement: "enforced",
      });
    }
    return inputs.sort((a, b) =>
      a.bindingName.localeCompare(b.bindingName) ||
      a.sourceAddress.localeCompare(b.sourceAddress)
    );
  }

  async #secretBindingResolutionInputs(
    revisionId: string,
    secretBindings: readonly SecretBindingRef[],
    resolvedAt: IsoTimestamp,
  ): Promise<{
    readonly inputs: CoreBindingResolutionInput[];
    readonly resolutions: CoreBindingValueResolution[];
    readonly conditions: Condition[];
  }> {
    const inputs: CoreBindingResolutionInput[] = [];
    const resolutions: CoreBindingValueResolution[] = [];
    const conditions: Condition[] = [];
    const secrets = this.#stores.secrets;
    for (const binding of secretBindings) {
      const resolved = secrets
        ? await resolveSecretVersion(secrets, binding)
        : { record: undefined, unavailable: "secret store is not configured" };
      inputs.push({
        bindingName: binding.bindingName,
        source: "secret",
        sourceAddress: `secret:${binding.secretName}`,
        injection: { mode: "env", target: binding.bindingName },
        sensitivity: "secret",
        enforcement: "enforced",
      });
      resolutions.push({
        bindingSetRevisionId: revisionId,
        bindingName: binding.bindingName,
        sourceAddress: `secret:${binding.secretName}`,
        resolutionPolicy: binding.resolution,
        resolvedVersion: resolved.record?.version,
        resolvedAt,
        sensitivity: "secret",
      });
      const revoked = revokedReason(resolved.record);
      if (resolved.unavailable || revoked) {
        conditions.push({
          type: "BindingValueResolved",
          status: "false",
          reason: "RepairMaterializationRequired",
          message: resolved.unavailable ??
            `Secret version ${resolved.record?.version} for ${binding.secretName} is revoked: ${revoked}`,
          lastTransitionAt: resolvedAt,
        });
      }
    }
    return {
      inputs: inputs.sort(compareBindingInput),
      resolutions: resolutions.sort((a, b) =>
        a.bindingName.localeCompare(b.bindingName) ||
        a.sourceAddress.localeCompare(b.sourceAddress)
      ),
      conditions,
    };
  }

  #now(): IsoTimestamp {
    return this.#clock().toISOString();
  }
}

async function resolveSecretVersion(
  store: SecretStorePort,
  binding: SecretBindingRef,
): Promise<{ readonly record?: SecretRecord; readonly unavailable?: string }> {
  if (binding.resolution === "pinned-version") {
    const version = binding.pinnedVersionId;
    if (!version) {
      return {
        unavailable: `Pinned secret ${binding.secretName} has no version`,
      };
    }
    const record = await store.getSecretRecord({
      name: binding.secretName,
      version,
    });
    return record ? { record } : {
      unavailable:
        `Pinned secret version ${version} for ${binding.secretName} is unavailable`,
    };
  }
  const record = await store.latestSecret(binding.secretName);
  return record ? { record } : {
    unavailable:
      `Latest secret version for ${binding.secretName} is unavailable`,
  };
}

function revokedReason(record: SecretRecord | undefined): string | undefined {
  if (!record) return undefined;
  const status = record.metadata.status;
  if (status === "revoked") return "status=revoked";
  const revokedAt = record.metadata.revokedAt;
  if (typeof revokedAt === "string") return `revokedAt=${revokedAt}`;
  return undefined;
}

function compareBindingInput(
  a: CoreBindingResolutionInput,
  b: CoreBindingResolutionInput,
): number {
  return a.bindingName.localeCompare(b.bindingName) ||
    a.sourceAddress.localeCompare(b.sourceAddress);
}

function defaultBindingRole(instance: ResourceInstance): ResourceBindingRole {
  if (instance.origin === "imported-bind-only") return "bind-only";
  if (instance.sharingMode === "shared-readonly") return "readonly-consumer";
  return "owner";
}

function toLedgerCheckpoints(
  checkpoints: readonly MigrationCheckpointInput[],
  recordedAt: IsoTimestamp,
): readonly MigrationCheckpoint[] {
  return checkpoints.map((checkpoint) => ({
    name: checkpoint.name,
    checksum: checkpoint.checksum,
    metadata: checkpoint.metadata,
    recordedAt,
  }));
}

function withMigrationChecksum(
  metadata: JsonObject | undefined,
  checksum: string | undefined,
): JsonObject | undefined {
  if (!checksum) return metadata;
  return { ...(metadata ?? {}), checksum };
}

function assertMigrationChecksumUnchanged(
  entry: MigrationLedgerEntry,
  input: ValidateMigrationInput,
): void {
  const existingChecksum = stringValue(entry.metadata?.checksum) ??
    stringValue(entry.metadata?.migrationChecksum);
  if (
    existingChecksum && input.checksum && existingChecksum !== input.checksum
  ) {
    throw conflict("Applied migration checksum changed", {
      resourceInstanceId: input.resourceInstanceId,
      migrationRef: input.migrationRef,
      expectedChecksum: existingChecksum,
      actualChecksum: input.checksum,
    });
  }
  for (const checkpoint of input.checkpoints ?? []) {
    if (!checkpoint.checksum) continue;
    const existingCheckpoint = entry.checkpoints.find((item) =>
      item.name === checkpoint.name && item.checksum !== undefined
    );
    if (
      existingCheckpoint?.checksum &&
      existingCheckpoint.checksum !== checkpoint.checksum
    ) {
      throw conflict("Applied migration checkpoint checksum changed", {
        resourceInstanceId: input.resourceInstanceId,
        migrationRef: input.migrationRef,
        checkpoint: checkpoint.name,
        expectedChecksum: existingCheckpoint.checksum,
        actualChecksum: checkpoint.checksum,
      });
    }
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compactJsonObject(
  value: Record<string, string | undefined>,
): JsonObject {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item;
  }
  return result;
}

function upsertCondition(
  conditions: readonly Condition[] | undefined,
  next: Condition,
): readonly Condition[] {
  return [
    ...(conditions ?? []).filter((condition) => condition.type !== next.type),
    next,
  ];
}

function assertExpectedValue(
  message: string,
  input: {
    readonly resourceInstanceId: ResourceInstanceId;
    readonly expected?: string;
    readonly actual?: string;
    readonly detailKey: string;
  },
): void {
  if (input.expected === undefined) return;
  if (input.expected === input.actual) return;
  throw conflict(message, {
    resourceInstanceId: input.resourceInstanceId,
    expected: input.expected,
    actual: input.actual,
    detailKey: input.detailKey,
  });
}

async function structureDigest(
  inputs: readonly CoreBindingResolutionInput[],
): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(inputs));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${
    Array.from(new Uint8Array(digest)).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${
      entries.map(([key, item]) =>
        `${JSON.stringify(key)}:${stableStringify(item)}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
