import {
  isWorkspaceBindableOperatorConnection,
  type ProviderConnection,
} from "takosumi-contract";

/**
 * Returns the Provider Connections the dashboard may offer for a binding.
 *
 * Workspace-owned credentials must already be verified. Operator-provided
 * run credentials are admitted only by the shared, closed recipe predicate;
 * pending and terminal rows never become dashboard choices.
 */
export function isProviderConnectionCandidate(
  connection: ProviderConnection,
): boolean {
  return (
    isWorkspaceBindableOperatorConnection(connection) ||
    (connection.scope === "workspace" && connection.status === "verified")
  );
}

/**
 * Returns the user-facing label for a Provider Connection in install choices.
 *
 * The connection owner chooses the persisted display name. In particular,
 * workspace-bindable operator connections are a generic credential source;
 * this helper must not relabel every such connection as Takosumi Cloud.
 */
export function providerConnectionDisplayName(
  connection: ProviderConnection,
): string {
  return connection.displayName || connection.id;
}
