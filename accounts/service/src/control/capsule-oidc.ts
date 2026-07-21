import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import {
  installExperienceOidcClient,
  installExperiencePublicEndpoint,
  type OidcClientProjection,
  type PublicEndpointProjection,
} from "takosumi-contract";
import { normalizeIssuer } from "@takosjp/takosumi-accounts-contract";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import type { ControlPlaneOperations } from "../control-operations.ts";
import type { AccountsStore, OidcClientRecord } from "../store.ts";
import {
  isManagedPublicHost,
  managedPublicHostFromLabel,
  managedPublicHostForWorkspace,
  normalizeManagedPublicBaseDomain,
} from "../../../../core/domains/deploy-control/managed_public_domains.ts";

interface ResolvedTakosumiAccountsOidcExperience {
  readonly issuerUrlVariable?: string;
  readonly clientIdVariable?: string;
  readonly callbackPath: string;
  readonly accountsUrlVariable?: string;
  readonly redirectUriVariable?: string;
  readonly scopes?: readonly string[];
}

const OIDC_CLIENT_NAMESPACE = "identity.oidc";

export async function ensureTakosumiAccountsOidcForCapsule(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly issuer: string;
  readonly capsule: Capsule;
  readonly installConfig: InstallConfig;
  readonly managedPublicBaseDomain?: string;
}): Promise<void> {
  const oidcExperience = installOidcClientExperience(input.installConfig);
  if (!oidcExperience) {
    return;
  }
  const workspace = await input.operations.workspaces.getWorkspace(
    input.capsule.workspaceId,
  );
  const redirectOrigin = appOriginFromInstallVariables(
    input.installConfig.variableMapping,
    installExperiencePublicEndpoint(input.installConfig.installExperience),
    workspace.handle,
    input.managedPublicBaseDomain,
    input.installConfig.managedPublicHostname?.mode ?? "scoped",
  );
  if (!redirectOrigin) return;

  const issuerUrl = normalizeIssuer(input.issuer);
  const now = Date.now();
  const callbackPath = normalizedCallbackPath(oidcExperience.callbackPath);
  const redirectUri = `${redirectOrigin}${callbackPath}`;
  const redirectUris = [redirectUri];
  const existing = await oidcClientForCapsuleOrMappedClientId(
    input.store,
    input.capsule.id,
    input.installConfig.variableMapping,
    oidcExperience,
  );
  const client: OidcClientRecord = existing
    ? {
        ...existing,
        capsuleId: input.capsule.id,
        issuerUrl,
        redirectUris,
        allowedScopes: oidcAllowedScopes(oidcExperience.scopes),
        tokenEndpointAuthMethod: "none",
        updatedAt: now,
      }
    : {
        clientId:
          mappedOidcClientId(
            input.installConfig.variableMapping,
            oidcExperience,
          ) ?? `toc_${crypto.randomUUID()}`,
        capsuleId: input.capsule.id,
        namespacePath: OIDC_CLIENT_NAMESPACE,
        issuerUrl,
        redirectUris,
        allowedScopes: oidcAllowedScopes(oidcExperience.scopes),
        subjectMode: "pairwise",
        tokenEndpointAuthMethod: "none",
        clientSecretHash: undefined,
        createdAt: now,
        updatedAt: now,
      };
  await input.store.saveOidcClient(client);
  const variableMapping = {
    ...input.installConfig.variableMapping,
    ...(oidcExperience.issuerUrlVariable
      ? { [oidcExperience.issuerUrlVariable]: client.issuerUrl }
      : {}),
    ...(oidcExperience.clientIdVariable
      ? { [oidcExperience.clientIdVariable]: client.clientId }
      : {}),
    ...(oidcExperience.accountsUrlVariable
      ? { [oidcExperience.accountsUrlVariable]: client.issuerUrl }
      : {}),
    ...(oidcExperience.redirectUriVariable
      ? { [oidcExperience.redirectUriVariable]: redirectUri }
      : {}),
  };
  await input.operations.capsules.putInstallConfig({
    ...input.installConfig,
    variableMapping,
    updatedAt: new Date(now).toISOString(),
  });
}

function oidcAllowedScopes(scopes: readonly string[] | undefined): string[] {
  const configured = scopes?.map((scope) => scope.trim()).filter(Boolean) ?? [];
  const normalized = [...new Set(configured)];
  return normalized.includes("openid")
    ? normalized
    : [
        "openid",
        ...(normalized.length > 0 ? normalized : ["profile", "email"]),
      ];
}

async function oidcClientForCapsuleOrMappedClientId(
  store: AccountsStore,
  capsuleId: string,
  variables: InstallConfig["variableMapping"],
  oidcExperience: ResolvedTakosumiAccountsOidcExperience,
): Promise<OidcClientRecord | undefined> {
  const byCapsule = await store.findOidcClientForCapsule(capsuleId);
  if (byCapsule) return byCapsule;
  const clientId = mappedOidcClientId(variables, oidcExperience);
  if (!clientId) return undefined;
  const mapped = await store.findOidcClient(clientId);
  if (!mapped) return undefined;
  // The mapped client id comes from a caller-supplied install variable, so it
  // may only ever re-select this Capsule's own registration. Without this the
  // saveOidcClient upsert below would rewrite ANOTHER Capsule's client — its
  // capsuleId, issuer, allowed scopes and redirectUris — to values the caller
  // chose, taking over that Capsule's sign-in. Fail the install instead of
  // minting a fresh id: the upsert is keyed on clientId, so continuing with the
  // colliding id would rewrite the victim row just the same.
  if (mapped.capsuleId !== capsuleId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "oidc_client_id_already_bound: the OIDC client id belongs to another Capsule",
      { reason: "oidc_client_id_already_bound" },
    );
  }
  return mapped;
}

export async function ensureTakosumiAccountsOidcForExistingCapsule(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly issuer?: string;
  readonly capsule: Capsule;
  readonly managedPublicBaseDomain?: string;
}): Promise<void> {
  if (!input.issuer) return;
  const installConfig = await input.operations.capsules.getInstallConfig(
    input.capsule.installConfigId,
  );
  await ensureTakosumiAccountsOidcForCapsule({
    operations: input.operations,
    store: input.store,
    issuer: input.issuer,
    capsule: input.capsule,
    installConfig,
    ...(input.managedPublicBaseDomain
      ? { managedPublicBaseDomain: input.managedPublicBaseDomain }
      : {}),
  });
}

function installOidcClientExperience(
  config: InstallConfig,
): ResolvedTakosumiAccountsOidcExperience | undefined {
  const configured = installExperienceOidcClient(config.installExperience);
  return configured ? { ...configured } : undefined;
}

function mappedOidcClientId(
  variables: InstallConfig["variableMapping"],
  oidcExperience: ResolvedTakosumiAccountsOidcExperience,
): string | undefined {
  if (!oidcExperience.clientIdVariable) return undefined;
  const clientId = variables[oidcExperience.clientIdVariable];
  return stringInstallVariable(clientId);
}

function normalizedCallbackPath(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function appOriginFromInstallVariables(
  variables: InstallConfig["variableMapping"],
  publicEndpoint?: PublicEndpointProjection,
  workspaceHandle?: string,
  managedPublicBaseDomain?: string,
  managedPublicHostnameMode: "scoped" | "vanity" = "scoped",
): string | undefined {
  if (!publicEndpoint) return undefined;
  const declaredBaseDomain = publicEndpointBaseDomain(
    publicEndpoint?.baseDomain,
  );
  const baseDomain =
    normalizeManagedPublicBaseDomain(managedPublicBaseDomain) ??
    declaredBaseDomain;
  const requestedSlug = publicEndpoint.subdomainVariable
    ? stringInstallVariable(variables[publicEndpoint.subdomainVariable])
    : undefined;
  for (const variableName of publicEndpoint.urlVariable
    ? [publicEndpoint.urlVariable]
    : []) {
    const appUrl = stringInstallVariable(variables[variableName]);
    if (!appUrl) continue;
    try {
      const url = new URL(appUrl);
      if (url.protocol !== "https:" || !url.hostname) continue;
      const matchedBaseDomain = [baseDomain, declaredBaseDomain]
        .filter((candidate): candidate is string => Boolean(candidate))
        .find((candidate) => isManagedPublicHost(url.hostname, candidate));
      if (matchedBaseDomain) {
        const requestedLabel =
          managedPublicHostnameMode === "vanity" && requestedSlug
            ? requestedSlug
            : url.hostname.slice(0, -(matchedBaseDomain.length + 1));
        const managedHost =
          baseDomain && managedPublicHostnameMode === "vanity"
            ? managedPublicHostFromLabel(requestedLabel, baseDomain)
            : baseDomain
              ? managedPublicHostForWorkspace(
                  workspaceHandle,
                  requestedLabel,
                  baseDomain,
                )
              : undefined;
        if (managedHost) return `https://${managedHost}`;
      }
      return url.origin;
    } catch {
      continue;
    }
  }
  const managedHost = baseDomain
    ? managedPublicHostnameMode === "vanity"
      ? managedPublicHostFromLabel(requestedSlug, baseDomain)
      : managedPublicHostForWorkspace(
          workspaceHandle,
          requestedSlug,
          baseDomain,
        )
    : undefined;
  return managedHost ? `https://${managedHost}` : undefined;
}

function publicEndpointBaseDomain(value: unknown): string | undefined {
  const baseDomain = stringInstallVariable(value)?.toLowerCase();
  return baseDomain &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
      baseDomain,
    )
    ? baseDomain
    : undefined;
}

function stringInstallVariable(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}
