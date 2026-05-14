import type { CoreConditionReason, JsonObject } from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";
import type { SpaceId } from "../../shared/ids.ts";

export type { SpaceId };
export type OutputId = string;
export type CoreOutputResolutionId = string;
export type OutputProjectionId = string;
export type GroupId = string;
export type ActivationId = string;
export type AppReleaseId = string;

export type OutputInjectionValueType =
  | "string"
  | "url"
  | "json"
  | "secret-ref"
  | "service";
export type OutputVisibility = "space" | "public" | "private";
export type OutputCompatibility = "compatible" | "breaking";
export type OutputWithdrawalPolicy =
  | "retain-last-projection"
  | "mark-unavailable"
  | "fail-consumers";
export type OutputRebindPolicy =
  | "never"
  | "compatible-only"
  | "on-new-primary-release"
  | "always";

export interface OutputValue {
  readonly name: string;
  readonly valueType: OutputInjectionValueType;
  readonly value?: string | JsonObject;
  readonly required?: boolean;
  readonly sensitive?: boolean;
  readonly description?: string;
}

export interface OutputPolicy {
  readonly withdrawal: OutputWithdrawalPolicy;
  readonly rebind: OutputRebindPolicy;
}

export interface Output {
  readonly id: OutputId;
  readonly spaceId: SpaceId;
  readonly producerGroupId: GroupId;
  readonly activationId: ActivationId;
  readonly appReleaseId?: AppReleaseId;
  readonly name: string;
  readonly address: string;
  readonly contract: string;
  readonly version?: string;
  readonly type: string;
  readonly visibility: OutputVisibility;
  readonly outputs: readonly OutputValue[];
  readonly policy: OutputPolicy;
  readonly spec?: JsonObject;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly withdrawnAt?: IsoTimestamp;
}

export interface OutputInjection {
  readonly outputName: string;
  readonly env?: string;
  readonly binding?: string;
  readonly valueType: OutputInjectionValueType;
  readonly explicit: true;
}

export type OutputGrantStatus = "active" | "revoked";

export interface OutputGrant {
  readonly ref: string;
  readonly spaceId: SpaceId;
  readonly consumerGroupId: GroupId;
  readonly producerGroupId: GroupId;
  readonly outputAddress: string;
  readonly contract: string;
  readonly status: OutputGrantStatus;
  readonly grantedAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
}

export interface OutputInjectionApproval {
  readonly bindingId: string;
  readonly outputName: string;
  readonly grantRef: string;
  readonly approved: true;
  readonly approvedAt?: IsoTimestamp;
  readonly approvedBy?: string;
  readonly reason?: string;
}

export interface OutputConsumerBinding {
  readonly id: string;
  readonly spaceId: SpaceId;
  readonly consumerGroupId: GroupId;
  readonly outputAddress: string;
  readonly contract: string;
  readonly outputs: Readonly<Record<string, OutputInjection>>;
  readonly grantRef: string;
  readonly rebindPolicy: OutputRebindPolicy;
  readonly optional?: boolean;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface OutputProjectionOutput {
  readonly name: string;
  readonly valueType: OutputInjectionValueType;
  readonly value?: string | JsonObject;
  readonly injectedAs?: { readonly env?: string; readonly binding?: string };
}

export interface CoreOutputResolutionOutput {
  readonly name: string;
  readonly valueType: OutputInjectionValueType;
  readonly value?: string | JsonObject;
  readonly injectedAs?: { readonly env?: string; readonly binding?: string };
}

export interface CoreOutputResolution {
  readonly id: CoreOutputResolutionId;
  readonly digest: string;
  readonly spaceId: SpaceId;
  readonly consumerGroupId: GroupId;
  readonly bindingId: string;
  readonly outputId: OutputId;
  readonly outputAddress: string;
  readonly producerGroupId: GroupId;
  readonly activationId: ActivationId;
  readonly appReleaseId?: AppReleaseId;
  readonly contract: string;
  readonly outputs: readonly CoreOutputResolutionOutput[];
  readonly resolvedAt: IsoTimestamp;
  readonly status: "ready" | "degraded" | "invalidated";
  readonly reason?: CoreConditionReason;
  readonly withdrawn: boolean;
  readonly diagnostics: readonly string[];
  readonly rebindCandidate: boolean;
}

export interface OutputProjection {
  readonly id: OutputProjectionId;
  readonly resolutionId?: CoreOutputResolutionId;
  readonly resolutionDigest?: string;
  readonly spaceId: SpaceId;
  readonly consumerGroupId: GroupId;
  readonly bindingId: string;
  readonly outputId: OutputId;
  readonly outputAddress: string;
  readonly producerGroupId: GroupId;
  readonly activationId: ActivationId;
  readonly appReleaseId?: AppReleaseId;
  readonly contract: string;
  readonly outputs: readonly OutputProjectionOutput[];
  readonly projectedAt: IsoTimestamp;
  readonly status?: "ready" | "degraded" | "invalidated";
  readonly reason?: CoreConditionReason;
  readonly withdrawn: boolean;
  readonly diagnostics: readonly string[];
}

export interface OutputQuery {
  readonly spaceId?: SpaceId;
  readonly producerGroupId?: GroupId;
  readonly address?: string;
  readonly includeWithdrawn?: boolean;
}
