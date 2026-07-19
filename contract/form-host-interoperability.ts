import type {
  FormAvailability,
  InstalledFormReference,
} from "./service-forms.ts";
import type { ResourcePhase, ResourcePortability } from "./resource-shape.ts";
import type { Condition, JsonObject } from "./types.ts";

/** Portable identity and route namespace owned by the Takoform protocol. */
export const TAKOFORM_FORM_HOST_API_VERSION =
  "forms.takoform.com/v1alpha1" as const;
export const TAKOFORM_FORM_HOST_WELL_KNOWN_PATH =
  "/.well-known/takoform" as const;
export const TAKOFORM_FORM_HOST_API_PATH =
  "/apis/forms.takoform.com/v1alpha1" as const;
export const TAKOFORM_FORM_HOST_INTERFACES_PATH =
  `${TAKOFORM_FORM_HOST_API_PATH}/interfaces` as const;
export const TAKOFORM_INTERFACE_DECLARATIONS_FEATURE =
  "interface_declarations" as const;

/**
 * Neutral discovery document. Takosumi implements this document but does not
 * own the protocol identity or infer availability from a static schema.
 */
export interface TakoformHostDiscovery {
  readonly api_versions: readonly [typeof TAKOFORM_FORM_HOST_API_VERSION];
  readonly features: {
    readonly service_forms: true;
    readonly exact_form_ref: true;
    readonly optimistic_concurrency: true;
    readonly idempotent_lifecycle: true;
    readonly interface_declarations?: true;
  };
  readonly endpoints: {
    readonly api: string;
    readonly forms: string;
    /** Compatibility discovery consumed by the current provider candidate. */
    readonly capabilities: string;
    /** Existing pre-standard Resource facade retained during provider migration. */
    readonly compatibility_api: string;
    readonly interfaces?: string;
  };
}

/** One portable runtime declaration instance. It grants no authorization. */
export interface TakoformDeclaredInterface {
  readonly name: string;
  readonly version: string;
  readonly resource: {
    readonly kind: string;
    readonly name: string;
  };
  readonly document?: JsonObject;
  readonly values?: JsonObject;
  readonly form?: InstalledFormReference;
}

export interface ListTakoformDeclaredInterfacesResponse {
  readonly interfaces: readonly TakoformDeclaredInterface[];
}

export interface TakoformResourceMetadata {
  readonly name: string;
  readonly space: string;
  readonly project?: string;
  readonly environment?: string;
  readonly labels?: Readonly<Record<string, string>>;
  /** Decimal canonical desired generation returned by the host. */
  readonly resourceVersion?: string;
}

export interface TakoformResourceStatus {
  readonly phase: ResourcePhase;
  readonly observedGeneration: number;
  readonly portability?: ResourcePortability;
  readonly outputs?: JsonObject;
  readonly conditions?: readonly Condition[];
}

/**
 * Provider-neutral projection of one host-owned canonical Resource. It carries
 * exact definition identity and sanitized lifecycle state, never Target,
 * manager, credential, capacity, price, SKU, quota, or SLA authority.
 */
export interface TakoformResource {
  readonly apiVersion: typeof TAKOFORM_FORM_HOST_API_VERSION;
  readonly kind: string;
  readonly form: InstalledFormReference;
  readonly metadata: TakoformResourceMetadata;
  readonly spec: JsonObject;
  readonly status?: TakoformResourceStatus;
  readonly id?: string;
}

export interface TakoformPreviewResponse {
  readonly resource: TakoformResource;
  readonly review: {
    readonly planDigest: string;
    readonly specDigest: string;
  };
  readonly summary: string;
}

export interface TakoformApplyRequest extends TakoformResource {
  readonly review: {
    readonly planDigest: string;
  };
}

export interface TakoformImportRequest extends TakoformResource {
  readonly nativeId: string;
}

export interface TakoformObserveResponse {
  readonly resource: TakoformResource;
  readonly observation: {
    readonly status: "current" | "drifted" | "missing";
    readonly summary: string;
    readonly runId?: string;
  };
}

export interface TakoformRefreshResponse {
  readonly resource: TakoformResource;
  readonly refresh: {
    readonly summary: string;
    readonly runId?: string;
  };
}

export interface TakoformImportResponse {
  readonly resource: TakoformResource;
  readonly import: {
    readonly summary: string;
    readonly runId?: string;
  };
}

export interface ListTakoformAvailabilityResponse {
  readonly forms: readonly FormAvailability[];
  readonly nextCursor?: string;
}

export interface ListTakoformResourcesResponse {
  readonly resources: readonly TakoformResource[];
  readonly nextCursor?: string;
}

/** Stable provider-facing error taxonomy. */
export type TakoformHostErrorCode =
  | "invalid_argument"
  | "unauthenticated"
  | "permission_denied"
  | "form_unknown"
  | "form_not_installed"
  | "form_unavailable"
  | "form_identity_conflict"
  | "resource_not_found"
  | "interface_identity_ambiguous"
  | "interface_instance_ambiguous"
  | "resource_version_conflict"
  | "resource_busy"
  | "import_conflict"
  | "policy_denied"
  | "backend_unavailable"
  | "internal_error";

export interface TakoformHostErrorEnvelope {
  readonly error: {
    readonly code: TakoformHostErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
    readonly hostCode?: string;
  };
}

export function createTakoformHostDiscovery(
  origin: string,
  options: { readonly interfaceDeclarations?: boolean } = {},
): TakoformHostDiscovery {
  const normalized = origin.replace(/\/+$/u, "");
  const api = `${normalized}${TAKOFORM_FORM_HOST_API_PATH}`;
  return {
    api_versions: [TAKOFORM_FORM_HOST_API_VERSION],
    features: {
      service_forms: true,
      exact_form_ref: true,
      optimistic_concurrency: true,
      idempotent_lifecycle: true,
      ...(options.interfaceDeclarations
        ? { interface_declarations: true as const }
        : {}),
    },
    endpoints: {
      api,
      forms: `${api}/forms`,
      capabilities: `${normalized}/v1/capabilities`,
      compatibility_api: `${normalized}/v1`,
      ...(options.interfaceDeclarations
        ? { interfaces: `${normalized}${TAKOFORM_FORM_HOST_INTERFACES_PATH}` }
        : {}),
    },
  };
}
