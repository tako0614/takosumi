import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import {
  installExperienceOidcClient,
  installExperiencePublicEndpoint,
  type OidcClientProjection,
  type PublicEndpointProjection,
} from "takosumi-contract";
import {
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
  normalizeIssuer,
} from "@takosjp/takosumi-accounts-contract";
import type { ControlPlaneOperations } from "../control-operations.ts";
import type { AccountsStore, OidcClientRecord } from "../store.ts";
import {
  isManagedPublicHost,
  managedPublicHostForWorkspace,
  normalizeManagedPublicBaseDomain,
} from "../../../../core/domains/deploy-control/managed_public_domains.ts";
import { refreshRepoOwnedInstallConfigForCapsule } from "./repo-owned-install-config.ts";

type InstallExperience = NonNullable<
  InstallConfig["store"]
>["installExperience"];
interface ResolvedTakosumiAccountsOidcExperience {
  readonly issuerUrlVariable: string;
  readonly clientIdVariable: string;
  readonly callbackPath: string;
  readonly accountsUrlVariable?: string;
  readonly redirectUriVariable?: string;
  readonly scopes?: readonly string[];
}

const DEFAULT_TAKOSUMI_ACCOUNTS_OIDC: ResolvedTakosumiAccountsOidcExperience = {
  issuerUrlVariable: "takosumi_accounts_issuer_url",
  clientIdVariable: "takosumi_accounts_client_id",
  callbackPath: "/api/auth/callback/takos",
};

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
  const workspace = await input.operations.spaces.getWorkspace(
    input.capsule.workspaceId,
  );
  const redirectOrigin = appOriginFromInstallVariables(
    input.installConfig.variableMapping,
    installExperiencePublicEndpoint(
      input.installConfig.store?.installExperience,
    ),
    workspace.handle,
    input.managedPublicBaseDomain,
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
        namespacePath: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
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
    [oidcExperience.issuerUrlVariable]: client.issuerUrl,
    [oidcExperience.clientIdVariable]: client.clientId,
    ...(oidcExperience.accountsUrlVariable
      ? { [oidcExperience.accountsUrlVariable]: client.issuerUrl }
      : {}),
    ...(oidcExperience.redirectUriVariable
      ? { [oidcExperience.redirectUriVariable]: redirectUri }
      : {}),
  };
  await input.operations.installations.putInstallConfig({
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
  return clientId ? await store.findOidcClient(clientId) : undefined;
}

export async function ensureTakosumiAccountsOidcForExistingCapsule(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly issuer?: string;
  readonly capsule: Capsule;
  readonly managedPublicBaseDomain?: string;
}): Promise<void> {
  if (!input.issuer) return;
  const storedInstallConfig =
    await input.operations.installations.getInstallConfig(
      input.capsule.installConfigId,
    );
  const installConfig = await refreshRepoOwnedInstallConfigForCapsule({
    operations: input.operations,
    capsule: input.capsule,
    installConfig: storedInstallConfig,
  });
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
  const store = config.store;
  const configured = installExperienceOidcClient(store?.installExperience);
  if (configured) {
    return {
      ...DEFAULT_TAKOSUMI_ACCOUNTS_OIDC,
      ...configured,
    };
  }
  const standard = standardOidcExperienceFromVariables(config.variableMapping);
  return standard;
}

function standardOidcExperienceFromVariables(
  variables: InstallConfig["variableMapping"],
): ResolvedTakosumiAccountsOidcExperience | undefined {
  if (
    !Object.prototype.hasOwnProperty.call(
      variables,
      "takosumi_accounts_issuer_url",
    ) &&
    !Object.prototype.hasOwnProperty.call(
      variables,
      "takosumi_accounts_client_id",
    ) &&
    !Object.prototype.hasOwnProperty.call(
      variables,
      "takosumi_accounts_redirect_uri",
    )
  ) {
    return undefined;
  }
  const redirectUri = stringInstallVariable(
    variables.takosumi_accounts_redirect_uri,
  );
  const callbackPath = redirectUri
    ? callbackPathFromRedirectUri(redirectUri)
    : undefined;
  return {
    ...DEFAULT_TAKOSUMI_ACCOUNTS_OIDC,
    ...(Object.prototype.hasOwnProperty.call(variables, "takosumi_accounts_url")
      ? { accountsUrlVariable: "takosumi_accounts_url" }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(
      variables,
      "takosumi_accounts_redirect_uri",
    )
      ? { redirectUriVariable: "takosumi_accounts_redirect_uri" }
      : {}),
    ...(callbackPath ? { callbackPath } : {}),
  };
}

function callbackPathFromRedirectUri(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.pathname && url.pathname !== "/" ? url.pathname : undefined;
  } catch {
    return undefined;
  }
}

function mappedOidcClientId(
  variables: InstallConfig["variableMapping"],
  oidcExperience: ResolvedTakosumiAccountsOidcExperience,
): string | undefined {
  const clientId = variables[oidcExperience.clientIdVariable];
  return stringInstallVariable(clientId);
}

function normalizedCallbackPath(value: string | undefined): string {
  const trimmed = value?.trim() || DEFAULT_TAKOSUMI_ACCOUNTS_OIDC.callbackPath;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function appOriginFromInstallVariables(
  variables: InstallConfig["variableMapping"],
  publicEndpoint?: PublicEndpointProjection,
  workspaceHandle?: string,
  managedPublicBaseDomain?: string,
): string | undefined {
  const declaredBaseDomain = publicEndpointBaseDomain(publicEndpoint?.baseDomain);
  const baseDomain =
    normalizeManagedPublicBaseDomain(managedPublicBaseDomain) ??
    declaredBaseDomain;
  const requestedSlug = firstMappedString(variables, [
    publicEndpoint?.subdomainVariable,
    "public_subdomain",
    "worker_name",
    "project_name",
  ]);
  for (const variableName of uniqueStrings([
    publicEndpoint?.urlVariable,
    "public_url",
    "app_url",
  ])) {
    const appUrl = stringInstallVariable(variables[variableName]);
    if (!appUrl) continue;
    try {
      const url = new URL(appUrl);
      if (url.protocol !== "https:" || !url.hostname) continue;
      const matchedBaseDomain = [baseDomain, declaredBaseDomain].find(
        (candidate) => isManagedPublicHost(url.hostname, candidate),
      );
      if (matchedBaseDomain) {
        const managedHost = managedPublicHostForWorkspace(
          workspaceHandle,
          url.hostname.slice(0, -(matchedBaseDomain.length + 1)),
          baseDomain,
        );
        if (managedHost) return `https://${managedHost}`;
      }
      return url.origin;
    } catch {
      continue;
    }
  }
  const managedHost = managedPublicHostForWorkspace(
    workspaceHandle,
    requestedSlug,
    baseDomain,
  );
  return managedHost ? `https://${managedHost}` : undefined;
}

function firstMappedString(
  variables: InstallConfig["variableMapping"],
  names: readonly (string | undefined)[],
): string | undefined {
  for (const name of uniqueStrings(names)) {
    const value = stringInstallVariable(variables[name]);
    if (value) return value;
  }
  return undefined;
}

function publicEndpointBaseDomain(value: unknown): string {
  const baseDomain = stringInstallVariable(value)?.toLowerCase();
  return baseDomain &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
      baseDomain,
    )
    ? baseDomain
    : "app.takos.jp";
}

function uniqueStrings(
  values: readonly (string | undefined)[],
): readonly string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

function stringInstallVariable(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}
