import type { CoreConditionReason, JsonObject } from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";

export type PublicationId = string;
export type CorePublicationResolutionId = string;
export type PublicationProjectionId = string;
export type SpaceId = string;
export type GroupId = string;
export type ActivationId = string;
export type AppReleaseId = string;

export type PublicationOutputValueType =
  | "string"
  | "url"
  | "json"
  | "secret-ref"
  | "service";
export type PublicationVisibility = "space" | "public" | "private";
export type PublicationCompatibility = "compatible" | "breaking";
export type PublicationWithdrawalPolicy =
  | "retain-last-projection"
  | "mark-unavailable"
  | "fail-consumers";
export type PublicationRebindPolicy =
  | "never"
  | "compatible-only"
  | "on-new-primary-release"
  | "always";

export interface PublicationOutput {
  readonly name: string;
  readonly valueType: PublicationOutputValueType;
  readonly value?: string | JsonObject;
  readonly required?: boolean;
  readonly sensitive?: boolean;
  readonly description?: string;
}

export interface PublicationPolicy {
  readonly withdrawal: PublicationWithdrawalPolicy;
  readonly rebind: PublicationRebindPolicy;
}

export interface Publication {
  readonly id: PublicationId;
  readonly spaceId: SpaceId;
  readonly producerGroupId: GroupId;
  readonly activationId: ActivationId;
  readonly appReleaseId?: AppReleaseId;
  readonly name: string;
  readonly address: string;
  readonly contract: string;
  readonly version?: string;
  readonly type: string;
  readonly visibility: PublicationVisibility;
  readonly outputs: readonly PublicationOutput[];
  readonly policy: PublicationPolicy;
  readonly spec?: JsonObject;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly withdrawnAt?: IsoTimestamp;
}

export interface PublicationOutputInjection {
  readonly outputName: string;
  readonly env?: string;
  readonly binding?: string;
  readonly valueType: PublicationOutputValueType;
  readonly explicit: true;
}

export type PublicationGrantStatus = "active" | "revoked";

export interface PublicationGrant {
  readonly ref: string;
  readonly spaceId: SpaceId;
  readonly consumerGroupId: GroupId;
  readonly producerGroupId: GroupId;
  readonly publicationAddress: string;
  readonly contract: string;
  readonly status: PublicationGrantStatus;
  readonly grantedAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
}

export interface PublicationOutputInjectionApproval {
  readonly bindingId: string;
  readonly outputName: string;
  readonly grantRef: string;
  readonly approved: true;
  readonly approvedAt?: IsoTimestamp;
  readonly approvedBy?: string;
  readonly reason?: string;
}

export interface PublicationConsumerBinding {
  readonly id: string;
  readonly spaceId: SpaceId;
  readonly consumerGroupId: GroupId;
  readonly publicationAddress: string;
  readonly contract: string;
  readonly outputs: Readonly<Record<string, PublicationOutputInjection>>;
  readonly grantRef: string;
  readonly rebindPolicy: PublicationRebindPolicy;
  readonly optional?: boolean;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface PublicationProjectionOutput {
  readonly name: string;
  readonly valueType: PublicationOutputValueType;
  readonly value?: string | JsonObject;
  readonly injectedAs?: { readonly env?: string; readonly binding?: string };
}

export interface CorePublicationResolutionOutput {
  readonly name: string;
  readonly valueType: PublicationOutputValueType;
  readonly value?: string | JsonObject;
  readonly injectedAs?: { readonly env?: string; readonly binding?: string };
}

export interface CorePublicationResolution {
  readonly id: CorePublicationResolutionId;
  readonly digest: string;
  readonly spaceId: SpaceId;
  readonly consumerGroupId: GroupId;
  readonly bindingId: string;
  readonly publicationId: PublicationId;
  readonly publicationAddress: string;
  readonly producerGroupId: GroupId;
  readonly activationId: ActivationId;
  readonly appReleaseId?: AppReleaseId;
  readonly contract: string;
  readonly outputs: readonly CorePublicationResolutionOutput[];
  readonly resolvedAt: IsoTimestamp;
  readonly status: "ready" | "degraded" | "invalidated";
  readonly reason?: CoreConditionReason;
  readonly withdrawn: boolean;
  readonly diagnostics: readonly string[];
  readonly rebindCandidate: boolean;
}

export interface PublicationProjection {
  readonly id: PublicationProjectionId;
  readonly resolutionId?: CorePublicationResolutionId;
  readonly resolutionDigest?: string;
  readonly spaceId: SpaceId;
  readonly consumerGroupId: GroupId;
  readonly bindingId: string;
  readonly publicationId: PublicationId;
  readonly publicationAddress: string;
  readonly producerGroupId: GroupId;
  readonly activationId: ActivationId;
  readonly appReleaseId?: AppReleaseId;
  readonly contract: string;
  readonly outputs: readonly PublicationProjectionOutput[];
  readonly projectedAt: IsoTimestamp;
  readonly status?: "ready" | "degraded" | "invalidated";
  readonly reason?: CoreConditionReason;
  readonly withdrawn: boolean;
  readonly diagnostics: readonly string[];
}

export interface PublicationQuery {
  readonly spaceId?: SpaceId;
  readonly producerGroupId?: GroupId;
  readonly address?: string;
  readonly includeWithdrawn?: boolean;
}
