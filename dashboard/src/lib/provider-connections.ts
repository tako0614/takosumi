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
 * Selects the destination that may be used without asking an ordinary user to
 * configure provider credentials.
 *
 * One verified, workspace-bindable operator connection means the operator
 * supports this provider. Prefer that managed destination even when the
 * Workspace also has BYOK connections. Multiple managed destinations remain
 * ambiguous and must be reviewed explicitly. Without managed capacity, only a
 * single existing Workspace connection can be selected automatically.
 */
export function preferredProviderConnection(
  connections: readonly ProviderConnection[],
): ProviderConnection | undefined {
  const candidates = connections.filter(isProviderConnectionCandidate);
  const managed = candidates.filter(isWorkspaceBindableOperatorConnection);
  if (managed.length === 1) return managed[0];
  if (managed.length > 1) return undefined;
  return candidates.length === 1 ? candidates[0] : undefined;
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
