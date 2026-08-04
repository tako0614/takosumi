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

/**
 * Returns the user-facing label for a Provider Connection in install choices.
 *
 * Public managed capacity is an operator-scoped Provider Connection. Its
 * persisted display name is operator seed data (and may describe the backing
 * host), so the install flow presents the product-owned label instead.
 * Workspace connections retain the name chosen by the user.
 */
export function providerConnectionDisplayName(
  connection: ProviderConnection,
  managedLabel: string,
): string {
  return isPublicManagedProviderConnection(connection)
    ? managedLabel
    : connection.displayName || connection.id;
}
