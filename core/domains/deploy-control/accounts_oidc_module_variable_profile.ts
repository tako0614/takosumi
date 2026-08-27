import type { InstallConfig } from "takosumi-contract/install-configs";

const MODULE_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const REPOSITORY_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface RepositoryAccountsOidcModuleVariableProfile {
  readonly source: "repository_install_ux";
  readonly publicUrlVariable: string;
  readonly accountsUrlVariable: string;
  readonly issuerUrlVariable: string;
  readonly clientIdVariable: string;
  readonly redirectUriVariable: string;
  readonly callbackPath: string;
  readonly scopes: readonly string[];
}

export type AccountsOidcModuleVariableProfile =
  RepositoryAccountsOidcModuleVariableProfile;

/**
 * Resolve the one repository-reviewed projection pair that drives generic
 * Accounts OIDC delivery. The existing `public_endpoint` and `oidc_client`
 * projections are canonical; no private descriptor or provider fallback is
 * accepted.
 */
export function accountsOidcModuleVariableProfile(
  installConfig: InstallConfig,
): AccountsOidcModuleVariableProfile | undefined {
  const projections = installConfig.installExperience?.projections ?? [];
  const oidc = projections.filter((projection) => projection.kind === "oidc_client");
  const internal = installConfig.internal;
  const acceptedRepositoryRequest =
    internal?.reason === "per_install_overrides" &&
    typeof internal.sourceSnapshotId === "string" &&
    internal.sourceSnapshotId.length > 0 &&
    typeof internal.repositoryInstallUxDigest === "string" &&
    REPOSITORY_DIGEST.test(internal.repositoryInstallUxDigest) &&
    installConfig.installExperience?.repositoryInstallUx?.status === "accepted";
  if (!acceptedRepositoryRequest || oidc.length === 0) {
    // A manual/operator projection remains presentation-only unless it was
    // compiled from one exact reviewed repository snapshot.
    return undefined;
  }
  if (oidc.length !== 1) {
    invalid("repository OIDC projections are ambiguous");
  }
  if (Object.keys(oidc[0]!.variables).length === 0) {
    return undefined;
  }
  const endpoints = projections.filter(
    (projection) => projection.kind === "public_endpoint",
  );
  if (endpoints.length !== 1) {
    invalid("repository OIDC projections are ambiguous");
  }
  const grant = oidc[0]!;
  const endpoint = endpoints[0]!;
  const names = Object.keys(grant.variables).sort();
  if (
    names.length !== 4 ||
    !sameStrings(names, [
      "accountsUrl",
      "clientId",
      "issuerUrl",
      "redirectUri",
    ]) ||
    typeof endpoint.variables.url !== "string" ||
    !MODULE_VARIABLE.test(endpoint.variables.url)
  ) {
    invalid("repository OIDC variable delivery is not exact");
  }
  const profile: RepositoryAccountsOidcModuleVariableProfile = {
    source: "repository_install_ux",
    publicUrlVariable: endpoint.variables.url,
    accountsUrlVariable: grant.variables.accountsUrl!,
    issuerUrlVariable: grant.variables.issuerUrl!,
    clientIdVariable: grant.variables.clientId!,
    redirectUriVariable: grant.variables.redirectUri!,
    callbackPath: grant.callbackPath,
    scopes: grant.scopes ?? [],
  };
  const variableNames = [
    profile.publicUrlVariable,
    profile.accountsUrlVariable,
    profile.issuerUrlVariable,
    profile.clientIdVariable,
    profile.redirectUriVariable,
  ];
  if (
    variableNames.some((name) => !MODULE_VARIABLE.test(name)) ||
    new Set(variableNames).size !== variableNames.length
  ) {
    invalid("repository OIDC variable names are invalid or duplicate");
  }
  return profile;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function invalid(message: string): never {
  throw new TypeError(`Accounts OIDC ${message}`);
}
