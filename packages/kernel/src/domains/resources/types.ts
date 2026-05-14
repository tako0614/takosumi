import type {
  Condition,
  CoreBindingResolutionInput,
  CoreBindingValueResolution,
  Digest,
  JsonObject,
  ObjectAddress,
} from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";
import type { SpaceId } from "../../shared/ids.ts";

export type { SpaceId };
export type ResourceInstanceId = string;
export type ResourceBindingId = string;
export type BindingSetRevisionId = string;
export type MigrationLedgerId = string;
export type GroupId = string;

export type ResourceOrigin =
  | "managed"
  | "imported-managed"
  | "imported-bind-only"
  | "external";
export type ResourceSharingMode =
  | "exclusive"
  | "shared-readonly"
  | "shared-managed";
export type ResourceLifecycleStatus =
  | "pending"
  | "ready"
  | "degraded"
  | "failed"
  | "deleting"
  | "deleted";
export type ResourceBindingRole =
  | "owner"
  | "consumer"
  | "readonly-consumer"
  | "schema-owner"
  | "bind-only";

export interface ResourceLifecycle {
  readonly status: ResourceLifecycleStatus;
  readonly generation: number;
  readonly conditions?: readonly Condition[];
  readonly updatedAt: IsoTimestamp;
}

export interface ResourceSchemaOwner {
  readonly groupId: GroupId;
  readonly resourceClaimName: string;
}

export interface ResourceInstance {
  readonly id: ResourceInstanceId;
  readonly spaceId: SpaceId;
  readonly groupId?: GroupId;
  readonly contract: string;
  readonly origin: ResourceOrigin;
  readonly sharingMode: ResourceSharingMode;
  readonly provider?: string;
  readonly providerResourceId?: string;
  readonly providerMaterializationId?: string;
  readonly lifecycle: ResourceLifecycle;
  readonly schemaOwner?: ResourceSchemaOwner;
  readonly properties?: JsonObject;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ResourceBinding {
  readonly id: ResourceBindingId;
  readonly spaceId: SpaceId;
  readonly groupId: GroupId;
  readonly claimAddress: string;
  readonly instanceId: ResourceInstanceId;
  readonly role: ResourceBindingRole;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type SecretResolutionPolicy = "latest-at-activation" | "pinned-version";
export type SecretRollbackPolicy = "re-resolve" | "reuse-pinned-version";

export interface SecretBindingRef {
  readonly bindingName: string;
  readonly secretName: string;
  readonly resolution: SecretResolutionPolicy;
  readonly pinnedVersionId?: string;
  readonly rollbackPolicy: SecretRollbackPolicy;
}

export type OutputInjectionValueType =
  | "string"
  | "url"
  | "json"
  | "secret-ref"
  | "service";

export interface OutputInjection {
  readonly env?: string;
  readonly binding?: string;
  readonly valueType: OutputInjectionValueType;
  readonly explicit: true;
}

export interface OutputConsumerBinding {
  readonly outputAddress: string;
  readonly contract: string;
  readonly outputs: Readonly<Record<string, OutputInjection>>;
  readonly grantRef: string;
  readonly resolution: SecretResolutionPolicy;
}

export interface BindingSetRevision {
  readonly id: BindingSetRevisionId;
  readonly spaceId: SpaceId;
  readonly groupId: GroupId;
  readonly componentAddress?: ObjectAddress;
  readonly structureDigest?: Digest;
  readonly inputs?: readonly CoreBindingResolutionInput[];
  readonly bindingValueResolutions?: readonly CoreBindingValueResolution[];
  readonly conditions?: readonly Condition[];
  readonly deploymentId?: string;
  readonly resourceBindingIds: readonly ResourceBindingId[];
  readonly secretBindings: readonly SecretBindingRef[];
  readonly outputConsumerBindings: readonly OutputConsumerBinding[];
  readonly createdAt: IsoTimestamp;
}

export type MigrationLedgerStatus =
  | "started"
  | "checkpointed"
  | "completed"
  | "failed"
  | "rolled-forward";

export interface MigrationCheckpoint {
  readonly name: string;
  readonly checksum?: string;
  readonly metadata?: JsonObject;
  readonly recordedAt: IsoTimestamp;
}

export interface MigrationLedgerEntry {
  readonly id: MigrationLedgerId;
  readonly spaceId: SpaceId;
  readonly resourceInstanceId: ResourceInstanceId;
  readonly migrationRef: string;
  readonly fromVersion?: string;
  readonly toVersion?: string;
  readonly status: MigrationLedgerStatus;
  readonly checkpoints: readonly MigrationCheckpoint[];
  readonly startedAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly metadata?: JsonObject;
}
