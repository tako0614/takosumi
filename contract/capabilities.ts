import type { FormAvailability } from "./service-forms.ts";

export const TAKOSUMI_API_VERSION = "takosumi.dev/v1alpha1" as const;
export const TAKOSUMI_INTERFACES_CAPABILITY = "takosumi.interfaces.v1" as const;

export interface TakosumiWellKnownDocument {
  readonly api_versions: readonly [typeof TAKOSUMI_API_VERSION];
  readonly features: TakosumiWellKnownFeatures;
  readonly endpoints: TakosumiWellKnownEndpoints;
}

export interface TakosumiWellKnownFeatures {
  readonly stacks: boolean;
  readonly resource_shapes: boolean;
  readonly opentofu_runner: boolean;
  readonly oidc: boolean;
  readonly workload_identity: boolean;
  readonly compat_framework: boolean;
  /** Installed, versioned compatibility profile tokens. */
  readonly compatibility_profiles: readonly string[];
  /** Takosumi-managed runtime Interface/InterfaceBinding API availability. */
  readonly interfaces: boolean;
}

export interface TakosumiWellKnownEndpoints {
  readonly api: string;
  readonly capabilities: string;
  readonly oidc_issuer: string;
  /** Capability token -> public extension endpoint. */
  readonly extensions?: Readonly<Record<string, string>>;
}

export interface TakosumiProductCapabilities {
  readonly apiVersion: typeof TAKOSUMI_API_VERSION;
  readonly resources: TakosumiResourceCapabilities;
  readonly adapters: TakosumiAdapterCapabilities;
  readonly compat: TakosumiCompatCapabilities;
  /**
   * Installed compatibility profiles and the authority plane(s) each profile
   * exposes. A profile is never inferred from a route path or vendor name.
   *
   * `control` means the profile translates supported requests into the
   * canonical Resource Deploy API. `data` means it can consume an authorized,
   * Ready Resource projection. A profile that does both lists both planes.
   */
  readonly compatibilityProfiles: TakosumiCompatibilityProfileCapabilities;
  readonly identity: TakosumiIdentityCapabilities;
  readonly operator: TakosumiOperatorCapabilities;
  /**
   * Principal-scoped structured Form discovery. Records are fetched from the
   * authenticated endpoint; this public descriptor intentionally carries no
   * installed definitions, private Targets, manager ids, or commercial data.
   */
  readonly formAvailability: TakosumiFormAvailabilityCapability;
  /** Versioned Takosumi extensions; these are not OpenTofu standards. */
  readonly extensions: readonly string[];
}

export interface TakosumiFormAvailabilityCapability {
  readonly structured: true;
  readonly endpoint: "/v1/form-availability";
  readonly principalScoped: true;
  readonly readScopesAnyOf: readonly ["forms:read", "resources:read"];
  readonly commercialFields: false;
  /** Present only for the authenticated `?space=` capabilities projection. */
  readonly forms: readonly FormAvailability[];
}

/**
 * Open capability-token map. Installed Form Packages provide portable typed
 * schemas; operator-defined tokens are advertised only when their host schema
 * and adapter/plugin are installed. The discontinued Takosumi provider is not
 * a capability authority.
 */
export type TakosumiResourceCapabilities = Readonly<Record<string, boolean>>;

/**
 * Adapter capabilities are open-ended. Operators publish only adapters that
 * are actually installed; a provider or target family is never inferred from
 * a compiled catalog.
 */
export type TakosumiAdapterCapabilities = Readonly<Record<string, boolean>>;

/**
 * Compatibility-profile capability map.
 *
 * The named fields are the profiles understood by this client build. The map
 * is intentionally open so an operator can advertise a versioned profile such
 * as `compat.redis.v1` or `compat.example.events.v2` without waiting for a
 * Takosumi contract release. Unknown keys are discovery tokens only; they do
 * not make Core implement or validate the corresponding protocol.
 */
export type TakosumiCompatCapabilities = Readonly<Record<string, boolean>>;

/** Authority plane exposed by one scoped, versioned compatibility profile. */
export type TakosumiCompatibilityPlane = "control" | "data";

export interface TakosumiCompatibilityProfileCapability {
  readonly planes: readonly TakosumiCompatibilityPlane[];
}

/** Profile capability token -> explicit control/data authority declaration. */
export type TakosumiCompatibilityProfileCapabilities = Readonly<
  Record<string, TakosumiCompatibilityProfileCapability>
>;

/** Runtime guard for an explicitly scoped and versioned compatibility token. */
export function isTakosumiCompatibilityProfileToken(
  value: unknown,
): value is `compat.${string}` {
  return (
    typeof value === "string" &&
    /^compat\.[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*\.v[1-9][0-9]*(?:(?:alpha|beta)[1-9][0-9]*)?$/u.test(
      value,
    )
  );
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

/** Known Operator functions plus operator-defined versioned capability tokens. */
export interface TakosumiOperatorCapabilities extends Readonly<
  Record<string, boolean>
> {
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

export interface CreateTakosumiDiscoveryOptions {
  readonly origin: string;
  readonly resources?: Partial<TakosumiResourceCapabilities>;
  readonly adapters?: Partial<TakosumiAdapterCapabilities>;
  readonly identity?: Partial<TakosumiIdentityCapabilities>;
  readonly operator?: Partial<TakosumiOperatorCapabilities>;
  readonly compat?: Partial<TakosumiCompatCapabilities>;
  readonly compatibilityProfiles?: Partial<TakosumiCompatibilityProfileCapabilities>;
  readonly endpoints?: Readonly<Record<string, string>>;
  readonly resourceShapesEnabled?: boolean;
  readonly interfacesEnabled?: boolean;
  /** Principal-scoped structured truth used to derive legacy booleans. */
  readonly formAvailability?: readonly FormAvailability[];
  /** Open, versioned product/extension capability tokens. */
  readonly extensions?: readonly string[];
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
      compat_framework: capabilities.compat.framework,
      compatibility_profiles: Object.keys(
        capabilities.compatibilityProfiles,
      ).sort(),
      interfaces: options.interfacesEnabled ?? false,
    },
    endpoints: {
      api: `${trimTrailingSlash(options.origin)}/api`,
      capabilities: `${trimTrailingSlash(options.origin)}/v1/capabilities`,
      oidc_issuer: trimTrailingSlash(options.origin),
      ...(options.endpoints && Object.keys(options.endpoints).length > 0
        ? { extensions: { ...options.endpoints } }
        : {}),
    },
  };
}

export function createTakosumiProductCapabilities(
  options: Partial<CreateTakosumiDiscoveryOptions> = {},
): TakosumiProductCapabilities {
  const compatibilityProfiles = normalizeCompatibilityProfiles(
    options.compatibilityProfiles,
  );
  const compat: TakosumiCompatCapabilities = {
    framework: true,
    ...(options.compat ?? {}),
    ...Object.fromEntries(
      Object.keys(compatibilityProfiles).map((token) => [token, true]),
    ),
  };
  const operator: TakosumiOperatorCapabilities = {
    multi_tenant_workspaces: false,
    workspace_members: false,
    runner_pools: false,
    operator_connections: false,
    managed_target_catalog: false,
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
    resources: mergeResourceCapabilities(
      options.resources,
      options.formAvailability,
    ),
    adapters: {
      opentofu: true,
      ...(options.adapters ?? {}),
    },
    compat,
    compatibilityProfiles,
    identity: {
      oidc_issuer: true,
      external_oidc_login: false,
      workload_identity: false,
      ...(options.identity ?? {}),
    },
    operator,
    formAvailability: {
      structured: true,
      endpoint: "/v1/form-availability",
      principalScoped: true,
      readScopesAnyOf: ["forms:read", "resources:read"],
      commercialFields: false,
      forms: options.formAvailability ?? [],
    },
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

function normalizeCompatibilityProfiles(
  profiles: Partial<TakosumiCompatibilityProfileCapabilities> | undefined,
): TakosumiCompatibilityProfileCapabilities {
  const normalized: Record<string, TakosumiCompatibilityProfileCapability> = {};
  for (const [token, capability] of Object.entries(profiles ?? {})) {
    if (!capability) continue;
    if (!isTakosumiCompatibilityProfileToken(token)) {
      throw new TypeError(
        `compatibility profile token must be a scoped compat.* version token: ${token}`,
      );
    }
    const planes = [...new Set(capability.planes)].sort();
    if (
      planes.length === 0 ||
      planes.some((plane) => plane !== "control" && plane !== "data")
    ) {
      throw new TypeError(
        `compatibility profile ${token} must declare control or data`,
      );
    }
    normalized[token] = {
      planes: Object.freeze(planes),
    };
  }
  return Object.freeze(normalized);
}

function mergeResourceCapabilities(
  resources: Partial<TakosumiResourceCapabilities> | undefined,
  formAvailability: readonly FormAvailability[] | undefined,
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
  if (formAvailability === undefined) return compatibility;
  const derived = Object.fromEntries(
    Object.keys(compatibility)
      .filter((kind) => kind !== "Stack")
      .map((kind) => [
        kind,
        formAvailability.some(
          (form) =>
            form.identity.formRef.kind === kind && form.availableToPrincipal,
        ),
      ]),
  );
  return { ...compatibility, ...derived };
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
