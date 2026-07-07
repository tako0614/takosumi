import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import type { Source } from "takosumi-contract/sources";
import {
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
  normalizeIssuer,
} from "@takosjp/takosumi-accounts-contract";
import type { ControlPlaneOperations } from "../control-operations.ts";
import type { AccountsStore, OidcClientRecord } from "../store.ts";

type InstallExperience = NonNullable<InstallConfig["catalog"]>["installExperience"];
type TakosumiAccountsOidcExperience = NonNullable<
  NonNullable<InstallExperience>["takosumiAccountsOidc"]
>;
interface ResolvedTakosumiAccountsOidcExperience {
  readonly issuerUrlVariable: string;
  readonly clientIdVariable: string;
  readonly callbackPath: string;
  readonly accountsUrlVariable?: string;
  readonly redirectUriVariable?: string;
}

const DEFAULT_TAKOSUMI_ACCOUNTS_OIDC: ResolvedTakosumiAccountsOidcExperience = {
  issuerUrlVariable: "takosumi_accounts_issuer_url",
  clientIdVariable: "takosumi_accounts_client_id",
  callbackPath: "/api/auth/callback/takos",
};

const TAKOS_DISTRIBUTION_ACCOUNTS_OIDC: ResolvedTakosumiAccountsOidcExperience =
  {
    issuerUrlVariable: "takosumi_accounts_issuer_url",
    accountsUrlVariable: "takosumi_accounts_url",
    clientIdVariable: "takosumi_accounts_client_id",
    redirectUriVariable: "takosumi_accounts_redirect_uri",
    callbackPath: "/auth/oidc/callback",
  };

export async function ensureTakosumiAccountsOidcForCapsule(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly issuer: string;
  readonly capsule: Capsule;
  readonly installConfig: InstallConfig;
  readonly sourceGitUrl?: string;
}): Promise<void> {
  const oidcExperience = takosumiAccountsOidcExperience(
    input.installConfig,
    input.sourceGitUrl,
  );
  if (!oidcExperience) {
    return;
  }
  const redirectOrigin = appOriginFromInstallVariables(
    input.installConfig.variableMapping,
    input.installConfig.catalog?.installExperience?.publicEndpoint,
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
        allowedScopes: ["openid", "profile", "email"],
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
        allowedScopes: ["openid", "profile", "email"],
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
}): Promise<void> {
  if (!input.issuer) return;
  const installConfig = await input.operations.installations.getInstallConfig(
    input.capsule.installConfigId,
  );
  const sourceGitUrl = await getCapsuleSourceGitUrl(
    input.operations,
    input.capsule,
  );
  await ensureTakosumiAccountsOidcForCapsule({
    operations: input.operations,
    store: input.store,
    issuer: input.issuer,
    capsule: input.capsule,
    installConfig,
    sourceGitUrl,
  });
}

function takosumiAccountsOidcExperience(
  config: InstallConfig,
  sourceGitUrl?: string,
): ResolvedTakosumiAccountsOidcExperience | undefined {
  const configured = config.catalog?.installExperience?.takosumiAccountsOidc;
  if (configured) {
    return {
      ...DEFAULT_TAKOSUMI_ACCOUNTS_OIDC,
      ...configured,
    };
  }
  if (
    config.catalog?.templateId === "takos" ||
    isTakosGitUrl(config.catalog?.source?.git) ||
    isTakosGitUrl(sourceGitUrl)
  ) {
    return TAKOS_DISTRIBUTION_ACCOUNTS_OIDC;
  }
  if (
    config.catalog?.templateId === "yurucommu" ||
    isYurucommuGitUrl(config.catalog?.source?.git) ||
    isYurucommuGitUrl(sourceGitUrl)
  ) {
    return DEFAULT_TAKOSUMI_ACCOUNTS_OIDC;
  }
  return undefined;
}

async function getCapsuleSourceGitUrl(
  operations: ControlPlaneOperations,
  capsule: Capsule,
): Promise<string | undefined> {
  if (!capsule.sourceId) return undefined;
  try {
    const { source } = await operations.getSource(capsule.sourceId);
    return sourceGitUrl(source);
  } catch {
    return undefined;
  }
}

function sourceGitUrl(source: Source): string | undefined {
  return stringInstallVariable(source.url);
}

function isYurucommuGitUrl(value: unknown): boolean {
  const git = stringInstallVariable(value)?.toLowerCase() ?? "";
  return /(^|[:/])tako0614\/yurucommu(?:\.git)?$/u.test(git);
}

function isTakosGitUrl(value: unknown): boolean {
  const git = stringInstallVariable(value)?.toLowerCase() ?? "";
  return /(^|[:/])tako0614\/takos(?:\.git)?$/u.test(git);
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
  publicEndpoint?: NonNullable<
    NonNullable<InstallConfig["catalog"]>["installExperience"]
  >["publicEndpoint"],
): string | undefined {
  for (const variableName of uniqueStrings([
    publicEndpoint?.urlVariable,
    "app_url",
  ])) {
    const appUrl = stringInstallVariable(variables[variableName]);
    if (!appUrl) continue;
    try {
      const url = new URL(appUrl);
      if (url.protocol === "https:" && url.hostname) return url.origin;
    } catch {
      continue;
    }
  }
  const baseDomain = publicEndpointBaseDomain(publicEndpoint?.baseDomain);
  for (const variableName of uniqueStrings([
    publicEndpoint?.subdomainVariable,
    "worker_name",
    "project_name",
  ])) {
    const subdomain = stringInstallVariable(variables[variableName]);
    if (subdomain && publicAppSubdomainIsValid(subdomain)) {
      return `https://${subdomain.toLowerCase()}.${baseDomain}`;
    }
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

function publicAppSubdomainIsValid(value: string): boolean {
  return /^[a-z][a-z0-9-]{1,50}[a-z0-9]$/u.test(value.toLowerCase());
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
