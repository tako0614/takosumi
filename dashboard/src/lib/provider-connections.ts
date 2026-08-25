import {
  isWorkspaceBindableOperatorConnection,
  type PolicyConfig,
  type ProviderConnection,
} from "takosumi-contract";

/**
 * Compose only the provider-credential axes needed by the dashboard chooser.
 * The deploy-control policy composer applies the same intersection/union rules
 * server-side; keeping this projection explicit prevents a Workspace ceiling
 * from being lost when the InstallConfig is loaded later in the flow.
 */
export function mergeProviderConnectionPolicies(
  workspacePolicy: PolicyConfig | undefined,
  installPolicy: PolicyConfig | undefined,
): PolicyConfig | undefined {
  const workspace = workspacePolicy?.providerCredentials;
  const install = installPolicy?.providerCredentials;
  if (!workspace && !install) return undefined;

  const requiredProviders = Array.from(
    new Set([
      ...(workspace?.requiredProviders ?? []),
      ...(install?.requiredProviders ?? []),
    ]),
  ).sort();
  const allowedConnectionIds = intersectOptionalLists(
    workspace?.allowedConnectionIds,
    install?.allowedConnectionIds,
  );
  const forbiddenConnectionIds = Array.from(
    new Set([
      ...(workspace?.forbiddenConnectionIds ?? []),
      ...(install?.forbiddenConnectionIds ?? []),
    ]),
  ).sort();
  const allowedConnectionScopes = intersectOptionalLists(
    workspace?.allowedConnectionScopes,
    install?.allowedConnectionScopes,
  );
  const allowedCredentialRecipes = intersectOptionalCredentialRecipes(
    workspace?.allowedCredentialRecipes,
    install?.allowedCredentialRecipes,
  );
  const requiredCredentialCapabilities = unionRequiredCapabilities(
    workspace?.requiredCredentialCapabilities,
    install?.requiredCredentialCapabilities,
  );
  return {
    providerCredentials: {
      ...(requiredProviders.length > 0 ? { requiredProviders } : {}),
      ...(allowedConnectionIds !== undefined
        ? { allowedConnectionIds }
        : {}),
      ...(forbiddenConnectionIds.length > 0
        ? { forbiddenConnectionIds }
        : {}),
      ...(allowedConnectionScopes !== undefined
        ? { allowedConnectionScopes }
        : {}),
      ...(allowedCredentialRecipes !== undefined
        ? { allowedCredentialRecipes }
        : {}),
      ...(requiredCredentialCapabilities !== undefined
        ? { requiredCredentialCapabilities }
        : {}),
      requireTemporary:
        workspace?.requireTemporary === true || install?.requireTemporary === true,
      requireTtlEnforced:
        workspace?.requireTtlEnforced === true ||
        install?.requireTtlEnforced === true,
    },
  };
}

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
 * Selects the destination that may be used without asking an ordinary user to
 * configure provider credentials.
 *
 * A destination is selected automatically only when exactly one eligible
 * connection remains. Operator capacity and Workspace-owned credentials are
 * peers here: when both are available, the user must choose explicitly.
 */
export function preferredProviderConnection(
  connections: readonly ProviderConnection[],
  policy?: PolicyConfig,
): ProviderConnection | undefined {
  const candidates = connections.filter(
    (connection) =>
      isProviderConnectionCandidate(connection) &&
      providerConnectionAllowedByInstallPolicy(connection, policy),
  );
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
 * this helper must not relabel every such connection as Takosumi hosted service.
 */
export function providerConnectionDisplayName(
  connection: ProviderConnection,
): string {
  return connection.displayName || connection.id;
}

function intersectOptionalLists<T extends string>(
  ceiling: readonly T[] | undefined,
  local: readonly T[] | undefined,
): readonly T[] | undefined {
  if (ceiling === undefined) return local;
  if (local === undefined) return ceiling;
  const ceilingSet = new Set(ceiling);
  return local.filter((value) => ceilingSet.has(value)).sort();
}

function unionRequiredCapabilities(
  ceiling: readonly string[] | undefined,
  local: readonly string[] | undefined,
): readonly string[] | undefined {
  if (ceiling === undefined && local === undefined) return undefined;
  return Array.from(
    new Set([...(ceiling ?? []), ...(local ?? [])]),
  ).sort();
}

function intersectOptionalCredentialRecipes(
  ceiling:
    | readonly { readonly id: string; readonly authMode: string }[]
    | undefined,
  local:
    | readonly { readonly id: string; readonly authMode: string }[]
    | undefined,
):
  | readonly { readonly id: string; readonly authMode: string }[]
  | undefined {
  if (ceiling === undefined) return local;
  if (local === undefined) return ceiling;
  const ceilingSet = new Set(
    ceiling.map((recipe) => `${recipe.id}\u0000${recipe.authMode}`),
  );
  return local
    .filter((recipe) => ceilingSet.has(`${recipe.id}\u0000${recipe.authMode}`))
    .sort((left, right) =>
      left.id.localeCompare(right.id) ||
      left.authMode.localeCompare(right.authMode),
    );
}
