import {
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_BILLING_USAGE,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
  normalizeIssuer,
  takosumiAccountsInstallationBillingUsageReportsPath,
} from "@takosjp/takosumi-accounts-contract";
import { sha256Text } from "./encoding.ts";
import { isRecord } from "./http-helpers.ts";
import { isAllowedOidcRedirectUri } from "./installation-routes-internal.ts";
import type { AccountsStore, OidcClientRecord } from "./store.ts";

export const TAKOSUMI_ACCOUNTS_SERVICE_GRAPH_MATERIAL_RESOLVE_PATH =
  "/internal/service-graph/materials/resolve";

export {
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_BILLING_USAGE,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
} from "@takosjp/takosumi-accounts-contract";

export type ServiceGraphMaterialSecret = Readonly<{
  readonly secretRef: string;
}>;

export type ServiceGraphMaterial = Readonly<
  Record<string, JsonValue | ServiceGraphMaterialSecret>
>;

export interface ServiceGraphMaterialResolveContext {
  readonly capsuleId?: string;
  /** Compatibility alias while the accounts ledger still stores installation ids. */
  readonly installationId?: string;
  readonly workspaceId?: string;
  readonly spaceId?: string;
  readonly appId?: string;
  readonly componentName?: string;
  readonly component?: {
    readonly kind?: string;
    readonly spec?: Record<string, unknown>;
    readonly listen?: Record<
      string,
      {
        readonly path?: string;
        readonly inject?: string;
        readonly prefix?: string;
        readonly required?: boolean;
        /** Compatibility for older component-shaped resolver callers. */
        readonly from?: string;
        readonly as?: string;
      }
    >;
  };
  readonly bindingName?: string;
  readonly sourceRef?: string;
  readonly kind?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly many?: boolean;
}

export interface ServiceGraphMaterialResolver {
  resolve(
    context: ServiceGraphMaterialResolveContext,
  ):
    | ServiceGraphMaterial
    | readonly ServiceGraphMaterial[]
    | undefined
    | Promise<
        ServiceGraphMaterial | readonly ServiceGraphMaterial[] | undefined
      >;
}

export interface TakosumiServiceGraphMaterialResolverOptions {
  readonly store: AccountsStore;
  readonly issuer: string;
  readonly internalUrl?:
    | string
    | ((
        context: ServiceGraphMaterialResolveContext,
      ) => string | undefined | Promise<string | undefined>);
  readonly now?: () => number;
  readonly allowDeployControlInstallations?: boolean;
  readonly billingPortalUrl?:
    | string
    | ((
        context: ServiceGraphMaterialResolveContext,
      ) => string | undefined | Promise<string | undefined>);
}

export function createTakosumiServiceGraphMaterialResolver(
  options: TakosumiServiceGraphMaterialResolverOptions,
): ServiceGraphMaterialResolver {
  return {
    resolve: (context) =>
      resolveTakosumiServiceGraphMaterial({
        ...options,
        context,
      }),
  };
}

export async function resolveTakosumiServiceGraphMaterial(
  input: TakosumiServiceGraphMaterialResolverOptions & {
    readonly context: ServiceGraphMaterialResolveContext;
  },
): Promise<ServiceGraphMaterial | readonly ServiceGraphMaterial[] | undefined> {
  switch (input.context.sourceRef) {
    case TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC:
      return await resolveOidcPlatformService(input);
    case TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT:
      return await resolveBillingPlatformService(input);
  }
  if (typeof input.context.kind === "string") {
    return await resolveDiscoveredPlatformServices(input);
  }
  return undefined;
}

async function resolveDiscoveredPlatformServices(
  input: TakosumiServiceGraphMaterialResolverOptions & {
    readonly context: ServiceGraphMaterialResolveContext;
  },
): Promise<readonly ServiceGraphMaterial[]> {
  if (Object.keys(input.context.labels ?? {}).length > 0) return [];
  const kind = input.context.kind;
  if (kind === TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC) {
    return [
      await resolveOidcPlatformService({
        ...input,
        context: {
          ...input.context,
          sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
        },
      }),
    ];
  }
  if (kind === TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_BILLING_USAGE) {
    const material = await resolveBillingPlatformService({
      ...input,
      context: {
        ...input.context,
        sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
      },
    });
    return material ? [material] : [];
  }
  return [];
}

async function resolveOidcPlatformService(
  input: TakosumiServiceGraphMaterialResolverOptions & {
    readonly context: ServiceGraphMaterialResolveContext;
  },
): Promise<ServiceGraphMaterial> {
  if (input.allowDeployControlInstallations) {
    await ensureDeployControlInstallationProjection(input);
  }
  const issuerUrl = normalizeIssuer(input.issuer);
  const capsuleId = contextCapsuleId(input.context);
  const existing = await input.store.findOidcClientForInstallation(
    capsuleId,
  );
  const client = existing
    ? await reconcileOidcClient({
        ...input,
        existing,
        issuerUrl,
      })
    : await createOidcClient({
        ...input,
        issuerUrl,
      });
  // This resolver only ever materializes public (PKCE, `none`) clients. A
  // confidential client requires one-time plaintext-secret delivery to the
  // caller, which the per-Installation create/import path implements (it
  // returns `oidc_client_secret` once at issuance). The resolve path has no
  // such delivery channel — there is no secret store keyed by a secretRef in
  // this package — so emitting a `clientSecretRef` here would advertise a
  // confidential-client material that is never retrievable. We therefore force
  // `none` in createOidcClient and never emit a clientSecretRef. Services that
  // need a confidential client must obtain it through the create/import path.
  return {
    capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
    url: client.issuerUrl,
    issuerUrl: client.issuerUrl,
    ...(await oidcInternalUrlMaterial(input)),
    discoveryUrl: discoveryUrl(client.issuerUrl),
    clientId: client.clientId,
    redirectOrigin: redirectOrigin(client.redirectUris),
    redirectUris: [...client.redirectUris],
    allowedScopes: [...client.allowedScopes],
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
  };
}

async function reconcileOidcClient(
  input: TakosumiServiceGraphMaterialResolverOptions & {
    readonly context: ServiceGraphMaterialResolveContext;
    readonly existing: OidcClientRecord;
    readonly issuerUrl: string;
  },
): Promise<OidcClientRecord> {
  if (!contextDeclaresOidcClientShape(input.context)) return input.existing;
  const redirectUris = redirectUrisFromContext(input.context, input.issuerUrl);
  const allowedScopes = allowedScopesFromContext(input.context);
  if (
    sameStrings(input.existing.redirectUris, redirectUris) &&
    sameStrings(input.existing.allowedScopes, allowedScopes)
  ) {
    return input.existing;
  }

  const client = {
    ...input.existing,
    redirectUris,
    allowedScopes,
    updatedAt: input.now?.() ?? Date.now(),
  };
  await input.store.saveOidcClient(client);
  return client;
}

async function oidcInternalUrlMaterial(
  input: TakosumiServiceGraphMaterialResolverOptions & {
    readonly context: ServiceGraphMaterialResolveContext;
  },
): Promise<{ readonly internalUrl?: string }> {
  if (typeof input.internalUrl === "function") {
    const value = await input.internalUrl(input.context);
    return value ? { internalUrl: normalizeIssuer(value) } : {};
  }
  return input.internalUrl
    ? { internalUrl: normalizeIssuer(input.internalUrl) }
    : {};
}

async function createOidcClient(
  input: TakosumiServiceGraphMaterialResolverOptions & {
    readonly context: ServiceGraphMaterialResolveContext;
    readonly issuerUrl: string;
  },
) {
  const now = input.now?.() ?? Date.now();
  // Public client only. See resolveOidcPlatformService: the resolve path cannot
  // deliver a confidential client's plaintext secret, so we never mint one here.
  const client = {
    clientId: `toc_${crypto.randomUUID()}`,
    installationId: contextCapsuleId(input.context),
    namespacePath: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
    issuerUrl: input.issuerUrl,
    redirectUris: redirectUrisFromContext(input.context, input.issuerUrl),
    allowedScopes: allowedScopesFromContext(input.context),
    subjectMode: "pairwise" as const,
    tokenEndpointAuthMethod: "none" as const,
    clientSecretHash: undefined,
    createdAt: now,
    updatedAt: now,
  };
  await input.store.saveOidcClient(client);
  return client;
}

async function ensureDeployControlInstallationProjection(
  input: TakosumiServiceGraphMaterialResolverOptions & {
    readonly context: ServiceGraphMaterialResolveContext;
  },
): Promise<void> {
  const existing = await input.store.findAppInstallation(
    contextCapsuleId(input.context),
  );
  if (existing) return;

  const now = input.now?.() ?? Date.now();
  // System-owned compatibility projection used when the embedded deploy-control
  // surface asks Accounts for service material before a user-owned projection
  // row exists. These synthetic ids must never be rendered as customer-owned
  // account, Space, or Installation objects in product UI.
  const ownerSubject = "tsub_direct_deployControl" as const;
  const capsuleId = contextCapsuleId(input.context);
  const spaceId =
    contextWorkspaceId(input.context) ?? "space_direct_deployControl";
  const existingSpace = await input.store.findSpace(spaceId);
  const accountId = existingSpace?.accountId ?? "acct_direct_deployControl";
  const appId = input.context.appId ?? "unknown.app";
  const sourceFingerprint = await sha256Text(
    JSON.stringify({
      capsuleId,
      spaceId,
      appId,
    }),
  );

  if (!existingSpace) {
    await input.store.saveLedgerAccount({
      accountId,
      legalOwnerSubject: ownerSubject,
      createdAt: now,
      updatedAt: now,
    });
    await input.store.saveSpace({
      spaceId,
      accountId,
      kind: "personal",
      displayName: "Deploy Control",
      createdAt: now,
      updatedAt: now,
    });
  }
  await input.store.saveAppInstallation({
    installationId: capsuleId,
    accountId,
    spaceId,
    appId,
    sourceGitUrl: "deploy-control://local",
    sourceRef: "direct",
    sourceCommit: "direct",
    planDigest: sourceFingerprint,
    mode: "self-hosted",
    status: "installing",
    createdBySubject: ownerSubject,
    createdAt: now,
    updatedAt: now,
  });
}

async function resolveBillingPlatformService(
  input: TakosumiServiceGraphMaterialResolverOptions & {
    readonly context: ServiceGraphMaterialResolveContext;
  },
): Promise<ServiceGraphMaterial | undefined> {
  const issuer = normalizeIssuer(input.issuer);
  const capsuleId = contextCapsuleId(input.context);
  const installation = await input.store.findAppInstallation(
    capsuleId,
  );
  const spaceId = installation?.spaceId ?? contextWorkspaceId(input.context);
  if (!spaceId) return undefined;
  const space = await input.store.findSpace(spaceId);
  const accountId = installation?.accountId ?? space?.accountId;
  if (!accountId) return undefined;
  const account = await input.store.findLedgerAccount(accountId);
  const billingAccount = installation?.billingAccountId
    ? await input.store.findBillingAccount(installation.billingAccountId)
    : account?.billingAccountId
      ? await input.store.findBillingAccount(account.billingAccountId)
      : account
        ? await input.store.findBillingAccountForSubject(
            account.legalOwnerSubject,
          )
        : undefined;
  const portalUrl = await billingPortalUrl(input);
  return {
    capability: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_BILLING_USAGE,
    ...(portalUrl ? { portalUrl } : {}),
    usageReportEndpoint: new URL(
      takosumiAccountsInstallationBillingUsageReportsPath(
        capsuleId,
      ),
      issuer,
    ).toString(),
    billingSubjectRef: billingAccount
      ? `takosumi-accounts://billing-accounts/${encodeURIComponent(
          billingAccount.billingAccountId,
        )}`
      : `takosumi-accounts://accounts/${encodeURIComponent(accountId)}/billing`,
  };
}

async function billingPortalUrl(
  input: TakosumiServiceGraphMaterialResolverOptions & {
    readonly context: ServiceGraphMaterialResolveContext;
  },
): Promise<string | undefined> {
  if (typeof input.billingPortalUrl === "function") {
    return await input.billingPortalUrl(input.context);
  }
  if (typeof input.billingPortalUrl === "string") {
    return input.billingPortalUrl;
  }
  return new URL("/account/billing", normalizeIssuer(input.issuer)).toString();
}

function redirectUrisFromContext(
  context: ServiceGraphMaterialResolveContext,
  issuerUrl: string,
): readonly string[] {
  const spec = context.component?.spec;
  const direct = spec ? stringArray(spec.redirectUris) : undefined;
  if (direct?.every(isAllowedOidcRedirectUri)) return direct;
  const paths = spec
    ? (stringArray(spec.redirectPaths) ??
      stringArray(spec.oauthRedirectPaths) ??
      stringArray(spec.callbackPaths))
    : undefined;
  if (paths?.every(isIssuerRelativePath)) {
    return paths.map((path) => new URL(path, issuerUrl).toString());
  }
  const singlePath =
    spec && typeof spec.redirectPath === "string"
      ? spec.redirectPath
      : spec && typeof spec.oauthRedirectPath === "string"
        ? spec.oauthRedirectPath
        : undefined;
  if (singlePath && isIssuerRelativePath(singlePath)) {
    return [new URL(singlePath, issuerUrl).toString()];
  }
  return [
    new URL(
      `/oauth/callback/${encodeURIComponent(contextCapsuleId(context))}`,
      issuerUrl,
    ).toString(),
  ];
}

function contextCapsuleId(context: ServiceGraphMaterialResolveContext): string {
  const capsuleId = context.capsuleId ?? context.installationId;
  if (!capsuleId) {
    throw new TypeError("Service Graph material context requires capsuleId");
  }
  return capsuleId;
}

function contextWorkspaceId(
  context: ServiceGraphMaterialResolveContext,
): string | undefined {
  return context.workspaceId ?? context.spaceId;
}

function isIssuerRelativePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

function allowedScopesFromContext(
  context: ServiceGraphMaterialResolveContext,
): readonly string[] {
  const scopes = context.component?.spec
    ? (stringArray(context.component.spec.oidcScopes) ??
      stringArray(context.component.spec.scopes))
    : undefined;
  const normalized = [...new Set(scopes ?? ["openid"])].filter(
    (scope) => scope.length > 0,
  );
  return normalized.includes("openid") ? normalized : ["openid", ...normalized];
}

function discoveryUrl(issuerUrl: string): string {
  return new URL("/.well-known/openid-configuration", issuerUrl).toString();
}

function redirectOrigin(redirectUris: readonly string[]): string {
  const first = redirectUris[0];
  if (!first) return "";
  try {
    return new URL(first).origin;
  } catch {
    return "";
  }
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return strings.length === value.length ? strings : undefined;
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

function contextDeclaresOidcClientShape(
  context: ServiceGraphMaterialResolveContext,
): boolean {
  const spec = context.component?.spec;
  if (!spec) return false;
  return [
    "redirectUris",
    "redirectPaths",
    "oauthRedirectPaths",
    "callbackPaths",
    "redirectPath",
    "oauthRedirectPath",
    "oidcScopes",
    "scopes",
  ].some((key) => spec[key] !== undefined);
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function isServiceGraphMaterialResolveContext(
  value: unknown,
): value is ServiceGraphMaterialResolveContext {
  if (
    !isRecord(value) ||
    (typeof value.capsuleId !== "string" &&
      typeof value.installationId !== "string")
  ) {
    return false;
  }
  const sourceRef = value.sourceRef;
  const kind = value.kind;
  if (sourceRef !== undefined && typeof sourceRef !== "string") return false;
  if (kind !== undefined && typeof kind !== "string") return false;
  if (sourceRef === undefined && kind === undefined) return false;
  return true;
}
