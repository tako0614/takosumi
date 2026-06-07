/**
 * Space billing and credit ledger contract.
 */

export type BillingMode = "disabled" | "showback" | "enforce";

export type BillingProvider = "stripe" | "manual" | "none";

export type BillingSettings =
  | {
      readonly mode: "disabled";
      readonly provider: "none";
      readonly reservationRequired?: false;
    }
  | {
      readonly mode: "showback";
      readonly provider: BillingProvider;
      readonly reservationRequired?: false;
    }
  | {
      readonly mode: "enforce";
      readonly provider: Exclude<BillingProvider, "none">;
      readonly reservationRequired: true;
    };

export function billingReservationRequired(settings: BillingSettings): boolean {
  return settings.mode === "enforce";
}

export interface BillingAccount {
  readonly id: string;
  readonly ownerType: "user" | "space";
  readonly ownerId: string;
  readonly provider: "stripe" | "manual" | "none";
  readonly stripeCustomerId?: string;
  readonly status: "active" | "past_due" | "disabled" | "trialing";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpaceSubscription {
  readonly id: string;
  readonly spaceId: string;
  readonly billingAccountId: string;
  readonly planId: string;
  readonly status: string;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreditBalance {
  readonly spaceId: string;
  readonly availableCredits: number;
  readonly reservedCredits: number;
  readonly monthlyIncludedCredits: number;
  readonly purchasedCredits: number;
  readonly updatedAt: string;
}

export interface CreditReservation {
  readonly id: string;
  readonly spaceId: string;
  readonly runId: string;
  readonly estimatedCredits: number;
  readonly status: "reserved" | "captured" | "released" | "expired";
  readonly mode: BillingMode;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type UsageEventKind =
  | "runner_minute"
  | "managed_compute"
  | "managed_storage_gb_hour"
  | "artifact_storage_gb_hour"
  | "backup_storage_gb_hour"
  | "egress_gb"
  | "operation";

export interface UsageEvent {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId?: string;
  readonly runId?: string;
  readonly kind: UsageEventKind;
  readonly quantity: number;
  readonly credits: number;
  readonly source: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}
