import type {
  FormAvailability,
  InstalledFormReference,
} from "./service-forms.ts";
import type { JsonObject } from "./types.ts";

/** Portable protocol token and route namespace owned by Takoform. */
export const TAKOFORM_FORM_HOST_PROTOCOL = "v0" as const;
export const TAKOFORM_COMPAT_PROFILE = "compat.takoform.v1" as const;
export const TAKOFORM_FORM_HOST_WELL_KNOWN_PATH =
  "/.well-known/takoform" as const;
export const TAKOFORM_FORM_HOST_API_PATH = "/takoform/v0" as const;
export const TAKOFORM_FORM_HOST_INTERFACES_PATH =
  `${TAKOFORM_FORM_HOST_API_PATH}/interfaces` as const;
export const TAKOFORM_INTERFACE_DECLARATIONS_FEATURE =
  "interface_declarations" as const;

export interface TakoformHostDiscovery {
  readonly protocols: readonly [typeof TAKOFORM_FORM_HOST_PROTOCOL];
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
    readonly capabilities: string;
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

/**
 * Flat takoform v0 projection of one host-owned canonical Resource. Takosumi
 * translates this protocol onto the canonical Resource service and owns no
 * second lifecycle ledger.
 */
export interface TakoformResource {
  readonly type: string;
  readonly form: InstalledFormReference;
  readonly workspace: string;
  readonly name: string;
  readonly project?: string;
  readonly environment?: string;
  readonly serial?: string;
  readonly config: JsonObject;
  readonly attributes?: TakoformResourceAttributes;
  readonly id?: string;
}

export interface TakoformResourceAttributes {
  readonly portability?: string;
  readonly outputs?: JsonObject;
}

export interface TakoformPreviewResponse {
  readonly resource?: TakoformResource;
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
  | "serial_conflict"
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
    protocols: [TAKOFORM_FORM_HOST_PROTOCOL],
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

export const SHAPE_KIND_BY_PORTABLE_TYPE: Readonly<Record<string, string>> = {
  edge_worker: "EdgeWorker",
  object_bucket: "ObjectBucket",
  kv_store: "KVStore",
  queue: "Queue",
  sql_database: "SQLDatabase",
  container_service: "ContainerService",
  vector_index: "VectorIndex",
  durable_workflow: "DurableWorkflow",
  stateful_actor_namespace: "StatefulActorNamespace",
  schedule: "Schedule",
};

export const PORTABLE_TYPE_BY_SHAPE_KIND: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(SHAPE_KIND_BY_PORTABLE_TYPE).map(([type, kind]) => [
      kind,
      type,
    ]),
  );

export function shapeKindForPortableType(type: string): string | undefined {
  return SHAPE_KIND_BY_PORTABLE_TYPE[type];
}

export function portableTypeForShapeKind(kind: string): string | undefined {
  return PORTABLE_TYPE_BY_SHAPE_KIND[kind];
}
