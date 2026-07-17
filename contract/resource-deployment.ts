/**
 * Provider-neutral Resource deployment review and commercial-admission seam.
 *
 * A Resource Shape describes the requested service form. The Deploy API owns
 * preview/apply lifecycle. OpenTofu providers, dashboards, CLIs, and
 * compatibility facades are clients of that same lifecycle and therefore use
 * the same plan digest and, when a host prices the service, the same quote.
 *
 * OSS does not ship a price catalog. A self-hosted endpoint may omit `quote`;
 * Takosumi Cloud injects a rated quote and implements reserve/capture/release.
 */

import type { NativeResourceRef } from "./resolution.ts";
import type { ResourceShapeKind } from "./resource-shape.ts";
import type { InstalledFormReference } from "./service-forms.ts";
import type { ActorContext, JsonObject, JsonValue } from "./types.ts";
import type { UsageRatingStatus } from "./billing.ts";

export type ResourceDeploymentChargeKind =
  "one_time" | "recurring" | "usage_estimate";

/** Immutable intent for one canonical Resource deployment generation. */
export type ResourceDeploymentOperation = "create" | "update";

/** One immutable, user-visible line in a deployment quote. */
export interface ResourceDeploymentQuoteLineItem {
  readonly sku: string;
  readonly skuVersion: string;
  readonly description?: string;
  /** Cloud-rated lines pin tax policy; OSS unrated lines may omit it. */
  readonly taxTreatment?: string;
  /** Cloud-rated lines pin invoice text independently of mutable runtime env. */
  readonly invoiceDescription?: string;
  readonly chargeKind: ResourceDeploymentChargeKind;
  readonly meterId?: string;
  /** Original versioned catalog selector when this line prices a meter family. */
  readonly meterIdPrefix?: string;
  readonly meterKind?: string;
  readonly unit: string;
  readonly billingUnit?: number;
  readonly quantity: number;
  readonly unitPriceUsdMicros: number;
  readonly minimumChargeUsdMicros?: number;
  readonly amountUsdMicros: number;
}

/**
 * Price snapshot returned by Deploy API preview.
 *
 * `rated` zero is an explicit free price. `unrated` always has zero amount and
 * is valid only for OSS disabled/showback operation; Cloud enforcement rejects
 * it through the admission port.
 */
export interface ResourceDeploymentQuote {
  readonly quoteId: string;
  readonly quoteDigest: string;
  readonly planDigest: string;
  readonly specDigest: string;
  readonly resolutionFingerprint: string;
  readonly ratingStatus: UsageRatingStatus;
  readonly currency: string;
  readonly catalogId?: string;
  readonly catalogVersion?: string;
  readonly offeringId?: string;
  readonly offeringVersion?: string;
  readonly region?: string;
  readonly lineItems: readonly ResourceDeploymentQuoteLineItem[];
  readonly estimatedTotalUsdMicros: number;
  readonly expiresAt: string;
}

/** Exact preview evidence a client must present when applying. */
export interface ResourceDeploymentReview {
  readonly planDigest: string;
  readonly quoteId?: string;
  readonly quoteDigest?: string;
}

/** Stable, non-secret input to a host's quote policy. */
export interface ResourceDeploymentQuoteContext {
  readonly space: string;
  readonly resourceId: string;
  readonly kind: ResourceShapeKind;
  /** Exact installed Form selected by the caller; absent for legacy/native shape execution. */
  readonly form?: InstalledFormReference;
  readonly name: string;
  readonly operation: ResourceDeploymentOperation;
  readonly spec: JsonObject;
  readonly selectedImplementation: string;
  readonly selectedTarget: string;
  /** Immutable selected Target region; Cloud admission rejects an absent value. */
  readonly selectedTargetRegion?: string;
  readonly resolutionFingerprint: string;
  readonly nativeResourcePlan: readonly NativeResourceRef[];
  readonly planDigest: string;
  readonly specDigest: string;
  readonly actor: ActorContext;
  readonly now: string;
}

/** Generic host decision for lifecycle paths that do not use a quote. */
export interface ResourceDeploymentAdmissionDecision {
  readonly reasons: readonly string[];
  readonly audit?: Readonly<Record<string, JsonValue>>;
}

/** Stable, non-secret input to a host's Resource import policy. */
export interface ResourceDeploymentImportContext {
  readonly space: string;
  readonly resourceId: string;
  readonly kind: ResourceShapeKind;
  readonly name: string;
  readonly spec: JsonObject;
  readonly nativeId: string;
  readonly actor: ActorContext;
  readonly now: string;
}

/**
 * Idempotent host notification for canonical retirement. A force tombstone
 * does not prove backend absence and therefore must retain host capacity until
 * a later explicit operator release supplies that proof.
 */
export interface ResourceDeploymentRetireContext {
  readonly space: string;
  readonly resourceId: string;
  readonly kind: ResourceShapeKind;
  readonly name: string;
  readonly reason:
    "canonical_delete" | "force_tombstone" | "force_tombstone_cancelled";
  readonly now: string;
}

export interface ResourceDeploymentReservationDecision extends ResourceDeploymentAdmissionDecision {
  readonly reservationId?: string;
}

export interface ResourceDeploymentReserveContext extends ResourceDeploymentQuoteContext {
  readonly review: ResourceDeploymentReview;
}

export interface ResourceDeploymentCaptureContext extends ResourceDeploymentQuoteContext {
  readonly review: ResourceDeploymentReview;
  readonly reservationId?: string;
  /** Exact canonical generation whose backend evidence was captured. */
  readonly resourceGeneration: number;
  readonly nativeResources: readonly NativeResourceRef[];
}

export interface ResourceDeploymentSettlementPendingContext extends ResourceDeploymentReserveContext {
  readonly backendOutcome: "succeeded" | "unknown";
  readonly nativeResources: readonly NativeResourceRef[];
  readonly reason:
    | "resource_finalize_failed"
    | "billing_capture_failed"
    | "backend_outcome_unknown";
}

export interface ResourceDeploymentReleaseContext extends ResourceDeploymentQuoteContext {
  readonly review: ResourceDeploymentReview;
  readonly reservationId?: string;
  readonly reason: string;
}

/**
 * Host composition port for quote and payment admission.
 *
 * The Cloud implementation owns its durable quote/reservation ledger. Methods
 * must be idempotent for the stable quote/reservation/resource tuple. OSS uses
 * the no-op implementation below and can never block or charge a deployment.
 */
export interface ResourceDeploymentAdmission {
  quote(
    context: ResourceDeploymentQuoteContext,
  ): Promise<ResourceDeploymentQuote | undefined>;
  reserve(
    context: ResourceDeploymentReserveContext,
  ): Promise<ResourceDeploymentReservationDecision>;
  capture(context: ResourceDeploymentCaptureContext): Promise<void>;
  /**
   * Durably records that backend work succeeded but capture still needs a
   * retry. Implementations must be idempotent and must not release the
   * reservation from this state.
   */
  markSettlementPending(
    context: ResourceDeploymentSettlementPendingContext,
  ): Promise<void>;
  release(context: ResourceDeploymentReleaseContext): Promise<void>;
  /**
   * Authorizes adoption of an existing backend object. Hosts that cannot
   * account for imported capacity deny here before adapter/backend I/O.
   */
  admitImport(
    context: ResourceDeploymentImportContext,
  ): Promise<ResourceDeploymentAdmissionDecision>;
  /**
   * Finalizes host-owned lifecycle capacity after canonical retirement.
   * Normal deletion may release capacity; a force tombstone must retain it
   * until an explicit operator action proves the native backend is absent.
   * Implementations must be idempotent because absent-resource retries repeat
   * this hook after a prior finalization failure.
   */
  retire(context: ResourceDeploymentRetireContext): Promise<void>;
}

export const NOOP_RESOURCE_DEPLOYMENT_ADMISSION: ResourceDeploymentAdmission = {
  async quote(): Promise<undefined> {
    return undefined;
  },
  async reserve(): Promise<ResourceDeploymentReservationDecision> {
    return { reasons: [] };
  },
  async capture(): Promise<void> {},
  async markSettlementPending(): Promise<void> {},
  async release(): Promise<void> {},
  async admitImport(): Promise<ResourceDeploymentAdmissionDecision> {
    return { reasons: [] };
  },
  async retire(): Promise<void> {},
};
