import {
  isPublicManagedProviderConnection,
  type ProviderConnection,
} from "takosumi-contract";

/**
 * Returns the Provider Connections the dashboard may offer for a binding.
 *
 * Workspace-owned credentials must already be verified. Public managed
 * capacity is an explicit operator-scoped connection selected by the shared
 * contract predicate; its pending status is accepted while the managed
 * credential issuer settles it for the requested run. Terminal/rejected
 * statuses never become dashboard choices.
 */
export function isProviderConnectionCandidate(
  connection: ProviderConnection,
): boolean {
  return (
    (isPublicManagedProviderConnection(connection) &&
      (connection.status === "pending" || connection.status === "verified")) ||
    (connection.scope === "workspace" && connection.status === "verified")
  );
}
