import type {
  FormInterfaceInputDeclaration,
  FormAvailability,
  InstalledFormReference,
} from "./service-forms.ts";
import type { JsonObject } from "./types.ts";

/** Portable protocol token and route namespace owned by Takoform. */
export const TAKOFORM_FORM_HOST_PROTOCOL =
  "takoform.host-api@v1alpha1" as const;
export const TAKOFORM_FORM_HOST_API_VERSION =
  "forms.takoform.com/v1alpha1" as const;
export const TAKOFORM_COMPAT_PROFILE = "compat.takoform.v1" as const;
export const TAKOFORM_FORM_HOST_WELL_KNOWN_PATH =
  "/.well-known/takoform" as const;
export const TAKOFORM_FORM_HOST_API_PATH =
  "/apis/forms.takoform.com/v1alpha1" as const;
export const TAKOFORM_FORM_HOST_INTERFACES_PATH =
  `${TAKOFORM_FORM_HOST_API_PATH}/interfaces` as const;
export const TAKOFORM_INTERFACE_DECLARATIONS_FEATURE =
  "interface_declarations" as const;
export const TAKOFORM_INTERFACE_DECLARATION_WRITES_FEATURE =
  "interface_declaration_writes" as const;

export interface TakoformHostDiscovery {
  readonly protocols: readonly [typeof TAKOFORM_FORM_HOST_PROTOCOL];
  readonly api_versions: readonly [typeof TAKOFORM_FORM_HOST_API_VERSION];
  readonly features: {
    readonly service_forms: true;
    readonly exact_form_ref: true;
    readonly optimistic_concurrency: true;
    readonly idempotent_lifecycle: true;
    readonly interface_declarations?: true;
    readonly interface_declaration_writes?: true;
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
  readonly documentSchema?: JsonObject;
  readonly inputs?: readonly FormInterfaceInputDeclaration[];
  readonly resourceUriInput?: string;
  readonly values?: JsonObject;
  readonly resourceUri?: string;
  readonly resourceVersion?: string;
  readonly form?: InstalledFormReference;
}

export interface ListTakoformDeclaredInterfacesResponse {
  readonly interfaces: readonly TakoformDeclaredInterface[];
}

/** Takoform v1alpha1 definition identity carried inside a Resource. */
export interface TakoformFormReference {
  readonly formRef: {
    readonly apiVersion: typeof TAKOFORM_FORM_HOST_API_VERSION;
    readonly kind: string;
    readonly definitionVersion: string;
    readonly schemaDigest: string;
  };
  readonly packageDigest: string;
}

/**
 * Provider-neutral Takoform v1alpha1 projection of one host-owned canonical
 * Resource. Takosumi translates this protocol onto the canonical Resource
 * service and owns no second lifecycle ledger.
 */
export interface TakoformResource {
  readonly apiVersion: typeof TAKOFORM_FORM_HOST_API_VERSION;
  readonly kind: string;
  readonly form: TakoformFormReference;
  readonly metadata: {
    readonly name: string;
    readonly space: string;
    readonly project?: string;
    readonly environment?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly resourceVersion?: string;
  };
  readonly spec: JsonObject;
  readonly status?: TakoformResourceStatus;
  readonly id?: string;
}

export interface TakoformResourceStatus {
  readonly phase?: string;
  readonly observedGeneration?: number;
  readonly portability?: string;
  readonly outputs?: JsonObject;
  readonly resolution?: {
    readonly selectedImplementation?: string;
    readonly target?: string;
    readonly locked?: boolean;
    readonly portability?: string;
  };
  readonly conditions?: readonly {
    readonly type: string;
    readonly status: string;
    readonly reason?: string;
    readonly message?: string;
  }[];
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
  | "backend_unavailable"
  | "conflict"
  | "forbidden"
  | "interface_identity_ambiguous"
  | "interface_instance_ambiguous"
  | "invalid_argument"
  | "not_implemented"
  | "resource_not_found"
  | "resource_busy"
  | "unauthorized";

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
  options: {
    readonly interfaceDeclarations?: boolean;
    readonly interfaceDeclarationWrites?: boolean;
  } = {},
): TakoformHostDiscovery {
  const normalized = origin.replace(/\/+$/u, "");
  const api = `${normalized}${TAKOFORM_FORM_HOST_API_PATH}`;
  return {
    protocols: [TAKOFORM_FORM_HOST_PROTOCOL],
    api_versions: [TAKOFORM_FORM_HOST_API_VERSION],
    features: {
      service_forms: true,
      exact_form_ref: true,
      optimistic_concurrency: true,
      idempotent_lifecycle: true,
      ...(options.interfaceDeclarations
        ? { interface_declarations: true as const }
        : {}),
      ...(options.interfaceDeclarationWrites
        ? { interface_declaration_writes: true as const }
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
  const retained = SHAPE_KIND_BY_PORTABLE_TYPE[type];
  if (retained) return retained;
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(type)) return undefined;
  const kind = type
    .split("_")
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join("");
  return /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(kind) ? kind : undefined;
}

export function portableTypeForShapeKind(kind: string): string | undefined {
  const retained = PORTABLE_TYPE_BY_SHAPE_KIND[kind];
  if (retained) return retained;
  if (!/^[A-Z][A-Za-z0-9]{0,127}$/u.test(kind)) return undefined;
  const type = kind
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .toLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/u.test(type) ? type : undefined;
}
