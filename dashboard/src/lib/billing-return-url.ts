/**
 * The dashboard's canonical billing surface.
 *
 * Billing providers return the browser to the dashboard, so these URLs must
 * stay on a route the SPA actually mounts. The workspace id remains a query
 * parameter because the dashboard's WorkspaceSwitcher owns the active
 * Workspace selection rather than encoding it in the route.
 */
export const WORKSPACE_BILLING_ROUTE = "/settings/billing" as const;

export type BillingCheckoutResult = "success" | "cancelled";

export function billingReturnUrl(
  workspaceId: string,
  origin: string,
): URL {
  const url = new URL(WORKSPACE_BILLING_ROUTE, origin);
  url.searchParams.set("workspaceId", workspaceId);
  return url;
}

export function checkoutReturnUrl(
  workspaceId: string,
  result: BillingCheckoutResult,
  origin: string,
): URL {
  const url = billingReturnUrl(workspaceId, origin);
  url.searchParams.set("checkout", result);
  return url;
}
