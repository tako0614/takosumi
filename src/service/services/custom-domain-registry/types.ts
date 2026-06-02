/**
 * Custom domain reservation types.
 *
 * The Custom Domain Registry serializes hostname ownership across tenants /
 * groups / deployments. Provider materializers (e.g.
 * `provider.cloudflare.custom-domain@v1`) MUST acquire a reservation before
 * touching the upstream DNS / certificate system, so that two unrelated
 * tenants cannot register the same `api.example.com` and create undefined
 * routing precedence.
 */

export type CustomDomainReservationStatus =
  | "pending"
  | "verified"
  | "released";

export interface CustomDomainReservationOwner {
  readonly tenantId: string;
  readonly groupId: string;
  readonly deploymentId: string;
}

export interface CustomDomainReservation {
  readonly hostname: string;
  readonly owner: CustomDomainReservationOwner;
  readonly status: CustomDomainReservationStatus;
  readonly reservedAt: string;
  readonly updatedAt: string;
}

export interface ReserveCustomDomainInput {
  readonly hostname: string;
  readonly tenantId: string;
  readonly groupId: string;
  readonly deploymentId: string;
  readonly status?: CustomDomainReservationStatus;
}

export interface ReleaseCustomDomainInput {
  readonly hostname: string;
  /**
   * Optional owner gate. Release requests carrying an `owner` are rejected
   * when the recorded reservation belongs to a different deployment so a
   * rollback / uninstall on one tenant cannot drop the reservation held by
   * another tenant.
   */
  readonly owner?: CustomDomainReservationOwner;
}

export interface VerifyCustomDomainInput {
  readonly hostname: string;
  readonly owner: CustomDomainReservationOwner;
}
