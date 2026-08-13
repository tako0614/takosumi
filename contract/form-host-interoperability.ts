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
export const TAKOFORM_FORM_HOST_FORM_DEFINITIONS_PATH =
  `${TAKOFORM_FORM_HOST_API_PATH}/form-definitions` as const;
export const TAKOFORM_INTERFACE_DECLARATIONS_FEATURE =
  "interface_declarations" as const;
export const TAKOFORM_INTERFACE_DECLARATION_WRITES_FEATURE =
  "interface_declaration_writes" as const;
export const TAKOFORM_RESOURCE_FORM_TRANSITION_FEATURE =
  "resource_form_transition" as const;
export const TAKOFORM_RESOURCE_FORM_TRANSITION_EVIDENCE_FORMAT =
  "takoform.module-form-transition@v1" as const;
export const TAKOFORM_RESOURCE_FORM_TRANSITION_OPERATION_FORMAT =
  "takoform.resource-form-transition-operation@v1" as const;
export const TAKOFORM_RESOURCE_FORM_TRANSITION_REQUEST_FORMAT =
  "takoform.resource-form-transition-request@v1" as const;

export interface TakoformHostDiscovery {
  readonly api_versions: readonly [typeof TAKOFORM_FORM_HOST_API_VERSION];
  readonly features: {
    readonly service_forms: true;
    readonly exact_form_ref: true;
    readonly optimistic_concurrency: true;
    readonly idempotent_lifecycle: true;
    readonly interface_declarations?: true;
    readonly interface_declaration_writes?: true;
    /** Separate, explicitly composed exact-identity transition operation. */
    readonly resource_form_transition?: true;
  };
  readonly endpoints: {
    readonly api: string;
    readonly forms: string;
    readonly interfaces?: string;
    readonly oidc_issuer?: string;
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

/** Non-secret adapter identity used to prove a transition retained its object. */
export interface TakoformNativeIdentity {
  readonly type: string;
  readonly id: string;
}

/** Product/module declaration bound to one exact old/new FormRef pair. */
export interface TakoformResourceFormTransitionEvidence {
  readonly format: typeof TAKOFORM_RESOURCE_FORM_TRANSITION_EVIDENCE_FORMAT;
  readonly marker: string;
  /** RFC 8785 SHA-256 over `{format,marker,fromForm,toForm}`. */
  readonly digest: `sha256:${string}`;
}

/**
 * Narrow v1alpha1 request for changing only a canonical Resource Form identity.
 * Owner, ResolutionLock, revision id, and native evidence are host authority
 * and therefore deliberately absent from this caller-authored envelope.
 */
export interface TakoformResourceFormTransitionRequest {
  readonly operationId: string;
  readonly fromForm: TakoformFormReference;
  readonly toForm: TakoformFormReference;
  /** Desired to-Form Resource applied by the host in the same transition. */
  readonly resource: TakoformResource & {
    readonly metadata: TakoformResource["metadata"] & {
      /** Same exact current generation N as `expected.resourceVersion`. */
      readonly resourceVersion: string;
    };
  };
  readonly expected: {
    /** Exact current generation N; a committed transition returns N + 1. */
    readonly resourceVersion: string;
    readonly nativeIdentity?: TakoformNativeIdentity;
  };
  readonly transitionEvidence: TakoformResourceFormTransitionEvidence;
}

export interface TakoformResourceFormTransitionProof {
  readonly operationId: string;
  readonly fromForm: TakoformFormReference;
  readonly toForm: TakoformFormReference;
  readonly transitionEvidenceDigest: `sha256:${string}`;
  /** RFC 8785 SHA-256 of the desired `resource.spec` observed by the host. */
  readonly observedSpecDigest: `sha256:${string}`;
  readonly resourceVersion: string;
  readonly nativeIdentity: TakoformNativeIdentity;
  readonly committed: true;
}

export type TakoformResourceFormTransitionOperationStatus =
  | "prepared"
  | "indeterminate"
  | "committed";

interface TakoformResourceFormTransitionOperationBase {
  readonly operationId: string;
  readonly requestDigest: `sha256:${string}`;
  readonly reconcilePath: string;
}

/** Closed public projection: unresolved states always expose the dispatch fence. */
export type TakoformResourceFormTransitionResponse =
  | {
      readonly operation: TakoformResourceFormTransitionOperationBase & {
        readonly status: "prepared";
        /** False is the sole same-operation POST resume grant. */
        readonly dispatchAttempted: false;
      };
      readonly resource?: never;
      readonly transitionProof?: never;
    }
  | {
      readonly operation: TakoformResourceFormTransitionOperationBase & {
        readonly status: "indeterminate";
        readonly dispatchAttempted: true;
      };
      readonly resource?: never;
      readonly transitionProof?: never;
    }
  | {
      readonly operation: TakoformResourceFormTransitionOperationBase & {
        readonly status: "committed";
      };
      readonly resource: TakoformResource;
      readonly transitionProof: TakoformResourceFormTransitionProof;
    };

/** Principal-readable projection of one verified exact Form Definition. */
export interface TakoformFormDefinition {
  readonly identity: TakoformFormReference;
  readonly displayName?: string;
  readonly description?: string;
  readonly desiredSchema: JsonObject;
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
    readonly resourceVersion?: string;
  };
  readonly spec: JsonObject;
  readonly status?: TakoformResourceStatus;
}

export interface TakoformResourceStatus {
  readonly observed: JsonObject;
  readonly output: JsonObject;
}

export interface TakoformPreviewResponse {
  readonly resource?: TakoformResource;
  readonly review: {
    readonly planDigest: string;
    readonly specDigest: string;
  };
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
}

export interface TakoformRefreshResponse {
  readonly resource: TakoformResource;
}

export interface TakoformImportResponse {
  readonly resource: TakoformResource;
}

export interface ListTakoformAvailabilityResponse {
  readonly forms: readonly FormAvailability[];
  readonly nextCursor?: string;
}

export interface ListTakoformResourcesResponse {
  readonly resources: readonly TakoformResource[];
  readonly nextCursor?: string;
}

export const TAKOFORM_HOST_ERROR_HTTP_STATUS = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  form_unknown: 404,
  form_not_installed: 409,
  form_unavailable: 503,
  form_identity_conflict: 409,
  resource_not_found: 404,
  resource_version_conflict: 412,
  resource_busy: 409,
  import_conflict: 409,
  policy_denied: 403,
  backend_unavailable: 503,
  interface_identity_ambiguous: 409,
  interface_instance_ambiguous: 409,
  internal_error: 500,
} as const;

export type TakoformHostErrorCode =
  keyof typeof TAKOFORM_HOST_ERROR_HTTP_STATUS;

export interface TakoformHostErrorEnvelope {
  readonly error: {
    readonly code: TakoformHostErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
    readonly hostCode?: string;
    readonly details?: unknown;
  };
}

export function createTakoformHostDiscovery(
  origin: string,
  options: {
    readonly interfaceDeclarations?: boolean;
    readonly interfaceDeclarationWrites?: boolean;
    readonly resourceFormTransition?: boolean;
  } = {},
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
      ...(options.interfaceDeclarationWrites
        ? { interface_declaration_writes: true as const }
        : {}),
      ...(options.resourceFormTransition
        ? { resource_form_transition: true as const }
        : {}),
    },
    endpoints: {
      api,
      forms: `${api}/forms`,
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
