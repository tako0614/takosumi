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
    (["workspace", "personal", "account"].includes(connection.scope) && connection.status === "verified")
  );
}

/**
 * Applies the selected InstallConfig's exact destination boundary.
 *
 * Provider source equality selects the provider axis; optional exact
 * connection, ownership-scope, and CredentialRecipe/mode allowlists can
 * further pin a profile to supported destinations. Required host-attested
 * capabilities are checked as a set; verifier identity remains provenance.
 * The policy is authoritative on both the UI choice and the later
 * mint-evidence gate.
 */
export function providerConnectionAllowedByInstallPolicy(
  connection: Pick<
    ProviderConnection,
    "id" | "scope" | "credentialRecipe" | "credentialVerification"
  >,
  policy: PolicyConfig | undefined,
): boolean {
  const credentialPolicy = policy?.providerCredentials;
  if (
    credentialPolicy?.allowedConnectionIds !== undefined &&
    !credentialPolicy.allowedConnectionIds.includes(connection.id)
  ) {
    return false;
  }
  if (credentialPolicy?.forbiddenConnectionIds?.includes(connection.id)) {
    return false;
  }
  if (
    credentialPolicy?.allowedConnectionScopes !== undefined &&
    !credentialPolicy.allowedConnectionScopes.includes(connection.scope)
  ) {
    return false;
  }
  if (credentialPolicy?.allowedCredentialRecipes !== undefined) {
    const recipe = connection.credentialRecipe;
    if (
      !recipe ||
      !credentialPolicy.allowedCredentialRecipes.some(
        (candidate) =>
          candidate.id === recipe.id && candidate.authMode === recipe.authMode,
      )
    ) {
      return false;
    }
  }
  if (credentialPolicy?.requiredCredentialCapabilities !== undefined) {
    const verification = connection.credentialVerification;
    const capabilities =
      verification?.kind === "takosumi.credential-verification@v1"
        ? new Set(verification.capabilities ?? [])
        : new Set<string>();
    if (
      credentialPolicy.requiredCredentialCapabilities.some(
        (capability) => !capabilities.has(capability),
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Returns the user-facing label for a Provider Connection in install choices.
 *
 * The connection owner chooses the persisted display name. In particular,
 * workspace-bindable operator connections are a generic credential source;
 * this helper must not relabel every such connection as Takosumi hosted service.
 */
export function providerConnectionDisplayName(
  connection: ProviderConnection,
): string {
  return connection.displayName || connection.id;
}
