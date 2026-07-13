import { TAKOSUMI_OUTPUT_SYNC_CAPABILITY } from "./output-sync.ts";

export const TAKOSUMI_API_VERSION = "takosumi.dev/v1alpha1" as const;

export type TakosumiEdition = "core" | "operator" | "cloud";

export interface TakosumiWellKnownDocument {
  readonly api_versions: readonly [typeof TAKOSUMI_API_VERSION];
  /** @deprecated Clients must branch on `features` and `/v1/capabilities`, not edition names. */
  readonly edition?: TakosumiEdition;
  readonly features: TakosumiWellKnownFeatures;
  readonly endpoints: TakosumiWellKnownEndpoints;
}

export interface TakosumiWellKnownFeatures {
  readonly stacks: boolean;
  readonly resource_shapes: boolean;
  readonly opentofu_runner: boolean;
  readonly oidc: boolean;
  readonly workload_identity: boolean;
  readonly billing: boolean;
  readonly operator_tenants: boolean;
  readonly compat_framework: boolean;
  readonly compat_s3: boolean;
  readonly compat_oci: boolean;
  readonly compat_cloudevents: boolean;
  readonly compat_provider_cloudflare_workers: boolean;
  /** Takosumi-specific Workspace Output Sync extension availability. */
  readonly output_sync: boolean;
}

export interface TakosumiWellKnownEndpoints {
  readonly api: string;
  readonly capabilities: string;
  readonly oidc_issuer: string;
  readonly s3?: string;
  readonly oci?: string;
}

export interface TakosumiProductCapabilities {
  readonly apiVersion: typeof TAKOSUMI_API_VERSION;
  readonly resources: TakosumiResourceCapabilities;
  readonly adapters: TakosumiAdapterCapabilities;
  readonly compat: TakosumiCompatCapabilities;
  readonly identity: TakosumiIdentityCapabilities;
  readonly operator: TakosumiOperatorCapabilities;
  readonly commercial: TakosumiCommercialCapabilities;
  /** Versioned Takosumi extensions; these are not OpenTofu standards. */
  readonly extensions: readonly string[];
}

export interface TakosumiResourceCapabilities {
  readonly Stack: boolean;
  readonly EdgeWorker: boolean;
  readonly ObjectBucket: boolean;
  readonly KVStore: boolean;
  readonly Queue: boolean;
  readonly SQLDatabase: boolean;
  readonly ContainerService: boolean;
}

export type KnownTakosumiAdapterCapability =
  "opentofu" | "aws" | "cloudflare" | "kubernetes" | "vm" | "takosumi_native";

export const TAKOSUMI_ADAPTER_CAPABILITY_KEYS: readonly KnownTakosumiAdapterCapability[] =
  ["opentofu", "aws", "cloudflare", "kubernetes", "vm", "takosumi_native"];

/**
 * Adapter capabilities are open-ended. Known keys describe built-in adapter
 * families; operators may publish additional plugin-backed adapter tokens.
 */
export interface TakosumiAdapterCapabilities extends Readonly<
  Record<string, boolean>
> {
  readonly opentofu: boolean;
  readonly aws: boolean;
  readonly cloudflare: boolean;
  readonly kubernetes: boolean;
  readonly vm: boolean;
  readonly takosumi_native: boolean;
}

export interface TakosumiCompatCapabilities {
  readonly framework: boolean;
  readonly s3: boolean;
  readonly oci: boolean;
  readonly cloudevents: boolean;
  readonly provider_cloudflare_workers: boolean;
}

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
  | "managed_target_catalog"
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
    "managed_target_catalog",
    "db_backed_configuration",
    "cli_api_operations",
    "usage_showback",
    "audit_evidence",
  ];

export interface TakosumiOperatorCapabilities {
  readonly multi_tenant_workspaces: boolean;
  readonly workspace_members: boolean;
  readonly runner_pools: boolean;
  readonly operator_connections: boolean;
  readonly managed_target_catalog: boolean;
  readonly db_backed_configuration: boolean;
  readonly cli_api_operations: boolean;
  readonly usage_showback: boolean;
  readonly audit_evidence: boolean;
}

export interface TakosumiCommercialCapabilities {
  readonly billing: boolean;
  readonly operator_tenants: boolean;
  readonly payment_enforcement: boolean;
}

export interface CreateTakosumiDiscoveryOptions {
  readonly origin: string;
  /** @deprecated Discovery output is capability-driven; edition is ignored. */
  readonly edition?: TakosumiEdition;
  readonly resources?: Partial<TakosumiResourceCapabilities>;
  readonly adapters?: Partial<TakosumiAdapterCapabilities>;
  readonly identity?: Partial<TakosumiIdentityCapabilities>;
  readonly operator?: Partial<TakosumiOperatorCapabilities>;
  readonly operatorTenants?: boolean;
  readonly commercialBilling?: boolean;
  readonly paymentEnforcement?: boolean;
  readonly compat?: Partial<TakosumiCompatCapabilities>;
  readonly endpoints?: Partial<Pick<TakosumiWellKnownEndpoints, "s3" | "oci">>;
  readonly resourceShapesEnabled?: boolean;
}

export function createTakosumiWellKnownDocument(
  options: CreateTakosumiDiscoveryOptions,
): TakosumiWellKnownDocument {
  const capabilities = createTakosumiProductCapabilities(options);
  return {
    api_versions: [TAKOSUMI_API_VERSION],
    features: {
      stacks: capabilities.resources.Stack,
      resource_shapes:
        options.resourceShapesEnabled ??
        resourceShapeApiEnabled(capabilities.resources),
      opentofu_runner: capabilities.adapters.opentofu,
      oidc: capabilities.identity.oidc_issuer,
      workload_identity: capabilities.identity.workload_identity,
      billing: capabilities.commercial.billing,
      operator_tenants: capabilities.commercial.operator_tenants,
      compat_framework: capabilities.compat.framework,
      compat_s3: capabilities.compat.s3,
      compat_oci: capabilities.compat.oci,
      compat_cloudevents: capabilities.compat.cloudevents,
      compat_provider_cloudflare_workers:
        capabilities.compat.provider_cloudflare_workers,
      output_sync: true,
    },
    endpoints: {
      api: `${trimTrailingSlash(options.origin)}/api`,
      capabilities: `${trimTrailingSlash(options.origin)}/v1/capabilities`,
      oidc_issuer: trimTrailingSlash(options.origin),
      ...(options.endpoints?.s3 ? { s3: options.endpoints.s3 } : {}),
      ...(options.endpoints?.oci ? { oci: options.endpoints.oci } : {}),
    },
  };
}

export function createTakosumiProductCapabilities(
  options: Partial<CreateTakosumiDiscoveryOptions> = {},
): TakosumiProductCapabilities {
  const compat: TakosumiCompatCapabilities = {
    framework: true,
    s3: false,
    oci: false,
    cloudevents: false,
    provider_cloudflare_workers: false,
    ...(options.compat ?? {}),
  };
  const operator: TakosumiOperatorCapabilities = {
    multi_tenant_workspaces: options.operatorTenants ?? false,
    workspace_members: options.operatorTenants ?? false,
    runner_pools: false,
    operator_connections: false,
    managed_target_catalog: false,
    db_backed_configuration: false,
    cli_api_operations: false,
    usage_showback: options.commercialBilling ?? false,
    audit_evidence: false,
    ...(options.operator ?? {}),
  };
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    resources: mergeResourceCapabilities(options.resources),
    adapters: {
      opentofu: true,
      aws: false,
      cloudflare: false,
      kubernetes: false,
      vm: false,
      takosumi_native: false,
      ...(options.adapters ?? {}),
    },
    compat,
    identity: {
      oidc_issuer: true,
      external_oidc_login: true,
      workload_identity: false,
      ...(options.identity ?? {}),
    },
    operator,
    commercial: {
      billing: options.commercialBilling ?? false,
      operator_tenants:
        options.operatorTenants ?? operator.multi_tenant_workspaces,
      payment_enforcement: options.paymentEnforcement ?? false,
    },
    extensions: [TAKOSUMI_OUTPUT_SYNC_CAPABILITY],
  };
}

function mergeResourceCapabilities(
  resources: Partial<TakosumiResourceCapabilities> | undefined,
): TakosumiResourceCapabilities {
  return {
    Stack: resources?.Stack ?? true,
    EdgeWorker: resources?.EdgeWorker ?? false,
    ObjectBucket: resources?.ObjectBucket ?? false,
    KVStore: resources?.KVStore ?? false,
    Queue: resources?.Queue ?? false,
    SQLDatabase: resources?.SQLDatabase ?? false,
    ContainerService: resources?.ContainerService ?? false,
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function resourceShapeApiEnabled(
  resources: TakosumiResourceCapabilities,
): boolean {
  return Object.entries(resources).some(
    ([key, enabled]) => key !== "Stack" && enabled,
  );
}
