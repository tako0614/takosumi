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
  readonly status: "active" | "trialing" | "past_due" | "cancelled";
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BillingPlanLimits {
  /** Maximum credits one reviewed plan may reserve/capture. */
  readonly maxEstimatedCreditsPerRun?: number;
  /** Additional resource-count quotas enforced from `tofu show -json` changes. */
  readonly quota?: Readonly<Record<string, number>>;
}

export interface BillingPlan {
  readonly id: string;
  readonly name: string;
  readonly monthlyBasePrice: number;
  readonly includedCredits: number;
  readonly limits: BillingPlanLimits;
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
  | "gateway_compute"
  | "gateway_storage_gb_hour"
  | "ai_request"
  | "ai_input_token"
  | "ai_output_token"
  | "artifact_storage_gb_hour"
  | "backup_storage_gb_hour"
  | "egress_gb"
  | "operation";

export type UsageEventSource =
  | "runner"
  | "resource_meter"
  | "billing_reconciliation"
  | "manual_adjustment";

export interface UsageEvent {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId?: string;
  readonly runId?: string;
  readonly kind: UsageEventKind;
  readonly quantity: number;
  readonly credits: number;
  readonly source: UsageEventSource;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface GatewayResourceUsageMeter {
  readonly installationId?: string;
  readonly kind: Extract<
    UsageEventKind,
    | "gateway_compute"
    | "gateway_storage_gb_hour"
    | "ai_request"
    | "ai_input_token"
    | "ai_output_token"
    | "artifact_storage_gb_hour"
    | "backup_storage_gb_hour"
    | "egress_gb"
  >;
  readonly quantity: number;
  readonly credits: number;
  readonly meterId: string;
}

export const TAKOSUMI_CLOUD_EXTENSION_USAGE_SPACE_ID_HEADER =
  "x-takosumi-cloud-usage-space-id";
export const TAKOSUMI_CLOUD_EXTENSION_USAGE_PERIOD_START_HEADER =
  "x-takosumi-cloud-usage-period-start";
export const TAKOSUMI_CLOUD_EXTENSION_USAGE_PERIOD_END_HEADER =
  "x-takosumi-cloud-usage-period-end";
export const TAKOSUMI_CLOUD_EXTENSION_USAGE_METERS_HEADER =
  "x-takosumi-cloud-usage-meters";

export interface InvoiceUsageReconciliation {
  readonly invoiceId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly meteredCredits: number;
  readonly invoicedCredits: number;
  readonly adjustmentCredits: number;
  readonly usageEvent: UsageEvent;
}
