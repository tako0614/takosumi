/**
 * Provider-neutral references connecting a Workspace to one explicitly
 * configured billing authority. The Control ledger owns immutable enrollment
 * provenance and references; the billing authority owns money and resources.
 * These records confer no wallet read, payment, or resource execution grant.
 */
export interface WorkspaceBillingBindingIntent {
  readonly intentId: string;
  readonly workspaceId: string;
  readonly billingAuthority: string;
  readonly workspaceRef: string;
  readonly workspaceCreatedAt: string;
  readonly actorAccountId: string;
  readonly managementEpoch: number;
  readonly createdAt: string;
}

/** Retained once claimed, even after membership or Workspace lifecycle changes. */
export interface WorkspaceBillingBinding extends WorkspaceBillingBindingIntent {
  readonly organizationRef: string;
  readonly ownerAcknowledgementRef: string;
  readonly boundAt: string;
}

export interface WorkspaceBillingBindingState {
  readonly intent?: WorkspaceBillingBindingIntent;
  readonly binding?: WorkspaceBillingBinding;
}

/** Object comparison, with provenance included and without property-order dependence. */
export function workspaceBillingIntentMatches(left: WorkspaceBillingBindingIntent, right: WorkspaceBillingBindingIntent): boolean {
  return left.intentId === right.intentId && left.workspaceId === right.workspaceId &&
    left.billingAuthority === right.billingAuthority && left.workspaceRef === right.workspaceRef &&
    left.workspaceCreatedAt === right.workspaceCreatedAt && left.actorAccountId === right.actorAccountId &&
    left.managementEpoch === right.managementEpoch && left.createdAt === right.createdAt;
}

/** Idempotent ACK retries retain the first durable boundAt timestamp. */
export function workspaceBillingBindingMatches(left: WorkspaceBillingBinding, right: WorkspaceBillingBinding): boolean {
  return workspaceBillingIntentMatches(left, right) && left.organizationRef === right.organizationRef &&
    left.ownerAcknowledgementRef === right.ownerAcknowledgementRef;
}
