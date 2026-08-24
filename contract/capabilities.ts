export const TAKOSUMI_API_VERSION = "takosumi.dev/v1alpha1" as const;
export const TAKOSUMI_INTERFACES_CAPABILITY = "takosumi.interfaces.v1" as const;

export interface TakosumiWellKnownDocument {
  /** Identifies this document as the Takosumi native-client discovery target. */
  readonly product: "takosumi";
  readonly name: "Takosumi";
  /** Exact operator-registered public PKCE client; absent when mobile is disabled. */
  readonly oidcClientId?: string;
  readonly auth: {
    readonly oidc: true;
    readonly password: false;
  };
  readonly apiBaseUrl: string;
  readonly api_versions: readonly [typeof TAKOSUMI_API_VERSION];
  readonly features: TakosumiWellKnownFeatures;
  readonly endpoints: TakosumiWellKnownEndpoints;
}

export interface TakosumiWellKnownFeatures {
  readonly stacks: boolean;
  readonly opentofu_runner: boolean;
  readonly oidc: boolean;
  readonly workload_identity: boolean;
  /** Takosumi-managed runtime Interface/InterfaceBinding API availability. */
  readonly interfaces: boolean;
}

export interface TakosumiWellKnownEndpoints {
  readonly api: string;
  readonly capabilities: string;
  readonly openapi: string;
  readonly oidc_issuer: string;
  /** Capability token -> public extension endpoint. */
  readonly extensions?: Readonly<Record<string, string>>;
}

export interface TakosumiProductCapabilities {
  readonly apiVersion: typeof TAKOSUMI_API_VERSION;
  readonly resources: TakosumiResourceCapabilities;
  readonly adapters: TakosumiAdapterCapabilities;
  readonly identity: TakosumiIdentityCapabilities;
  readonly operator: TakosumiOperatorCapabilities;
  /** Versioned Takosumi extensions; these are not OpenTofu standards. */
  readonly extensions: readonly string[];
}

/**
 * Open capability-token map for provider-neutral resource types. Operator-
 * defined tokens are advertised only when the corresponding provider support
 * is installed; no first-party provider is a capability authority.
 */
export type TakosumiResourceCapabilities = Readonly<Record<string, boolean>>;

/**
 * Adapter capabilities are open-ended. Operators publish only adapters that
 * are actually installed; a provider or target family is never inferred from
 * a compiled catalog.
 */
export type TakosumiAdapterCapabilities = Readonly<Record<string, boolean>>;

export interface TakosumiIdentityCapabilities {
  readonly oidc_issuer: boolean;
  readonly external_oidc_login: boolean;
  readonly workload_identity: boolean;
}

export type KnownTakosumiOperatorCapability =
  | "multi_tenant_workspaces"
  | "workspace_members"
  | "runner_pools"
  | "operator_connections"
  | "target_catalog"
  | "db_backed_configuration"
  | "cli_api_operations"
  | "usage_showback"
  | "audit_evidence";

export const TAKOSUMI_OPERATOR_CAPABILITY_KEYS: readonly KnownTakosumiOperatorCapability[] =
  [
    "multi_tenant_workspaces",
    "workspace_members",
    "runner_pools",
    "operator_connections",
    "target_catalog",
    "db_backed_configuration",
    "cli_api_operations",
    "usage_showback",
    "audit_evidence",
  ];

/** Known Operator functions plus operator-defined versioned capability tokens. */
export interface TakosumiOperatorCapabilities extends Readonly<
  Record<string, boolean>
> {
  readonly multi_tenant_workspaces: boolean;
  readonly workspace_members: boolean;
  readonly runner_pools: boolean;
  readonly operator_connections: boolean;
  readonly target_catalog: boolean;
  readonly db_backed_configuration: boolean;
  readonly cli_api_operations: boolean;
  readonly usage_showback: boolean;
  readonly audit_evidence: boolean;
}

export interface CreateTakosumiDiscoveryOptions {
  readonly origin: string;
  /** Exact public PKCE client id advertised to the standalone mobile app. */
  readonly mobileOidcClientId?: string;
  readonly resources?: Partial<TakosumiResourceCapabilities>;
  readonly adapters?: Partial<TakosumiAdapterCapabilities>;
  readonly identity?: Partial<TakosumiIdentityCapabilities>;
  readonly operator?: Partial<TakosumiOperatorCapabilities>;
  readonly endpoints?: Readonly<Record<string, string>>;
  readonly interfacesEnabled?: boolean;
  /** Open, versioned product/extension capability tokens. */
  readonly extensions?: readonly string[];
}

export function createTakosumiWellKnownDocument(
  options: CreateTakosumiDiscoveryOptions,
): TakosumiWellKnownDocument {
  const capabilities = createTakosumiProductCapabilities(options);
  const origin = trimTrailingSlash(options.origin);
  const mobileOidcClientId = normalizeMobileOidcClientId(
    options.mobileOidcClientId,
  );
  return {
    product: "takosumi",
    name: "Takosumi",
    ...(mobileOidcClientId ? { oidcClientId: mobileOidcClientId } : {}),
    auth: { oidc: true, password: false },
    apiBaseUrl: `${origin}/api/v1`,
    api_versions: [TAKOSUMI_API_VERSION],
    features: {
      stacks: capabilities.resources.Stack,
      opentofu_runner: capabilities.adapters.opentofu,
      oidc: capabilities.identity.oidc_issuer,
      workload_identity: capabilities.identity.workload_identity,
      interfaces: options.interfacesEnabled ?? false,
    },
    endpoints: {
      api: `${origin}/api/v1`,
      capabilities: `${origin}/api/v1/capabilities`,
      openapi: `${origin}/openapi.json`,
      oidc_issuer: origin,
      ...(options.endpoints && Object.keys(options.endpoints).length > 0
        ? { extensions: { ...options.endpoints } }
        : {}),
    },
  };
}

function normalizeMobileOidcClientId(
  value: string | undefined,
): string | undefined {
  const clientId = value?.trim();
  if (!clientId) return undefined;
  if (clientId.length > 256 || /[\u0000-\u001f\u007f]/u.test(clientId)) {
    throw new TypeError(
      "mobileOidcClientId must be a bounded printable string",
    );
  }
  return clientId;
}

export function createTakosumiProductCapabilities(
  options: Partial<CreateTakosumiDiscoveryOptions> = {},
): TakosumiProductCapabilities {
  const operator: TakosumiOperatorCapabilities = {
    multi_tenant_workspaces: false,
    workspace_members: false,
    runner_pools: false,
    operator_connections: false,
    target_catalog: false,
    db_backed_configuration: false,
    cli_api_operations: false,
    // OSS showback is an operator capability, not evidence that commercial
    // billing or payment enforcement is mounted. Callers opt into it through
    // `operator.usage_showback` independently.
    usage_showback: false,
    audit_evidence: false,
    ...(options.operator ?? {}),
  };
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    resources: mergeResourceCapabilities(options.resources),
    adapters: {
      opentofu: true,
      ...(options.adapters ?? {}),
    },
    identity: {
      oidc_issuer: true,
      external_oidc_login: false,
      workload_identity: false,
      ...(options.identity ?? {}),
    },
    operator,
    extensions: Object.freeze([
      ...new Set([
        ...(options.extensions ?? []).filter(
          (token) => token.trim().length > 0,
        ),
        ...(options.interfacesEnabled ? [TAKOSUMI_INTERFACES_CAPABILITY] : []),
      ]),
    ]),
  };
}

function mergeResourceCapabilities(
  resources: Partial<TakosumiResourceCapabilities> | undefined,
): TakosumiResourceCapabilities {
  const compatibility = {
    Stack: resources?.Stack ?? true,
    EdgeWorker: resources?.EdgeWorker ?? false,
    ObjectBucket: resources?.ObjectBucket ?? false,
    KVStore: resources?.KVStore ?? false,
    Queue: resources?.Queue ?? false,
    SQLDatabase: resources?.SQLDatabase ?? false,
    ContainerService: resources?.ContainerService ?? false,
    VectorIndex: resources?.VectorIndex ?? false,
    DurableWorkflow: resources?.DurableWorkflow ?? false,
    StatefulActorNamespace: resources?.StatefulActorNamespace ?? false,
    Schedule: resources?.Schedule ?? false,
    ...(resources ?? {}),
  };
  return compatibility;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}
