import {
  isWorkspaceBindableOperatorConnection,
  type PolicyConfig,
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
 * Applies the selected InstallConfig's exact destination boundary.
 *
 * Provider source equality alone is insufficient when one profile means the
 * host-managed Takoserver destination and another means a Workspace-owned
 * Takoform credential. The policy is authoritative on both the UI choice and
 * the later mint-evidence gate.
 */
export function providerConnectionAllowedByInstallPolicy(
  connection: Pick<ProviderConnection, "id">,
  policy: PolicyConfig | undefined,
): boolean {
  const credentialPolicy = policy?.providerCredentials;
  if (
    credentialPolicy?.allowedConnectionIds !== undefined &&
    !credentialPolicy.allowedConnectionIds.includes(connection.id)
  ) {
    return false;
  }
  return !credentialPolicy?.forbiddenConnectionIds?.includes(connection.id);
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
 * Matches a compatibility provider requirement to a Provider Connection by
 * canonical source. Display names are presentation only and never establish
 * that a connection belongs to the required provider.
 */
export function providerConnectionMatchesProviderSource(
  provider: string,
  connection: Pick<ProviderConnection, "providerSource">,
): boolean {
  const canonical = (value: string): string => {
    const normalized = value.toLowerCase().trim();
    return normalized.split("/").length === 2
      ? `registry.opentofu.org/${normalized}`
      : normalized;
  };
  return canonical(provider) === canonical(connection.providerSource);
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
