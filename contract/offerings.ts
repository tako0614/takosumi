import type { IsoTimestamp } from "./types.ts";

/**
 * Open, namespaced identity for anything an operator can make available.
 *
 * Core deliberately does not enumerate subject types. A Service Form, a
 * Capsule distribution, or a host-defined service can each install a resolver
 * for its own namespaced type without making Takoform or one Cloud product the
 * Offering authority.
 */
export interface OfferingSubjectReference {
  readonly type: string;
  readonly ref: string;
  readonly version: string;
  readonly digest: string;
}

/** Exact external prerequisite re-read by the selected subject resolver. */
export interface OfferingRequirementReference {
  readonly type: string;
  readonly ref: string;
  readonly version: string;
  readonly digest?: string;
}

/** Open, non-secret caller context consumed only by the matching resolver. */
export interface OfferingContextReference {
  readonly type: string;
  readonly id: string;
}

export interface OfferingAudience {
  readonly public?: boolean;
  readonly principalIds?: readonly string[];
  readonly roles?: readonly string[];
}

export type OfferingMaturity = "stable" | "preview";
export type OfferingStatus = "active" | "inactive";

/**
 * Generic, noncommercial operator offering.
 *
 * Target credentials, backend-manager configuration, capacity, SKU, price,
 * payment, quota, SLA, and support are deliberately absent. A commercial host
 * can bind those concerns to this exact id/version without replacing the OSS
 * selection and availability authority.
 */
export interface Offering {
  readonly id: string;
  readonly version: string;
  readonly subject: OfferingSubjectReference;
  readonly requirements: readonly OfferingRequirementReference[];
  readonly profile: string;
  readonly region: string;
  readonly maturity: OfferingMaturity;
  readonly audience: OfferingAudience;
  readonly status: OfferingStatus;
}

/** Immutable configured catalog snapshot. Empty catalogs are valid. */
export interface OfferingCatalog {
  readonly id: string;
  readonly version: string;
  readonly effectiveAt: IsoTimestamp;
  readonly offerings: readonly Offering[];
}

export interface OfferingReference {
  readonly catalogId: string;
  readonly catalogVersion: string;
  readonly offeringId: string;
  readonly offeringVersion: string;
}

export type OfferingAvailabilityReason =
  | "catalog_not_effective"
  | "offering_inactive"
  | "principal_not_allowed"
  | "resolver_unavailable"
  | "subject_unavailable";

/** Public, noncommercial availability projection. */
export interface OfferingAvailability {
  readonly reference: OfferingReference;
  readonly subject: OfferingSubjectReference;
  readonly profile: string;
  readonly region: string;
  readonly maturity: OfferingMaturity;
  readonly availableToPrincipal: boolean;
  readonly reason?: OfferingAvailabilityReason;
}

/** Exact result pinned by a caller before a host-specific commercial layer. */
export interface OfferingSelection {
  readonly reference: OfferingReference;
  readonly subject: OfferingSubjectReference;
  readonly requirements: readonly OfferingRequirementReference[];
  readonly profile: string;
  readonly region: string;
  readonly maturity: OfferingMaturity;
  readonly resolverId: string;
  readonly resolutionFingerprint: string;
  readonly resolvedAt: IsoTimestamp;
}

export type OfferingSubjectResolution =
  | {
      readonly ready: true;
      readonly resolverId: string;
      readonly resolutionFingerprint: string;
    }
  | {
      readonly ready: false;
      /** Resolver-private detail is retained by the host, not projected. */
      readonly reason: string;
    };

/**
 * Durable or host-code catalog reader installed at the composition root.
 * Callers always provide an exact catalog id/version; there is no latest
 * lookup in the portable boundary.
 */
export interface OfferingCatalogReader {
  getCatalog(
    catalogId: string,
    catalogVersion: string,
  ): Promise<OfferingCatalog | undefined>;
}

/**
 * Open subject resolver contribution. Each resolver re-reads its own subject
 * and every referenced prerequisite before returning exact ready evidence.
 */
export interface OfferingSubjectResolver {
  readonly subjectType: string;
  resolve(input: {
    readonly offering: Offering;
    readonly principalId?: string;
    readonly roles: readonly string[];
    readonly workspaceId?: string;
    readonly contexts: readonly OfferingContextReference[];
  }): Promise<OfferingSubjectResolution>;
}

/**
 * Complete noncommercial Offering contribution installed by an operator.
 *
 * This is a code-level composition port, not serialized configuration and not
 * Cloud authority. A zero-offering host omits it. Commercial hosts compose
 * their private binding only after Core returns an exact OfferingSelection.
 */
export interface OfferingHostComposition {
  readonly catalogs: OfferingCatalogReader;
  readonly resolvers?: readonly OfferingSubjectResolver[];
}
