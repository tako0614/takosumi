import type { InstallConfigInstallProjection } from "./install-configs.ts";

export interface InstallExperienceLike {
  readonly projections?: readonly InstallConfigInstallProjection[];
}

export interface PublicEndpointProjection {
  readonly subdomainVariable?: string;
  readonly urlVariable?: string;
  readonly routePatternVariable?: string;
  readonly baseDomain?: string;
}

export interface InitialSecretProjection {
  readonly variable: string;
  readonly kind?: "password" | "password_or_hash" | "token";
  readonly optional?: boolean;
}

export interface OidcClientProjection {
  readonly issuerUrlVariable?: string;
  readonly accountsUrlVariable?: string;
  readonly clientIdVariable?: string;
  readonly redirectUriVariable?: string;
  readonly callbackPath?: string;
}

export interface ArtifactProjection {
  readonly urlVariable?: string;
  readonly sha256Variable?: string;
}

export function installExperienceServiceNameVariable(
  installExperience: InstallExperienceLike | undefined,
): string | undefined {
  const projection = installExperience?.projections?.find(
    (candidate) => candidate.kind === "service_name",
  );
  if (projection?.kind === "service_name") {
    return projection.variable.trim() || undefined;
  }
  return undefined;
}

export function installExperiencePublicEndpoint(
  installExperience: InstallExperienceLike | undefined,
): PublicEndpointProjection | undefined {
  const projection = installExperience?.projections?.find(
    (candidate) => candidate.kind === "public_endpoint",
  );
  if (projection?.kind === "public_endpoint") {
    return {
      subdomainVariable: projection.variables.subdomain,
      urlVariable: projection.variables.url,
      routePatternVariable: projection.variables.routePattern,
      baseDomain: projection.baseDomain,
    };
  }
  return undefined;
}

export function installExperienceInitialSecret(
  installExperience: InstallExperienceLike | undefined,
): InitialSecretProjection | undefined {
  const projection = installExperience?.projections?.find(
    (candidate) => candidate.kind === "initial_secret",
  );
  if (projection?.kind === "initial_secret") {
    return {
      variable: projection.variable,
      kind: projection.secretKind,
      optional: projection.optional,
    };
  }
  return undefined;
}

export function installExperienceOidcClient(
  installExperience: InstallExperienceLike | undefined,
): OidcClientProjection | undefined {
  const projection = installExperience?.projections?.find(
    (candidate) => candidate.kind === "oidc_client",
  );
  if (projection?.kind === "oidc_client") {
    return {
      issuerUrlVariable: projection.variables.issuerUrl,
      accountsUrlVariable: projection.variables.accountsUrl,
      clientIdVariable: projection.variables.clientId,
      redirectUriVariable: projection.variables.redirectUri,
      callbackPath: projection.callbackPath,
    };
  }
  return undefined;
}

export function installExperienceArtifact(
  installExperience: InstallExperienceLike | undefined,
): ArtifactProjection | undefined {
  const projection = installExperience?.projections?.find(
    (candidate) => candidate.kind === "artifact",
  );
  if (projection?.kind !== "artifact") return undefined;
  return {
    urlVariable: projection.variables.url,
    sha256Variable: projection.variables.sha256,
  };
}
