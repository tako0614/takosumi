/** Read-only account billing reference. Enrollment and money stay with the host. */
import { requireNonEmptyString } from "./errors.ts";

export interface PayerBillingBinding {
  readonly accountId: string;
  readonly billingAuthority: string;
  /** Opaque legacy workspaceRef for migrated accounts; never derive a new value. */
  readonly billingRef: string;
  readonly organizationRef?: string | null;
}

export interface AccountBillingBindingReader {
  getAccountBillingBinding(accountId: string): Promise<PayerBillingBinding | undefined>;
}

export async function getPayerBillingBinding(
  reader: AccountBillingBindingReader,
  payerAccountId: string,
): Promise<PayerBillingBinding | undefined> {
  requireNonEmptyString(payerAccountId, "payerAccountId");
  const binding = await reader.getAccountBillingBinding(payerAccountId);
  if (binding && (binding.accountId !== payerAccountId || !binding.billingAuthority.trim() || !binding.billingRef.trim())) {
    throw new TypeError("Account billing binding does not match the payer");
  }
  return binding;
}
