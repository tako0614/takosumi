import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import type { Source } from "takosumi-contract/sources";
import {
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
  normalizeIssuer,
} from "@takosjp/takosumi-accounts-contract";
import type { ControlPlaneOperations } from "../control-operations.ts";
import type { AccountsStore, OidcClientRecord } from "../store.ts";

export async function ensureTakosumiAccountsOidcForCapsule(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly issuer: string;
  readonly capsule: Capsule;
  readonly installConfig: InstallConfig;
  readonly sourceGitUrl?: string;
}): Promise<void> {
  if (
    !shouldAutoProvisionTakosumiAccountsOidc(
      input.installConfig,
      input.sourceGitUrl,
    )
  ) {
    return;
  }
  if (hasTakosumiAccountsOidcVariables(input.installConfig.variableMapping)) {
    return;
  }
  const redirectOrigin = appOriginFromInstallVariables(
    input.installConfig.variableMapping,
    input.installConfig.catalog?.installExperience?.publicEndpoint,
  );
  if (!redirectOrigin) return;

  const issuerUrl = normalizeIssuer(input.issuer);
  const now = Date.now();
  const redirectUris = [`${redirectOrigin}/api/auth/callback/takos`];
  const existing = await input.store.findOidcClientForCapsule(input.capsule.id);
  const client: OidcClientRecord = existing
    ? {
        ...existing,
        issuerUrl,
        redirectUris,
        allowedScopes: ["openid", "profile", "email"],
        tokenEndpointAuthMethod: "none",
        updatedAt: now,
      }
    : {
        clientId: `toc_${crypto.randomUUID()}`,
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
  await input.operations.installations.putInstallConfig({
    ...input.installConfig,
    variableMapping: {
      ...input.installConfig.variableMapping,
      takosumi_accounts_issuer_url: client.issuerUrl,
      takosumi_accounts_client_id: client.clientId,
    },
    updatedAt: new Date(now).toISOString(),
  });
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

function shouldAutoProvisionTakosumiAccountsOidc(
  config: InstallConfig,
  sourceGitUrl?: string,
): boolean {
  if (config.catalog?.templateId === "yurucommu") return true;
  return (
    isYurucommuGitUrl(config.catalog?.source?.git) ||
    isYurucommuGitUrl(sourceGitUrl)
  );
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

function hasTakosumiAccountsOidcVariables(
  variables: InstallConfig["variableMapping"],
): boolean {
  return (
    typeof variables.takosumi_accounts_issuer_url === "string" &&
    variables.takosumi_accounts_issuer_url.trim() !== "" &&
    typeof variables.takosumi_accounts_client_id === "string" &&
    variables.takosumi_accounts_client_id.trim() !== ""
  );
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
