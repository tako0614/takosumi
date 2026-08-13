import type { Context, Hono } from "hono";
import type {
  ActorContext,
  FormDefinition,
  FormAvailability,
  InstalledFormReference,
  JsonObject,
  ResourceObject,
  ResourceCapsuleOwner,
  ResourceShapeKind,
  TakoformDeclaredInterface,
  TakoformResource,
  TakoformHostErrorCode,
  TakoformNativeIdentity,
  TakoformResourceFormTransitionRequest,
} from "takosumi-contract";
import {
  createTakoformHostDiscovery,
  installedFormReferenceKey,
  isResourceCapsuleOwner,
  isInstalledFormReference,
  isResourceShapeKind,
  portableTypeForShapeKind,
  shapeKindForPortableType,
  TAKOFORM_FORM_HOST_API_VERSION,
  TAKOFORM_FORM_HOST_API_PATH,
  TAKOFORM_FORM_HOST_FORM_DEFINITIONS_PATH,
  TAKOFORM_FORM_HOST_INTERFACES_PATH,
  TAKOFORM_FORM_HOST_WELL_KNOWN_PATH,
  type TakoformFormDefinition,
  TAKOFORM_RESOURCE_FORM_TRANSITION_EVIDENCE_FORMAT,
} from "takosumi-contract";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type {
  ApplyResourceRequest,
  ResolutionLockRecord,
  ResourceServiceError,
  ResourceShapeRecord,
  ResourceShapeService,
} from "../domains/resource-shape/mod.ts";
import {
  ResourceFormTransitionError,
  type ResourceFormTransitionResult,
  type ResourceFormTransitionService,
} from "../domains/resource-shape/mod.ts";
import {
  canonicalJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from "../adapters/takoform/canonical_json.ts";
import { sha256HexAsync } from "../shared/runtime/hash.ts";
import { PortableDeclarationReadLimitError } from "../domains/interfaces/portable_declarations.ts";
import { InterfaceServiceError } from "../domains/interfaces/service.ts";
import { requestIdFromContext } from "./errors.ts";
import type { ApiEndpoint } from "./route_families.ts";
import { parsePageQuery } from "./page_query.ts";
import {
  PortableHostIdempotencyCoordinator,
  PortableHostIdempotencyError,
  type PortableHostIdempotencyRequest,
  type PortableHostIdempotencyReservation,
  type PortableHostSuccessWireResponse,
} from "./portable_host_idempotency.ts";

/** Exact first-party audience for short-lived Takoform provider run tokens. */
export const PORTABLE_FORM_MANAGER = "takoform.form-host.v1";
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/u;
const FORM_TRANSITION_OPERATION_ID_RE = /^formtx_[0-9a-f]{64}$/u;

export interface PortableFormAvailabilityReader {
  listFormAvailability(input: {
    readonly actor: ActorContext;
    readonly space: string;
    readonly identity?: InstalledFormReference;
    readonly page?: PageParams;
  }): Promise<Page<FormAvailability>>;
  /** Principal-filtered exact definition read; omission fails closed. */
  getReadableFormDefinition?(input: {
    readonly actor: ActorContext;
    readonly space: string;
    readonly identity: InstalledFormReference;
  }): Promise<FormDefinition | undefined>;
}

export interface PortableInterfaceDeclarationReader {
  listDeclaredInterfaces(input: {
    readonly actor: ActorContext;
    readonly space: string;
    readonly name?: string;
    readonly version?: string;
    readonly resourceKind?: string;
    readonly resourceName?: string;
  }): Promise<readonly TakoformDeclaredInterface[]>;
}

export interface PortableInterfaceDeclarationWriter {
  putDeclaredInterface(input: {
    readonly actor: ActorContext;
    readonly space: string;
    readonly declaration: TakoformDeclaredInterface;
    readonly expectedGeneration: number;
  }): Promise<TakoformDeclaredInterface>;
  deleteDeclaredInterface(input: {
    readonly actor: ActorContext;
    readonly space: string;
    readonly name: string;
    readonly version: string;
    readonly resourceKind: string;
    readonly resourceName: string;
    readonly expectedGeneration: number;
  }): Promise<void>;
}

export type PortableFormHostAuthResult =
  | { readonly ok: true; readonly actor: ActorContext }
  | { readonly ok: false; readonly response: Response };

export interface RegisterPortableFormHostRoutesOptions {
  readonly service: ResourceShapeService;
  readonly availability: PortableFormAvailabilityReader;
  /**
   * Host-owned durable lifecycle replay authority. Omission fails closed for
   * every idempotent portable mutation; the route never creates a local
   * fallback ledger.
   */
  readonly idempotency?: PortableHostIdempotencyCoordinator;
  /** Uses the same trusted principal resolution as the canonical Resource API. */
  readonly authorize: (c: Context) => Promise<PortableFormHostAuthResult>;
  readonly canReadForms: (actor: ActorContext) => boolean;
  readonly canWriteInterfaces?: (actor: ActorContext) => boolean;
  /**
   * Optional host-authenticated Capsule execution context. The portable body
   * cannot supply this authority; hosted compositions resolve their run-scoped
   * bearer to the exact Capsule and installing Principal here.
   */
  readonly resolveResourceCapsuleOwner?: (input: {
    readonly actor: ActorContext;
    readonly request: Request;
    readonly space: string;
    readonly kind: ResourceShapeKind;
    readonly name: string;
  }) =>
    | ResourceCapsuleOwner
    | undefined
    | Promise<ResourceCapsuleOwner | undefined>;
  readonly interfaceDeclarations?: PortableInterfaceDeclarationReader &
    Partial<PortableInterfaceDeclarationWriter>;
  /** Explicit host-composed identity transition. Omission hides the feature. */
  readonly formTransition?: ResourceFormTransitionService;
}

/** Presented host execution context was invalid and must not become unowned. */
export class ResourceCapsuleOwnerAuthorityError extends Error {
  constructor(message = "managed Resource owner authority is invalid") {
    super(message);
    this.name = "ResourceCapsuleOwnerAuthorityError";
  }
}

async function resolveHostResourceOwner(
  c: Context,
  options: RegisterPortableFormHostRoutesOptions,
  input: {
    readonly actor: ActorContext;
    readonly request: Request;
    readonly space: string;
    readonly kind: ResourceShapeKind;
    readonly name: string;
  },
): Promise<
  | { readonly ok: true; readonly owner?: ResourceCapsuleOwner }
  | { readonly ok: false; readonly response: Response }
> {
  let owner: ResourceCapsuleOwner | undefined;
  try {
    owner = await options.resolveResourceCapsuleOwner?.(input);
  } catch (error) {
    if (error instanceof ResourceCapsuleOwnerAuthorityError) {
      return {
        ok: false,
        response: portableError(
          c,
          "permission_denied",
          "managed Resource owner authority was rejected",
          403,
        ),
      };
    }
    return {
      ok: false,
      response: portableError(
        c,
        "backend_unavailable",
        "managed Resource owner authority is unavailable",
        503,
        true,
      ),
    };
  }
  if (!owner) return { ok: true };
  if (!isResourceCapsuleOwner(owner)) {
    throw new TypeError(
      "portable Resource Capsule owner resolver returned invalid authority",
    );
  }
  const capsuleId = owner.id.trim();
  const workspaceId = owner.workspaceId.trim();
  const installingPrincipalId = owner.installingPrincipalId.trim();
  if (
    !capsuleId ||
    !workspaceId ||
    !installingPrincipalId ||
    (input.actor.workspaceId !== undefined &&
      input.actor.workspaceId !== workspaceId)
  ) {
    throw new TypeError(
      "portable Resource Capsule owner resolver returned invalid authority",
    );
  }
  return {
    ok: true,
    owner: {
      kind: "Capsule",
      id: capsuleId,
      workspaceId,
      installingPrincipalId,
    },
  };
}

async function withHostResourceOwner(
  c: Context,
  options: RegisterPortableFormHostRoutesOptions,
  request: ApplyResourceRequest,
): Promise<
  | { readonly ok: true; readonly request: ApplyResourceRequest }
  | { readonly ok: false; readonly response: Response }
> {
  const resolved = await resolveHostResourceOwner(c, options, {
    actor: request.actor,
    request: c.req.raw,
    space: request.space,
    kind: request.kind,
    name: request.name,
  });
  if (!resolved.ok) return resolved;
  if (!resolved.owner) return { ok: true, request };
  return {
    ok: true,
    request: { ...request, owner: resolved.owner },
  };
}

/**
 * Portable Form host routes mounted by the Resource Shape family. They are
 * intentionally excluded from Takosumi's own OpenAPI inventory; the portable
 * contract advertises them through its well-known document. Keeping the list
 * beside the mount calls lets the edge ingress derive routing without a second
 * hand-maintained prefix list.
 */
export const PORTABLE_FORM_HOST_ENDPOINTS: readonly ApiEndpoint[] = [
  portableEndpoint("GET", TAKOFORM_FORM_HOST_WELL_KNOWN_PATH, {
    operationId: "getTakoformHostDiscovery",
    auth: "none",
  }),
  portableEndpoint("GET", TAKOFORM_FORM_HOST_INTERFACES_PATH, {
    operationId: "listTakoformDeclaredInterfaces",
  }),
  portableEndpoint("GET", `${TAKOFORM_FORM_HOST_INTERFACES_PATH}/:name`, {
    operationId: "getTakoformDeclaredInterface",
  }),
  portableEndpoint("PUT", `${TAKOFORM_FORM_HOST_INTERFACES_PATH}/:name`, {
    operationId: "putTakoformDeclaredInterface",
  }),
  portableEndpoint("DELETE", `${TAKOFORM_FORM_HOST_INTERFACES_PATH}/:name`, {
    operationId: "deleteTakoformDeclaredInterface",
  }),
  portableEndpoint("GET", `${TAKOFORM_FORM_HOST_API_PATH}/forms`, {
    operationId: "listTakoformAvailableForms",
  }),
  portableEndpoint(
    "GET",
    `${TAKOFORM_FORM_HOST_FORM_DEFINITIONS_PATH}/:kind`,
    {
      operationId: "getTakoformFormDefinition",
      query: [
        "space",
        "apiVersion",
        "kind",
        "definitionVersion",
        "schemaDigest",
        "packageDigest",
      ],
    },
  ),
  portableEndpoint("POST", `${TAKOFORM_FORM_HOST_API_PATH}/resources/preview`, {
    operationId: "previewTakoformResource",
  }),
  portableEndpoint("GET", `${TAKOFORM_FORM_HOST_API_PATH}/resources`, {
    operationId: "listTakoformResources",
  }),
  portableEndpoint(
    "PUT",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name`,
    { operationId: "putTakoformResource" },
  ),
  portableEndpoint(
    "GET",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name`,
    { operationId: "getTakoformResource" },
  ),
  portableEndpoint(
    "DELETE",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name`,
    { operationId: "deleteTakoformResource" },
  ),
  portableEndpoint(
    "POST",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name/import`,
    { operationId: "importTakoformResource" },
  ),
  portableEndpoint(
    "POST",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name/observe`,
    { operationId: "observeTakoformResource" },
  ),
  portableEndpoint(
    "POST",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name/refresh`,
    { operationId: "refreshTakoformResource" },
  ),
  portableEndpoint(
    "POST",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name/form-transitions`,
    { operationId: "transitionTakoformResourceForm", query: ["space"] },
  ),
  portableEndpoint(
    "GET",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name/form-transitions/:operationId`,
    { operationId: "getTakoformResourceFormTransition", query: ["space"] },
  ),
] as const;

function portableEndpoint(
  method: ApiEndpoint["method"],
  path: string,
  options: {
    readonly operationId: string;
    readonly auth?: ApiEndpoint["auth"];
    readonly query?: readonly string[];
  },
): ApiEndpoint {
  return {
    method,
    path,
    summary: `Portable Form host API: ${options.operationId}`,
    auth: options.auth ?? "deploy-control-token",
    operationId: options.operationId,
    discoverable: false,
    tag: "resource-shape",
    openapi: {
      okSchema: "ResourceShapeResponse",
      ...(options.query ? { query: options.query } : {}),
    },
  };
}

/**
 * Mounts the provider-neutral Form host facade. Every lifecycle call delegates
 * to ResourceShapeService; this module owns no Resource, Run, audit, or
 * idempotency ledger.
 */
export function registerPortableFormHostRoutes(
  app: Hono,
  options: RegisterPortableFormHostRoutesOptions,
): void {
  const base = TAKOFORM_FORM_HOST_API_PATH;
  const interfaceBase = TAKOFORM_FORM_HOST_INTERFACES_PATH;
  const declarations = options.interfaceDeclarations;

  app.get(TAKOFORM_FORM_HOST_WELL_KNOWN_PATH, (c) =>
    c.json(
      createTakoformHostDiscovery(new URL(c.req.url).origin, {
        interfaceDeclarations: declarations !== undefined,
        interfaceDeclarationWrites:
          declarations?.putDeclaredInterface !== undefined &&
          declarations.deleteDeclaredInterface !== undefined,
        resourceFormTransition: options.formTransition !== undefined,
      }),
      200,
    ),
  );

  if (options.formTransition) {
    registerPortableResourceFormTransitionRoutes(app, options);
  }

  if (declarations) {
    app.get(interfaceBase, async (c) => {
      const auth = await options.authorize(c);
      if (!auth.ok) return portableAuthError(c, auth.response);
      if (!options.canReadForms(auth.actor)) {
        return portableError(
          c,
          "permission_denied",
          "interface declaration read scope is required",
          403,
        );
      }
      const query = declarationQuery(c);
      if (!query.ok) return query.response;
      const listed = await readPortableDeclarations(c, declarations, {
        actor: auth.actor,
        ...query.value,
      });
      if (!listed.ok) return listed.response;
      return c.json(
        {
          interfaces: listed.value.map(portableInterfaceDeclaration),
        },
        200,
      );
    });

    app.get(`${interfaceBase}/:name`, async (c) => {
      const auth = await options.authorize(c);
      if (!auth.ok) return portableAuthError(c, auth.response);
      if (!options.canReadForms(auth.actor)) {
        return portableError(
          c,
          "permission_denied",
          "interface declaration read scope is required",
          403,
        );
      }
      const query = declarationQuery(c);
      if (!query.ok) return query.response;
      const name = c.req.param("name");
      if (!name) return failed(c, "interface name is required").response;
      const listed = await readPortableDeclarations(c, declarations, {
        actor: auth.actor,
        ...query.value,
        name,
      });
      if (!listed.ok) return listed.response;
      const matches = listed.value;
      if (matches.length === 0) {
        return portableError(
          c,
          "resource_not_found",
          "no declared interface matches that exact identity",
          404,
        );
      }
      if (matches.length !== 1) {
        const versions = new Set(matches.map((match) => match.version));
        if (query.value.version === undefined && versions.size > 1) {
          return portableError(
            c,
            "interface_identity_ambiguous",
            "interface name matches multiple visible versions; provide version",
            409,
          );
        }
        return portableError(
          c,
          "interface_instance_ambiguous",
          "declared interface identity matches multiple visible instances; provide version and Resource selector",
          409,
        );
      }
      return c.json(portableInterfaceDeclaration(matches[0]!), 200);
    });

    if (
      declarations.putDeclaredInterface &&
      declarations.deleteDeclaredInterface
    ) {
      const putDeclaredInterface = declarations.putDeclaredInterface;
      const deleteDeclaredInterface = declarations.deleteDeclaredInterface;
      app.put(`${interfaceBase}/:name`, async (c) => {
        const auth = await options.authorize(c);
        if (!auth.ok) return portableAuthError(c, auth.response);
        if (!options.canWriteInterfaces?.(auth.actor)) {
          return portableError(
            c,
            "permission_denied",
            "interface declaration write scope is required",
            403,
          );
        }
        const key = idempotencyKey(c);
        if (!key.ok) return key.response;
        const query = exactDeclarationQuery(c);
        if (!query.ok) return query.response;
        const generation = generationPrecondition(c, true);
        if (!generation.ok) return generation.response;
        const body = await readPortableJsonObject(c);
        if (!body.ok) return body.response;
        const parsed = parseDeclarationBody(c, body.value, {
          name: c.req.param("name"),
          ...query.value,
        });
        if (!parsed.ok) return parsed.response;
        if (
          parsed.value.resourceVersion !== undefined &&
          parsed.value.resourceVersion !== String(generation.value)
        ) {
          return failed(
            c,
            "body resourceVersion does not match the HTTP precondition",
          ).response;
        }
        try {
          const declared = await putDeclaredInterface({
            actor: withInterfaceIdempotencyRequest(auth.actor, key.value),
            space: query.value.space,
            declaration: parsed.value,
            expectedGeneration: generation.value!,
          });
          c.header("etag", `"${declared.resourceVersion}"`);
          c.header("idempotency-key", key.value);
          return c.json(declared, 200);
        } catch (error) {
          return interfaceWriteError(c, error);
        }
      });

      app.delete(`${interfaceBase}/:name`, async (c) => {
        const auth = await options.authorize(c);
        if (!auth.ok) return portableAuthError(c, auth.response);
        if (!options.canWriteInterfaces?.(auth.actor)) {
          return portableError(
            c,
            "permission_denied",
            "interface declaration write scope is required",
            403,
          );
        }
        const key = idempotencyKey(c);
        if (!key.ok) return key.response;
        const query = exactDeclarationQuery(c);
        if (!query.ok) return query.response;
        const generation = interfaceIfMatch(c);
        if (!generation.ok) return generation.response;
        try {
          await deleteDeclaredInterface({
            actor: withInterfaceIdempotencyRequest(auth.actor, key.value),
            space: query.value.space,
            name: c.req.param("name"),
            version: query.value.version,
            resourceKind: query.value.resourceKind,
            resourceName: query.value.resourceName,
            expectedGeneration: generation.value,
          });
          c.header("idempotency-key", key.value);
          return c.body(null, 204);
        } catch (error) {
          return interfaceWriteError(c, error);
        }
      });
    }
  }

  app.get(`${base}/forms`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    if (!options.canReadForms(auth.actor)) {
      return portableError(
        c,
        "permission_denied",
        "form availability read scope is required",
        403,
      );
    }
    const space = requiredQuery(c, "space");
    if (!space.ok) return space.response;
    const page = pageQuery(c);
    if (!page.ok) return page.response;
    const identity = formIdentityFromQuery(c, false);
    if (!identity.ok) return identity.response;
    const result = await options.availability.listFormAvailability({
      actor: auth.actor,
      space: space.value,
      ...(identity.value ? { identity: identity.value } : {}),
      page: page.value,
    });
    return c.json(
      {
        forms: result.items.map(portableFormAvailability),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      },
      200,
    );
  });

  app.get(`${TAKOFORM_FORM_HOST_FORM_DEFINITIONS_PATH}/:kind`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    if (!options.canReadForms(auth.actor)) {
      return portableError(
        c,
        "permission_denied",
        "form definition read scope is required",
        403,
      );
    }
    const space = requiredQuery(c, "space");
    if (!space.ok) return space.response;
    const identity = formIdentityFromQuery(c, true);
    if (!identity.ok) return identity.response;
    const pathKind = c.req.param("kind");
    if (
      !pathKind ||
      shapeKindForPortableType(identity.value.type) !== pathKind
    ) {
      return portableError(
        c,
        "form_unknown",
        "exact form definition is unknown",
        404,
      );
    }
    const reader = options.availability.getReadableFormDefinition;
    if (!reader) {
      return portableError(
        c,
        "form_unknown",
        "exact form definition is unknown",
        404,
      );
    }
    let definition: FormDefinition | undefined;
    try {
      definition = await reader({
        actor: auth.actor,
        space: space.value,
        identity: identity.value,
      });
    } catch {
      definition = undefined;
    }
    if (
      !definition ||
      installedFormReferenceKey(definition.identity) !==
        installedFormReferenceKey(identity.value) ||
      definition.desiredSchema === undefined ||
      !isJsonObject(definition.desiredSchema)
    ) {
      return portableError(
        c,
        "form_unknown",
        "exact form definition is unknown",
        404,
      );
    }
    return c.json(
      portableFormDefinition(definition, pathKind),
      200,
    );
  });

  app.post(`${base}/resources/preview`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const parsed = await parseResourceBody(c, auth.actor, true);
    if (!parsed.ok) return parsed.response;
    const owned = await withHostResourceOwner(c, options, parsed.request);
    if (!owned.ok) return owned.response;
    const request = owned.request;
    const operation = await desiredWriteOperation(options.service, request);
    const available = await requireAvailableForm(
      c,
      options,
      auth.actor,
      request,
      operation,
    );
    if (!available.ok) return available.response;
    const result = await options.service.preview(request);
    if (!result.ok) return serviceError(c, result.error);
    return c.json(
      {
        resource: portableResource(result.value.resource, {
          resourceVersion:
            request.expectedGeneration === 0
              ? ""
              : String(request.expectedGeneration ?? ""),
          omitStatus: true,
        }),
        review: {
          planDigest: result.value.planDigest,
          specDigest: `sha256:${await sha256HexAsync(
            canonicalJsonBytes(request.spec as CanonicalJsonValue),
          )}`,
        },
      },
      200,
    );
  });

  app.put(`${base}/resources/:kind/:name`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const key = idempotencyKey(c);
    if (!key.ok) return key.response;
    const parsed = await parseResourceBody(
      c,
      auth.actor,
      true,
    );
    if (!parsed.ok) return parsed.response;
    const owned = await withHostResourceOwner(c, options, parsed.request);
    if (!owned.ok) return owned.response;
    const request = owned.request;
    const review = reviewFromBody(c, parsed.body);
    if (!review.ok) return review.response;
    const operation = await desiredWriteOperation(options.service, request);
    const available = await requireAvailableForm(
      c,
      options,
      auth.actor,
      request,
      operation,
    );
    if (!available.ok) return available.response;
    return executePortableIdempotentMutation(
      c,
      options,
      {
        actor: auth.actor,
        space: request.space,
        idempotencyKey: key.value,
      },
      async () => {
        const result = await options.service.apply(request, review.value);
        if (!result.ok) return serviceError(c, result.error);
        const resource = portableResource(result.value);
        if (result.value.kind === "EdgeWorker" && !resource.status) {
          return serviceError(c, {
            code: "deployment_finalize_pending",
            message:
              "resource backend apply succeeded but portable status is not Ready",
            retryable: true,
            retryAfterSeconds: 5,
          });
        }
        return portableJson(
          c,
          resource,
          200,
          key.value,
        );
      },
      {
        resume: async () => {
          const result = await options.service.recoverApply(
            request,
            review.value,
          );
          if (!result.ok) return serviceError(c, result.error);
          const resource = portableResource(result.value);
          if (result.value.kind === "EdgeWorker" && !resource.status) {
            return serviceError(c, {
              code: "deployment_finalize_pending",
              message:
                "resource backend apply succeeded but portable status is not Ready",
              retryable: true,
              retryAfterSeconds: 5,
            });
          }
          return portableJson(
            c,
            resource,
            200,
            key.value,
          );
        },
        validateReplay: async (response, idempotencyRequest) => {
          if (
            request.kind !== "EdgeWorker" ||
            portableReplayHasStatus(response)
          ) {
            return undefined;
          }
          try {
            const quarantined = await options.idempotency!.quarantineReplay(
              idempotencyRequest,
              response,
              (candidate) => !portableReplayHasStatus(candidate),
            );
            if (quarantined.kind === "quarantined") {
              return serviceError(c, {
                code: "deployment_finalize_pending",
                message:
                  "cached EdgeWorker success lacks portable status; retry after Core Resource recovery",
                retryable: true,
                retryAfterSeconds: 5,
              });
            }
            return serviceError(c, {
              code: "deployment_finalize_pending",
              message:
                "cached EdgeWorker success could not be safely replayed; retry after Core Resource recovery",
              retryable: true,
              retryAfterSeconds: 5,
            });
          } catch {
            return portableError(
              c,
              "backend_unavailable",
              "portable host idempotency replay quarantine failed",
              503,
              true,
            );
          }
        },
        retainReservationOnFailure: async () =>
          (await options.service.applyReplayStatus(request, review.value)) !==
          undefined,
      },
    );
  });

  app.post(`${base}/resources/:kind/:name/import`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const key = idempotencyKey(c);
    if (!key.ok) return key.response;
    const parsed = await parseResourceBody(
      c,
      auth.actor,
      true,
    );
    if (!parsed.ok) return parsed.response;
    const owned = await withHostResourceOwner(c, options, parsed.request);
    if (!owned.ok) return owned.response;
    const request = owned.request;
    const nativeId = stringValue(parsed.body.nativeId);
    if (!nativeId)
      return portableError(c, "invalid_argument", "nativeId is required", 400);
    const importRequest = {
      ...request,
      nativeId,
    };
    const replayStatus =
      await options.service.importReplayStatus(importRequest);
    const available = await requireAvailableForm(
      c,
      options,
      auth.actor,
      request,
      "import",
    );
    if (!available.ok) return available.response;
    // Import already classifies its own replay, so re-running the exact
    // request is the correct resume for a reservation whose first attempt
    // never reported a backend outcome.
    const runImport = async (): Promise<Response> => {
      const result = await options.service.importResource(importRequest, {
        replayOnly: replayStatus !== undefined,
      });
      if (!result.ok) return serviceError(c, result.error);
      return portableJson(
        c,
        {
          resource: portableResource(result.value.resource),
        },
        200,
        key.value,
      );
    };
    return executePortableIdempotentMutation(
      c,
      options,
      {
        actor: auth.actor,
        space: request.space,
        idempotencyKey: key.value,
      },
      runImport,
      { resume: runImport },
    );
  });

  app.get(`${base}/resources`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const space = requiredQuery(c, "space");
    if (!space.ok) return space.response;
    const identity = formIdentityFromQuery(c, true);
    if (!identity.ok) return identity.response;
    const page = pageQuery(c);
    if (!page.ok) return page.response;
    const result = await options.service.listPage(space.value, page.value);
    const key = installedFormReferenceKey(identity.value);
    return c.json(
      {
        resources: result.items
          .filter(
            (item) => item.form && installedFormReferenceKey(item.form) === key,
          )
          .map((resource) => portableResource(resource)),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      },
      200,
    );
  });

  app.get(`${base}/resources/:kind/:name`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const located = await exactStoredResource(c, options.service, false);
    if (!located.ok) return located.response;
    return portableJson(c, portableResource(located.value), 200);
  });

  // Read-only drift check (Terraform refresh semantics).
  app.post(`${base}/resources/:kind/:name/observe`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const key = idempotencyKey(c);
    if (!key.ok) return key.response;
    const space = requiredQuery(c, "space");
    if (!space.ok) return space.response;
    const identity = formIdentityFromQuery(c, true);
    if (!identity.ok) return identity.response;
    const observeKind = c.req.param("kind");
    const observeName = c.req.param("name");
    if (
      !observeKind ||
      !isResourceShapeKind(observeKind) ||
      !observeName
    ) {
      return failed(c, "resource kind and name are required").response;
    }
    const observeOwner = await resolveHostResourceOwner(c, options, {
      actor: auth.actor,
      request: c.req.raw,
      space: space.value,
      kind: observeKind,
      name: observeName,
    });
    if (observeOwner.ok === false) return observeOwner.response;
    // Observation is a read-side reconcile, so replaying the exact request is
    // the correct resume for an interrupted reservation.
    const runObserve = async (): Promise<Response> => {
      const located = await exactStoredResource(c, options.service, true);
      if (!located.ok) return located.response;
      const result = await options.service.observe(
        located.value.metadata.space,
        located.value.kind,
        located.value.metadata.name,
        auth.actor,
        {
          expectedGeneration: located.value.metadata.generation,
          ...(observeOwner.owner
            ? { expectedOwner: observeOwner.owner }
            : {}),
        },
      );
      if (!result.ok) return serviceError(c, result.error);
      return portableJson(
        c,
        {
          resource: portableResource(result.value.resource),
        },
        200,
        key.value,
      );
    };
    return executePortableIdempotentMutation(
      c,
      options,
      { actor: auth.actor, space: space.value, idempotencyKey: key.value },
      runObserve,
      { resume: runObserve },
    );
  });

  // Host republishes backend state and sanitized outputs.
  app.post(`${base}/resources/:kind/:name/refresh`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const key = idempotencyKey(c);
    if (!key.ok) return key.response;
    const space = requiredQuery(c, "space");
    if (!space.ok) return space.response;
    const identity = formIdentityFromQuery(c, true);
    if (!identity.ok) return identity.response;
    const refreshKind = c.req.param("kind");
    const refreshName = c.req.param("name");
    if (
      !refreshKind ||
      !isResourceShapeKind(refreshKind) ||
      !refreshName
    ) {
      return failed(c, "resource kind and name are required").response;
    }
    const refreshOwner = await resolveHostResourceOwner(c, options, {
      actor: auth.actor,
      request: c.req.raw,
      space: space.value,
      kind: refreshKind,
      name: refreshName,
    });
    if (refreshOwner.ok === false) return refreshOwner.response;
    // Refresh republishes observed backend state without redispatching a
    // desired-state mutation, so the exact request is its own resume.
    const runRefresh = async (): Promise<Response> => {
      const located = await exactStoredResource(c, options.service, true);
      if (!located.ok) return located.response;
      const result = await options.service.refresh(
        located.value.metadata.space,
        located.value.kind,
        located.value.metadata.name,
        auth.actor,
        {
          expectedGeneration: located.value.metadata.generation,
          ...(refreshOwner.owner
            ? { expectedOwner: refreshOwner.owner }
            : {}),
        },
      );
      if (!result.ok) return serviceError(c, result.error);
      return portableJson(
        c,
        {
          resource: portableResource(result.value.resource),
        },
        200,
        key.value,
      );
    };
    return executePortableIdempotentMutation(
      c,
      options,
      {
        actor: auth.actor,
        space: space.value,
        idempotencyKey: key.value,
      },
      runRefresh,
      { resume: runRefresh },
    );
  });

  app.delete(`${base}/resources/:kind/:name`, async (c): Promise<Response> => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const key = idempotencyKey(c);
    if (!key.ok) return key.response;
    const space = requiredQuery(c, "space");
    if (!space.ok) return space.response;
    const identity = formIdentityFromQuery(c, true);
    if (!identity.ok) return identity.response;
    const pathKind = c.req.param("kind");
    const pathName = c.req.param("name");
    if (!pathKind || !isResourceShapeKind(pathKind) || !pathName) {
      return failed(c, "resource kind and name are required").response;
    }
    // A managed destroy token is a different authority from ordinary user
    // deletion. Resolve it through the same host context seam so the worker
    // can require the exact running destroy ApplyRun; ordinary user-auth
    // requests still receive no owner and follow the existing delete path.
    const resolvedOwner = await resolveHostResourceOwner(c, options, {
      actor: auth.actor,
      request: c.req.raw,
      space: space.value,
      kind: pathKind,
      name: pathName,
    });
    if (resolvedOwner.ok === false) return resolvedOwner.response;
    const expectedOwner = resolvedOwner.owner;
    // Deletion of one exact generation is idempotent: a resumed attempt either
    // finds the row already gone and retries canonical host retirement, or
    // continues retiring a record left in Deleting. Without this, an
    // interrupted delete strands its reservation and the operator cannot retry,
    // because a provider derives the Idempotency-Key from the operation
    // identity rather than the attempt.
    const runDelete = async (): Promise<Response> => {
      const located = await exactStoredResource(c, options.service, true, true);
      if (!located.ok) return located.response;
      if (!located.value) {
        const kind = c.req.param("kind") as ResourceShapeKind;
        const name = c.req.param("name")!;
        const result = await options.service.delete(
          space.value,
          kind,
          name,
          auth.actor,
          {
            expectedManagedBy: PORTABLE_FORM_MANAGER,
            ...(expectedOwner ? { expectedOwner } : {}),
          },
        );
        if (!result.ok) return serviceError(c, result.error);
        c.header("idempotency-key", key.value);
        return c.body(null, 204);
      }
      const result = await options.service.delete(
        located.value.metadata.space,
        located.value.kind,
        located.value.metadata.name,
        auth.actor,
        {
          expectedManagedBy: PORTABLE_FORM_MANAGER,
          expectedGeneration: located.value.metadata.generation,
          ...(expectedOwner ? { expectedOwner } : {}),
        },
      );
      if (!result.ok) return serviceError(c, result.error);
      c.header("idempotency-key", key.value);
      return c.body(null, 204);
    };
    return executePortableIdempotentMutation(
      c,
      options,
      { actor: auth.actor, space: space.value, idempotencyKey: key.value },
      runDelete,
      { resume: runDelete },
    );
  });
}

const PORTABLE_FORM_TRANSITION_BODY_MAX_BYTES = 64 * 1024;
const PORTABLE_FORM_TRANSITION_KEYS = new Set([
  "operationId",
  "fromForm",
  "toForm",
  "resource",
  "expected",
  "transitionEvidence",
]);
const PORTABLE_FORM_TRANSITION_RESOURCE_KEYS = new Set([
  "apiVersion",
  "kind",
  "form",
  "metadata",
  "spec",
]);
const PORTABLE_FORM_TRANSITION_METADATA_KEYS = new Set([
  "name",
  "space",
  "resourceVersion",
]);

function registerPortableResourceFormTransitionRoutes(
  app: Hono,
  options: RegisterPortableFormHostRoutesOptions,
): void {
  const transitions = options.formTransition!;
  const path = `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name/form-transitions`;

  app.post(path, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const key = idempotencyKey(c);
    if (!key.ok) return key.response;
    const identity = portableTransitionPathIdentity(c);
    if (!identity.ok) return identity.response;
    const ifMatch = portableTransitionIfMatch(c);
    if (!ifMatch.ok) return ifMatch.response;
    const parsed = await parsePortableFormTransitionBody(c, identity.value);
    if (!parsed.ok) return parsed.response;
    if (key.value !== parsed.value.operationId) {
      return failed(c, "Idempotency-Key must equal operationId").response;
    }
    if (ifMatch.value !== parsed.value.expected.resourceVersion) {
      return generationConflict(
        c,
        "If-Match must equal expected.resourceVersion",
      ).response;
    }
    const resolvedOwner = await resolveHostResourceOwner(c, options, {
      actor: auth.actor,
      request: c.req.raw,
      space: identity.value.space,
      kind: identity.value.kind,
      name: identity.value.name,
    });
    if (!resolvedOwner.ok) return resolvedOwner.response;
    if (!resolvedOwner.owner) {
      return portableError(
        c,
        "permission_denied",
        "exact Capsule Run owner authority is required",
        403,
      );
    }
    try {
      const result = await transitions.transition({
        workspaceId: resolvedOwner.owner.workspaceId,
        spaceId: identity.value.space as never,
        kind: identity.value.kind,
        name: identity.value.name,
        actorId: auth.actor.actorAccountId,
        owner: resolvedOwner.owner,
        operationId: parsed.value.operationId,
        fromForm: parsed.value.fromForm,
        toForm: parsed.value.toForm,
        desiredSpec: parsed.value.desiredSpec,
        expected: parsed.value.expected,
        transitionEvidence: parsed.value.transitionEvidence,
      });
      return await portableTransitionResponse(c, result, identity.value);
    } catch (error) {
      return portableTransitionError(c, error);
    }
  });

  app.get(`${path}/:operationId`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const identity = portableTransitionPathIdentity(c);
    if (!identity.ok) return identity.response;
    const operationId = c.req.param("operationId");
    if (!FORM_TRANSITION_OPERATION_ID_RE.test(operationId)) {
      return failed(c, "operationId is invalid").response;
    }
    const resolvedOwner = await resolveHostResourceOwner(c, options, {
      actor: auth.actor,
      request: c.req.raw,
      space: identity.value.space,
      kind: identity.value.kind,
      name: identity.value.name,
    });
    if (!resolvedOwner.ok) return resolvedOwner.response;
    if (!resolvedOwner.owner) {
      return portableError(
        c,
        "permission_denied",
        "exact Capsule Run owner authority is required",
        403,
      );
    }
    try {
      const result = await transitions.readback({
        workspaceId: resolvedOwner.owner.workspaceId,
        spaceId: identity.value.space as never,
        kind: identity.value.kind,
        name: identity.value.name,
        owner: resolvedOwner.owner,
        operationId,
      });
      return await portableTransitionResponse(c, result, identity.value);
    } catch (error) {
      return portableTransitionError(c, error);
    }
  });
}

function portableTransitionPathIdentity(c: Context):
  | {
      readonly ok: true;
      readonly value: {
        readonly space: string;
        readonly kind: ResourceShapeKind;
        readonly name: string;
      };
    }
  | { readonly ok: false; readonly response: Response } {
  const url = new URL(c.req.url);
  if (
    [...url.searchParams.keys()].some((key) => key !== "space") ||
    url.searchParams.getAll("space").length !== 1
  ) {
    return failed(c, "form transition accepts exactly one space query field");
  }
  const space = url.searchParams.get("space")?.trim();
  const kind = c.req.param("kind");
  const name = c.req.param("name")?.trim();
  if (!space || !name || !isResourceShapeKind(kind)) {
    return failed(c, "transition space, kind, and name are required");
  }
  return { ok: true, value: { space, kind, name } };
}

function portableTransitionIfMatch(c: Context):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly response: Response } {
  if (c.req.header("if-none-match") !== undefined) {
    return failed(c, "If-None-Match is not valid for a Form transition");
  }
  const value = c.req.header("if-match")?.trim();
  if (value === undefined) {
    return generationConflict(c, "If-Match is required");
  }
  const match = /^"([^"]*)"$/u.exec(value);
  const resourceVersion = match?.[1];
  return resourceVersion && isPortableResourceVersion(resourceVersion)
    ? { ok: true, value: resourceVersion }
    : failed(
        c,
        "If-Match must contain one quoted canonical resourceVersion",
      );
}

async function parsePortableFormTransitionBody(
  c: Context,
  identity: { readonly space: string; readonly kind: ResourceShapeKind; readonly name: string },
): Promise<
  | {
      readonly ok: true;
      readonly value: {
        readonly operationId: string;
        readonly fromForm: InstalledFormReference;
        readonly toForm: InstalledFormReference;
        readonly desiredSpec: JsonObject;
        readonly expected: {
          readonly resourceVersion: string;
          readonly nativeIdentity?: TakoformNativeIdentity;
        };
        readonly transitionEvidence: TakoformResourceFormTransitionRequest["transitionEvidence"];
      };
    }
  | { readonly ok: false; readonly response: Response }
> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());
  } catch {
    return failed(c, "portable transition body could not be read");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > PORTABLE_FORM_TRANSITION_BODY_MAX_BYTES) {
    return failed(c, "portable transition body must be 1..65536 bytes");
  }
  let body: JsonObject;
  try {
    const parsed = parseCanonicalJson(bytes);
    if (!isJsonObject(parsed)) throw new TypeError("not an object");
    body = parsed as JsonObject;
  } catch {
    return failed(c, "portable transition body must be complete UTF-8 I-JSON with unique object names");
  }
  if (
    !exactObjectKeys(body, PORTABLE_FORM_TRANSITION_KEYS, [
      "operationId",
      "fromForm",
      "toForm",
      "resource",
      "expected",
      "transitionEvidence",
    ])
  ) {
    return failed(c, "portable transition body has missing or unknown fields");
  }
  const operationId = stringValue(body.operationId);
  const fromForm = installedFormFromPortable(body.fromForm, identity.kind);
  const toForm = installedFormFromPortable(body.toForm, identity.kind);
  if (
    !operationId ||
    !FORM_TRANSITION_OPERATION_ID_RE.test(operationId) ||
    !fromForm ||
    !toForm
  ) {
    return failed(c, "operationId and exact fromForm/toForm are required");
  }
  if (!isJsonObject(body.resource)) {
    return failed(c, "resource must be a desired Takoform Resource");
  }
  const resource = body.resource;
  if (
    !exactObjectKeys(resource, PORTABLE_FORM_TRANSITION_RESOURCE_KEYS, [
      "apiVersion",
      "kind",
      "form",
      "metadata",
      "spec",
    ]) ||
    resource.apiVersion !== TAKOFORM_FORM_HOST_API_VERSION ||
    resource.kind !== identity.kind ||
    !isJsonObject(resource.metadata) ||
    !isJsonObject(resource.spec)
  ) {
    return failed(c, "resource must be a closed desired v1alpha1 Resource");
  }
  const desiredForm = installedFormFromPortable(resource.form, identity.kind);
  if (
    !desiredForm ||
    installedFormReferenceKey(desiredForm) !== installedFormReferenceKey(toForm)
  ) {
    return failed(c, "resource.form must equal the exact toForm");
  }
  if (
    !exactObjectKeys(resource.metadata, PORTABLE_FORM_TRANSITION_METADATA_KEYS, [
      "name",
      "space",
      "resourceVersion",
    ]) ||
    resource.metadata.name !== identity.name ||
    resource.metadata.space !== identity.space
  ) {
    return failed(c, "resource metadata must preserve the exact path name and space");
  }

  if (
    !isJsonObject(body.expected) ||
    !exactObjectKeys(
      body.expected,
      new Set(["resourceVersion", "nativeIdentity"]),
      ["resourceVersion"],
    )
  ) {
    return failed(c, "expected.resourceVersion is required; unknown fields are rejected");
  }
  const expectedResourceVersion = stringValue(body.expected.resourceVersion);
  if (
    !expectedResourceVersion ||
    !isPortableResourceVersion(expectedResourceVersion)
  ) {
    return failed(c, "expected.resourceVersion is invalid");
  }
  let nativeIdentity: TakoformNativeIdentity | undefined;
  if (body.expected.nativeIdentity !== undefined) {
    if (
      !isJsonObject(body.expected.nativeIdentity) ||
      !exactObjectKeys(body.expected.nativeIdentity, new Set(["type", "id"]), ["type", "id"])
    ) {
      return failed(c, "expected.nativeIdentity must contain only type and id");
    }
    const type = boundedIdentityText(body.expected.nativeIdentity.type);
    const id = boundedIdentityText(body.expected.nativeIdentity.id);
    if (!type || !id) return failed(c, "expected.nativeIdentity is invalid");
    nativeIdentity = { type, id };
  }
  const expected = {
    resourceVersion: expectedResourceVersion,
    ...(nativeIdentity ? { nativeIdentity } : {}),
  };
  const resourceVersion = stringValue(resource.metadata.resourceVersion);
  if (!resourceVersion || !isPortableResourceVersion(resourceVersion)) {
    return failed(c, "resource.metadata.resourceVersion is invalid");
  }
  if (resourceVersion !== expected.resourceVersion) {
    return failed(c, "resourceVersion does not match expected.resourceVersion");
  }
  if (
    !isJsonObject(body.transitionEvidence) ||
    !exactObjectKeys(
      body.transitionEvidence,
      new Set(["format", "marker", "digest"]),
      ["format", "marker", "digest"],
    ) ||
    body.transitionEvidence.format !== TAKOFORM_RESOURCE_FORM_TRANSITION_EVIDENCE_FORMAT ||
    typeof body.transitionEvidence.marker !== "string" ||
    typeof body.transitionEvidence.digest !== "string"
  ) {
    return failed(c, "transitionEvidence is invalid");
  }
  return {
    ok: true,
    value: {
      operationId,
      fromForm,
      toForm,
      desiredSpec: resource.spec,
      expected,
      transitionEvidence: {
        format: TAKOFORM_RESOURCE_FORM_TRANSITION_EVIDENCE_FORMAT,
        marker: body.transitionEvidence.marker,
        digest: body.transitionEvidence.digest as `sha256:${string}`,
      },
    },
  };
}

async function portableTransitionResponse(
  c: Context,
  result: ResourceFormTransitionResult,
  identity: { readonly space: string; readonly kind: ResourceShapeKind; readonly name: string },
): Promise<Response> {
  const reconcilePath =
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/${encodeURIComponent(identity.kind)}/` +
    `${encodeURIComponent(identity.name)}/form-transitions/${encodeURIComponent(result.operationId)}` +
    `?space=${encodeURIComponent(identity.space)}`;
  if (result.status === "prepared" || result.status === "indeterminate") {
    return c.json(
      {
        operation: {
          operationId: result.operationId,
          status: result.status,
          requestDigest: result.requestDigest,
          reconcilePath,
          dispatchAttempted: result.dispatchAttempted,
        },
      },
      202,
    );
  }
  if (result.status === "rejected") {
    const rejectionCode = /^[a-z][a-z0-9_]{0,63}$/u.test(
      result.rejectionCode,
    )
      ? result.rejectionCode
      : "host_rejected";
    return portableError(
      c,
      "form_identity_conflict",
      "exact Resource Form transition was rejected",
      409,
      false,
      rejectionCode,
      {
        operationId: result.operationId,
        requestDigest: result.requestDigest,
        status: "failed",
        failureCode: rejectionCode,
      },
    );
  }
  const native = result.proof.nativeResources[0];
  if (!native) {
    return portableError(c, "internal_error", "committed transition proof is incomplete", 500);
  }
  return c.json(
    {
      operation: {
        operationId: result.operationId,
        status: "committed",
        requestDigest: result.requestDigest,
        reconcilePath,
      },
      resource: portableResource(
        transitionResourceObject(result.resource, result.lock),
        { resourceVersion: String(result.proof.resourceGeneration) },
      ),
      transitionProof: {
        operationId: result.operationId,
        fromForm: portableFormReference(result.proof.fromForm, identity.kind),
        toForm: portableFormReference(result.proof.toForm, identity.kind),
        transitionEvidenceDigest: result.proof.transitionEvidenceDigest,
        observedSpecDigest: result.proof.observedSpecDigest,
        resourceVersion: String(result.proof.resourceGeneration),
        nativeIdentity: { type: native.type, id: native.id },
        committed: true,
      },
    },
    200,
  );
}

function portableTransitionError(c: Context, cause: unknown): Response {
  if (!(cause instanceof ResourceFormTransitionError)) {
    return portableError(c, "backend_unavailable", "Resource Form transition is unavailable", 503, true);
  }
  const mapping: Record<
    ResourceFormTransitionError["code"],
    readonly [TakoformHostErrorCode, number, boolean]
  > = {
    invalid_request: ["invalid_argument", 400, false],
    resource_not_found: ["resource_not_found", 404, false],
    operation_not_found: ["resource_not_found", 404, false],
    ownership_conflict: ["permission_denied", 403, false],
    resource_not_ready: ["resource_busy", 409, false],
    form_identity_conflict: ["form_identity_conflict", 409, false],
    form_not_retained: ["form_not_installed", 409, false],
    transition_not_allowed: ["policy_denied", 403, false],
    resource_version_conflict: ["resource_version_conflict", 412, false],
    native_identity_conflict: ["form_identity_conflict", 409, false],
    operation_conflict: ["resource_busy", 409, false],
    canonical_conflict: ["resource_busy", 409, true],
    backend_unavailable: ["backend_unavailable", 503, true],
  };
  const selected = mapping[cause.code];
  return portableError(
    c,
    selected[0],
    "Resource Form transition was rejected",
    selected[1],
    selected[2],
    cause.code === "operation_not_found"
      ? "form_transition_operation_not_found"
      : cause.code,
  );
}

function exactObjectKeys(
  value: JsonObject,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && required.every((key) => keys.includes(key));
}

function boundedIdentityText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) return undefined;
  return value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

async function readPortableJsonObject(
  c: Context,
): Promise<
  | { readonly ok: true; readonly value: JsonObject }
  | { readonly ok: false; readonly response: Response }
> {
  try {
    const value = parseCanonicalJson(
      new Uint8Array(await c.req.raw.clone().arrayBuffer()),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return failed(c, "portable request body must be a JSON object");
    }
    return { ok: true, value: value as JsonObject };
  } catch {
    return failed(
      c,
      "portable request body must be complete UTF-8 I-JSON with unique object names",
    );
  }
}

async function parseResourceBody(
  c: Context,
  actor: ActorContext,
  requireWritePrecondition = false,
): Promise<
  | {
      readonly ok: true;
      readonly request: ApplyResourceRequest;
      readonly body: JsonObject;
    }
  | { readonly ok: false; readonly response: Response }
> {
  const decoded = await readPortableJsonObject(c);
  if (!decoded.ok) return decoded;
  const body = decoded.value;
  for (const key of Object.keys(body)) {
    if (!PORTABLE_RESOURCE_BODY_KEYS.has(key)) {
      return failed(c, `${key} is not a portable Resource field`);
    }
  }
  if (body.apiVersion !== TAKOFORM_FORM_HOST_API_VERSION) {
    return failed(c, "apiVersion is invalid");
  }
  const kind = stringValue(body.kind);
  if (!kind || !isResourceShapeKind(kind)) return failed(c, "kind is invalid");
  const pathKind = c.req.param("kind");
  if (pathKind && pathKind !== kind)
    return failed(c, "path kind does not match body kind");
  const form = installedFormFromPortable(body.form, kind);
  if (!form) return failed(c, "form must be an exact installed FormRef");
  if (!isJsonObject(body.metadata)) {
    return failed(c, "metadata must be an object");
  }
  for (const key of Object.keys(body.metadata)) {
    if (!PORTABLE_RESOURCE_METADATA_KEYS.has(key)) {
      return failed(c, `metadata.${key} is not a portable Resource field`);
    }
  }
  if (body.status !== undefined || body.id !== undefined) {
    return failed(c, "status and id are host-owned response fields");
  }
  const name = stringValue(body.metadata.name);
  const space = stringValue(body.metadata.space);
  if (!name || !space)
    return failed(c, "metadata.name and metadata.space are required");
  if (c.req.param("name") && c.req.param("name") !== name) {
    return failed(c, "path name does not match resource name");
  }
  if (!isJsonObject(body.spec)) return failed(c, "spec must be an object");
  if (
    body.metadata.managedBy !== undefined ||
    body.metadata.owner !== undefined
  ) {
    return failed(c, "host manager authority is not portable input");
  }
  const labels = stringRecord(body.metadata.labels);
  if (body.metadata.labels !== undefined && labels === undefined) {
    return failed(c, "metadata.labels must be a string map");
  }
  const generation = generationPrecondition(c, requireWritePrecondition);
  if (!generation.ok) return generation;
  const bodyVersion = stringValue(body.metadata.resourceVersion);
  if (
    body.metadata.resourceVersion !== undefined &&
    (bodyVersion === undefined || !isPortableResourceVersion(bodyVersion))
  ) {
    return failed(
      c,
      "metadata.resourceVersion must be a canonical positive decimal no greater than 9223372036854775807",
    );
  }
  if (
    generation.value !== undefined &&
    bodyVersion !== generation.resourceVersion
  ) {
    return failed(
      c,
      "metadata.resourceVersion does not match the HTTP precondition",
    );
  }
  return {
    ok: true,
    body: body as JsonObject,
    request: {
      actor,
      space,
      kind,
      form,
      name,
      spec: body.spec,
      managedBy: PORTABLE_FORM_MANAGER,
      expectedGeneration: generation.value,
      project: stringValue(body.metadata.project),
      environment: stringValue(body.metadata.environment),
      ...(labels ? { labels } : {}),
    },
  };
}

/**
 * The portable request envelope is closed. Host authority and unknown fields
 * are rejected instead of being silently dropped.
 */
const PORTABLE_RESOURCE_BODY_KEYS = new Set([
  "apiVersion",
  "kind",
  "form",
  "metadata",
  "spec",
  "status",
  "id",
  "review",
  "nativeId",
]);

const PORTABLE_RESOURCE_METADATA_KEYS = new Set([
  "name",
  "space",
  "project",
  "environment",
  "labels",
  "resourceVersion",
]);

function generationPrecondition(
  c: Context,
  required: boolean,
):
  | {
      readonly ok: true;
      readonly value: number | undefined;
      readonly resourceVersion?: string;
    }
  | { readonly ok: false; readonly response: Response } {
  const create = c.req.header("if-none-match")?.trim();
  const update = c.req.header("if-match")?.trim();
  if (create && update)
    return failed(c, "If-Match and If-None-Match are mutually exclusive");
  if (create !== undefined) {
    if (create !== "*") return failed(c, "If-None-Match supports only '*'");
    return { ok: true, value: 0 };
  }
  if (update !== undefined) {
    const match = /^"([^"]*)"$/u.exec(update);
    const resourceVersion = match?.[1];
    if (
      resourceVersion === undefined ||
      !isPortableResourceVersion(resourceVersion)
    ) {
      return failed(
        c,
        "If-Match must contain one quoted canonical resourceVersion no greater than 9223372036854775807",
      );
    }
    return {
      ok: true,
      value: Number(resourceVersion),
      resourceVersion,
    };
  }
  return required
    ? generationConflict(c, "If-None-Match: * or If-Match is required")
    : { ok: true, value: undefined };
}

const PORTABLE_RESOURCE_VERSION_MAX = "9223372036854775807";

function generationConflict(
  c: Context,
  message: string,
): { readonly ok: false; readonly response: Response } {
  return {
    ok: false,
    response: portableError(
      c,
      "resource_version_conflict",
      message,
      412,
      false,
      "resource_version_conflict",
    ),
  };
}

function isPortableResourceVersion(value: string): boolean {
  return (
    /^[1-9][0-9]*$/u.test(value) &&
    (value.length < PORTABLE_RESOURCE_VERSION_MAX.length ||
      (value.length === PORTABLE_RESOURCE_VERSION_MAX.length &&
        value <= PORTABLE_RESOURCE_VERSION_MAX))
  );
}

async function exactStoredResource(
  c: Context,
  service: ResourceShapeService,
  requireMatch: boolean,
  allowAbsent?: false,
): Promise<
  | { readonly ok: true; readonly value: ResourceObject }
  | { readonly ok: false; readonly response: Response }
>;
async function exactStoredResource(
  c: Context,
  service: ResourceShapeService,
  requireMatch: boolean,
  allowAbsent: true,
): Promise<
  | { readonly ok: true; readonly value: ResourceObject | undefined }
  | { readonly ok: false; readonly response: Response }
>;
async function exactStoredResource(
  c: Context,
  service: ResourceShapeService,
  requireMatch: boolean,
  allowAbsent = false,
): Promise<
  | { readonly ok: true; readonly value: ResourceObject | undefined }
  | { readonly ok: false; readonly response: Response }
> {
  const expected = ifMatchPrecondition(c, requireMatch);
  if (!expected.ok) return expected;
  const space = requiredQuery(c, "space");
  if (!space.ok) return space;
  const identity = formIdentityFromQuery(c, true);
  if (!identity.ok) return identity;
  const kind = c.req.param("kind");
  if (
    kind === undefined ||
    !isResourceShapeKind(kind) ||
    shapeKindForPortableType(identity.value.type) !== kind
  ) {
    return failed(c, "path kind does not match the exact form identity");
  }
  const name = c.req.param("name");
  if (!name) return failed(c, "resource name is required");
  const result = await service.get(space.value, kind, name);
  if (!result.ok) {
    if (allowAbsent && result.error.code === "not_found")
      return { ok: true, value: undefined };
    return { ok: false, response: serviceError(c, result.error) };
  }
  if (
    !result.value.form ||
    installedFormReferenceKey(result.value.form) !==
      installedFormReferenceKey(identity.value)
  ) {
    return {
      ok: false,
      response: portableError(
        c,
        "form_identity_conflict",
        "resource is pinned to a different exact form identity",
        409,
        false,
        "form_identity_conflict",
      ),
    };
  }
  if (
    expected.value !== undefined &&
    result.value.metadata.generation !== expected.value
  ) {
    return {
      ok: false,
      response: portableError(
        c,
        "resource_version_conflict",
        "serial precondition failed",
        412,
        false,
        "resource_version_conflict",
      ),
    };
  }
  return { ok: true, value: result.value };
}

function ifMatchPrecondition(
  c: Context,
  required: boolean,
):
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly response: Response } {
  if (c.req.header("if-none-match") !== undefined) {
    return failed(c, "If-None-Match is not valid for an existing Resource");
  }
  const value = c.req.header("if-match")?.trim();
  if (value === undefined) {
    return required
      ? generationConflict(c, "If-Match is required")
      : { ok: true, value: undefined };
  }
  const match = /^"([1-9][0-9]*)"$/u.exec(value);
  return match
    ? { ok: true, value: Number(match[1]) }
    : failed(c, "If-Match must contain one quoted serial");
}

function formIdentityFromQuery(
  c: Context,
  required: true,
):
  | { readonly ok: true; readonly value: InstalledFormReference }
  | { readonly ok: false; readonly response: Response };
function formIdentityFromQuery(
  c: Context,
  required: false,
):
  | { readonly ok: true; readonly value: InstalledFormReference | undefined }
  | { readonly ok: false; readonly response: Response };
function formIdentityFromQuery(c: Context, required: boolean) {
  const values = {
    apiVersion: c.req.query("apiVersion"),
    kind: c.req.query("kind"),
    definitionVersion: c.req.query("definitionVersion"),
    schemaDigest: c.req.query("schemaDigest"),
    packageDigest: c.req.query("packageDigest"),
  };
  if (!Object.values(values).some(Boolean) && !required)
    return { ok: true, value: undefined };
  if (!Object.values(values).every(Boolean))
    return failed(c, "the complete exact FormRef query is required");
  if (values.apiVersion !== TAKOFORM_FORM_HOST_API_VERSION) {
    return failed(c, "the exact FormRef apiVersion is invalid");
  }
  const identity = installedFormFromPortable(
    {
      formRef: {
        apiVersion: values.apiVersion,
        kind: values.kind,
        definitionVersion: values.definitionVersion,
        schemaDigest: values.schemaDigest,
      },
      packageDigest: values.packageDigest,
    },
    values.kind,
  );
  return identity
    ? { ok: true, value: identity }
    : failed(c, "the exact FormRef query is invalid");
}

async function requireAvailableForm(
  c: Context,
  options: RegisterPortableFormHostRoutesOptions,
  actor: ActorContext,
  request: ApplyResourceRequest,
  operation: "create" | "update" | "import",
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly response: Response }
> {
  const result = await options.availability.listFormAvailability({
    actor,
    space: request.space,
    identity: request.form!,
    page: { limit: 1 },
  });
  const expected = installedFormReferenceKey(request.form!);
  const found = result.items.find(
    (item) => installedFormReferenceKey(item.form) === expected,
  );
  if (!found)
    return {
      ok: false,
      response: portableError(
        c,
        "form_unknown",
        "exact form identity is unknown",
        404,
        false,
        "form_unknown",
      ),
    };
  if (!found.definitionKnown) {
    return {
      ok: false,
      response: portableError(
        c,
        "form_unknown",
        "exact form identity is unknown",
        404,
        false,
        "form_unknown",
      ),
    };
  }
  if (!found.installed)
    return {
      ok: false,
      response: portableError(
        c,
        "form_not_installed",
        "exact form package is not installed",
        409,
        false,
        "form_not_installed",
      ),
    };
  if (!found.executable || !found.activated)
    return {
      ok: false,
      response: portableError(
        c,
        "form_unavailable",
        "exact form is not executable on this host",
        503,
        false,
        "form_unavailable",
      ),
    };
  if (!found.availableToPrincipal)
    return {
      ok: false,
      response: portableError(
        c,
        "policy_denied",
        "principal is not allowed to use this exact form",
        403,
      ),
    };
  if (!found.operations.includes(operation))
    return {
      ok: false,
      response: portableError(
        c,
        "form_unavailable",
        `exact form does not support ${operation}`,
        503,
        false,
        "form_unavailable",
      ),
    };
  return { ok: true };
}

async function desiredWriteOperation(
  service: ResourceShapeService,
  request: ApplyResourceRequest,
): Promise<"create" | "update"> {
  const current = await service.get(request.space, request.kind, request.name);
  return current.ok ? "update" : "create";
}

function transitionResourceObject(
  record: ResourceShapeRecord,
  lock: ResolutionLockRecord,
): ResourceObject {
  return {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: record.kind,
    ...(record.form ? { form: record.form } : {}),
    metadata: {
      name: record.name,
      space: record.spaceId,
      generation: record.generation,
      ...(record.project ? { project: record.project } : {}),
      ...(record.environment ? { environment: record.environment } : {}),
      ...(record.owner ? { owner: record.owner } : {}),
      ...(record.labels ? { labels: record.labels } : {}),
      managedBy: record.managedBy,
    },
    spec: record.spec,
    status: {
      phase: record.phase,
      observedGeneration: record.observedGeneration,
      resolution: {
        selectedImplementation: lock.selectedImplementation,
        target: lock.target,
        locked: lock.locked,
        portability: lock.portability ?? "partial",
      },
      ...(record.outputs ? { outputs: record.outputs } : {}),
      ...(record.conditions ? { conditions: record.conditions } : {}),
    },
  };
}

function portableResource(
  resource: ResourceObject,
  options: {
    readonly resourceVersion?: string;
    readonly omitStatus?: boolean;
  } = {},
): TakoformResource {
  if (!resource.form)
    throw new TypeError("portable Resource must carry an exact form identity");
  const formKind = shapeKindForPortableType(resource.form.type);
  if (formKind !== resource.kind)
    throw new TypeError(
      `Resource kind ${resource.kind} does not match its portable Form identity`,
    );
  const generation = resource.metadata.generation ?? 0;
  const outputs =
    resource.status?.phase === "Ready" &&
    resource.status.observedGeneration === generation
      ? resource.status.outputs
      : undefined;
  const portability = resource.status?.resolution?.portability;
  const outputPortability =
    outputs && typeof outputs.portability === "string"
      ? outputs.portability
      : undefined;
  const imported =
    resource.status?.conditions?.some(
      (condition) =>
        condition.type === "Ready" &&
        condition.status === "true" &&
        condition.reason === "Imported",
    ) ?? false;
  const drifted =
    resource.status?.conditions?.some(
      (condition) =>
        condition.type === "Drifted" && condition.status === "true",
    ) ?? false;
  return {
    apiVersion: TAKOFORM_FORM_HOST_API_VERSION,
    kind: resource.kind,
    form: portableFormReference(resource.form, resource.kind),
    metadata: {
      name: resource.metadata.name,
      space: resource.metadata.space,
      resourceVersion: options.resourceVersion ?? String(generation),
    },
    spec: resource.spec,
    ...(options.omitStatus !== true &&
    outputs &&
    portability &&
    outputPortability === portability
      ? {
          status: {
            observed: {
              id: `${resource.kind}/${resource.metadata.name}`,
              ready: true,
              generation,
              imported,
              portability,
              driftedFields: drifted ? ["/"] : [],
            },
            output: outputs,
          },
        }
      : {}),
  };
}

function portableInterfaceDeclaration(
  declaration: TakoformDeclaredInterface,
) {
  return {
    name: declaration.name,
    version: declaration.version,
    resource: declaration.resource,
    document: declaration.document ?? {},
    values: declaration.values ?? {},
    ...(declaration.resourceUri
      ? { resourceUri: declaration.resourceUri }
      : {}),
    ...(declaration.form
      ? {
          form: portableFormReference(
            declaration.form,
            declaration.resource.kind,
          ),
        }
      : {}),
  };
}

function installedFormFromPortable(
  value: unknown,
  expectedKind: unknown,
): InstalledFormReference | undefined {
  if (
    !isJsonObject(value) ||
    !isJsonObject(value.formRef) ||
    value.formRef.apiVersion !== TAKOFORM_FORM_HOST_API_VERSION ||
    typeof value.formRef.kind !== "string" ||
    value.formRef.kind !== expectedKind ||
    typeof value.formRef.definitionVersion !== "string" ||
    typeof value.formRef.schemaDigest !== "string" ||
    typeof value.packageDigest !== "string"
  ) {
    return undefined;
  }
  if (
    Object.keys(value).length !== 2 ||
    !Object.keys(value).every((key) =>
      ["formRef", "packageDigest"].includes(key),
    ) ||
    Object.keys(value.formRef).length !== 4 ||
    !Object.keys(value.formRef).every((key) =>
      ["apiVersion", "kind", "definitionVersion", "schemaDigest"].includes(key),
    )
  ) {
    return undefined;
  }
  const type = portableTypeForShapeKind(value.formRef.kind);
  if (!type) return undefined;
  const identity = {
    type,
    version: value.formRef.definitionVersion,
    schemaDigest: value.formRef.schemaDigest,
    packageDigest: value.packageDigest,
  };
  return isInstalledFormReference(identity) ? identity : undefined;
}

function portableFormReference(
  identity: InstalledFormReference,
  kind: string,
): TakoformResource["form"] {
  if (shapeKindForPortableType(identity.type) !== kind) {
    throw new TypeError("portable Resource and Form kinds differ");
  }
  return {
    formRef: {
      apiVersion: TAKOFORM_FORM_HOST_API_VERSION,
      kind,
      definitionVersion: identity.version,
      schemaDigest: identity.schemaDigest,
    },
    packageDigest: identity.packageDigest,
  };
}

function portableFormAvailability(availability: FormAvailability) {
  const kind = shapeKindForPortableType(availability.form.type);
  if (!kind) {
    throw new TypeError(
      `Form type ${availability.form.type} has no portable Resource kind`,
    );
  }
  return {
    identity: portableFormReference(availability.form, kind),
    definitionKnown: availability.definitionKnown,
    installed: availability.installed,
    executable: availability.executable,
    activated: availability.activated,
    availableToPrincipal: availability.availableToPrincipal,
    operations: availability.operations,
    deprecated: availability.deprecated,
  };
}

function portableFormDefinition(
  definition: FormDefinition,
  kind: string,
): TakoformFormDefinition {
  return {
    identity: portableFormReference(definition.identity, kind),
    ...(definition.displayName !== undefined
      ? { displayName: definition.displayName }
      : {}),
    ...(definition.description !== undefined
      ? { description: definition.description }
      : {}),
    desiredSchema: structuredClone(definition.desiredSchema!),
  };
}

function stringRecord(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === "string")) return undefined;
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function serviceError(c: Context, error: ResourceServiceError): Response {
  const mapping: Record<
    string,
    readonly [TakoformHostErrorCode, number, boolean]
  > = {
    invalid_form_ref: ["invalid_argument", 400, false],
    form_registry_unavailable: ["backend_unavailable", 503, true],
    form_not_installed: ["form_not_installed", 409, false],
    form_identity_conflict: ["form_identity_conflict", 409, false],
    not_found: ["resource_not_found", 404, false],
    connection_not_found: ["resource_not_found", 404, false],
    connection_not_ready: ["resource_busy", 409, false],
    resource_version_conflict: ["resource_version_conflict", 412, false],
    ownership_conflict: ["resource_busy", 409, false],
    reconcile_conflict: ["resource_busy", 409, true],
    import_conflict: ["import_conflict", 409, false],
    policy_denied: ["policy_denied", 403, false],
    deployment_admission_denied: ["policy_denied", 403, false],
    // The published portable taxonomy permits automatic retry only for
    // resource_busy and backend_unavailable. Preserve admission retry evidence
    // in hostCode/details without inventing a Takosumi-only wire code.
    deployment_admission_pending: ["resource_busy", 409, true],
    deployment_finalize_pending: ["resource_busy", 409, true],
    deployment_plan_changed: ["invalid_argument", 400, false],
  };
  const mapped =
    mapping[error.code] ??
    (error.code.startsWith("invalid_")
      ? (["invalid_argument", 400, false] as const)
      : (["backend_unavailable", 503, true] as const));
  if (error.retryAfterSeconds !== undefined) {
    c.header("Retry-After", String(error.retryAfterSeconds));
  }
  const details =
    error.retryable === undefined &&
    error.retryAfterSeconds === undefined &&
    error.attemptId === undefined
      ? undefined
      : {
          ...(error.retryable === undefined
            ? {}
            : { retryable: error.retryable }),
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: error.retryAfterSeconds }),
          ...(error.attemptId === undefined ? {} : { attemptId: error.attemptId }),
        };
  return portableError(
    c,
    mapped[0],
    "portable form operation was rejected",
    mapped[1],
    mapped[2],
    error.code,
    details,
  );
}

function portableError(
  c: Context,
  code: TakoformHostErrorCode,
  message: string,
  status: number,
  retryable = false,
  hostCode?: string,
  details?: unknown,
): Response {
  return c.json(
    {
      error: {
        code,
        message,
        requestId: requestIdFromContext(c),
        retryable,
        ...(hostCode ? { hostCode } : {}),
        ...(details === undefined ? {} : { details }),
      },
    },
    status as 400,
  );
}

function portableAuthError(c: Context, response: Response): Response {
  return portableError(
    c,
    response.status === 403 ? "permission_denied" : "unauthenticated",
    "portable form authentication failed",
    response.status === 403 ? 403 : 401,
  );
}

function portableJson(
  c: Context,
  value: unknown,
  status: 200,
  key?: string,
): Response {
  const resource =
    isJsonObject(value) && isJsonObject(value.resource)
      ? (value.resource as unknown as TakoformResource)
      : (value as TakoformResource);
  if (resource.metadata?.resourceVersion) {
    // Takoform's concurrency fence is an exact strong ETag. Cloudflare turns
    // strong ETags into weak validators when it automatically compresses a
    // response, so keep version-fenced lifecycle responses untransformed.
    c.header("content-encoding", "identity");
    c.header("etag", `"${resource.metadata.resourceVersion}"`);
  }
  if (key) c.header("idempotency-key", key);
  return c.json(value, status);
}

function idempotencyKey(
  c: Context,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly response: Response } {
  const key = c.req.header("idempotency-key")?.trim();
  return key && IDEMPOTENCY_KEY_RE.test(key)
    ? { ok: true, value: key }
    : failed(c, "Idempotency-Key must be 8-128 portable characters");
}

async function executePortableIdempotentMutation(
  c: Context,
  options: RegisterPortableFormHostRoutesOptions,
  input: {
    readonly actor: ActorContext;
    readonly space: string;
    readonly idempotencyKey: string;
  },
  execute: () => Promise<Response>,
  recovery: {
    readonly resume?: () => Promise<Response>;
    readonly validateReplay?: (
      response: PortableHostSuccessWireResponse,
      request: PortableHostIdempotencyRequest,
    ) => Promise<Response | undefined>;
    readonly retainReservationOnFailure?: (
      response: Response,
    ) => Promise<boolean>;
  } = {},
): Promise<Response> {
  if (!options.idempotency) {
    return portableError(
      c,
      "backend_unavailable",
      "portable host idempotency authority is unavailable",
      503,
      true,
    );
  }
  let reserved;
  let idempotencyRequest: PortableHostIdempotencyRequest;
  try {
    const url = new URL(c.req.url);
    idempotencyRequest = {
      actor: input.actor,
      space: input.space,
      idempotencyKey: input.idempotencyKey,
      method: c.req.method,
      requestTarget: `${url.pathname}${url.search}`,
      ...(c.req.header("if-match") !== undefined
        ? { ifMatch: c.req.header("if-match") }
        : {}),
      ...(c.req.header("if-none-match") !== undefined
        ? { ifNoneMatch: c.req.header("if-none-match") }
        : {}),
      body: new Uint8Array(await c.req.raw.clone().arrayBuffer()),
    };
    reserved = await options.idempotency.reserve(idempotencyRequest);
  } catch (error) {
    if (
      error instanceof PortableHostIdempotencyError &&
      error.code === "idempotency_conflict"
    ) {
      return failed(c, error.message).response;
    }
    return portableError(
      c,
      "backend_unavailable",
      "portable host idempotency authority rejected the request",
      503,
      true,
    );
  }
  if (reserved.kind === "replay") {
    if (recovery.validateReplay) {
      const validated = await recovery.validateReplay(
        reserved.response,
        idempotencyRequest,
      );
      if (validated) return validated;
    }
    return responseFromPortableWire(reserved.response);
  }
  if (reserved.kind === "in_progress") {
    if (!recovery.resume) {
      return portableError(
        c,
        "resource_busy",
        "portable host request with this Idempotency-Key is in progress",
        409,
        true,
      );
    }
    return await finishPortableIdempotentMutation(
      c,
      options.idempotency,
      reserved.reservation,
      await recovery.resume(),
      recovery.retainReservationOnFailure,
    );
  }
  let response: Response;
  try {
    response = await execute();
  } catch (error) {
    // The reservation deliberately remains: an exception may follow an
    // ambiguous backend outcome and must not permit a second mutation.
    throw error;
  }
  if (!response.ok) {
    return await finishPortableIdempotentMutation(
      c,
      options.idempotency,
      reserved.reservation,
      response,
      recovery.retainReservationOnFailure,
    );
  }
  try {
    const stored = await options.idempotency.storeSuccess(
      reserved.reservation,
      await portableWireFromResponse(response),
    );
    return responseFromPortableWire(stored);
  } catch {
    return portableError(
      c,
      "backend_unavailable",
      "portable host idempotency success could not be recorded",
      503,
      true,
    );
  }
}

async function finishPortableIdempotentMutation(
  c: Context,
  idempotency: PortableHostIdempotencyCoordinator,
  reservation: PortableHostIdempotencyReservation,
  response: Response,
  retainReservationOnFailure:
    | ((response: Response) => Promise<boolean>)
    | undefined,
): Promise<Response> {
  if (response.ok) {
    try {
      const stored = await idempotency.storeSuccess(
        reservation,
        await portableWireFromResponse(response),
      );
      return responseFromPortableWire(stored);
    } catch {
      return portableError(
        c,
        "backend_unavailable",
        "portable host idempotency success could not be recorded",
        503,
        true,
      );
    }
  }
  // Route-specific canonical state decides whether this failed response still
  // owns an Applying/Ready mutation. Pre-claim and rolled-back failures release
  // the key so the exact request can retry normally.
  if (
    retainReservationOnFailure &&
    !(await retainReservationOnFailure(response))
  ) {
    try {
      await idempotency.release(reservation);
    } catch {
      return portableError(
        c,
        "backend_unavailable",
        "portable host idempotency failure could not be finalized",
        503,
        true,
      );
    }
  }
  return response;
}

async function portableWireFromResponse(
  response: Response,
): Promise<PortableHostSuccessWireResponse> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body: new Uint8Array(await response.clone().arrayBuffer()),
  };
}

function responseFromPortableWire(
  response: PortableHostSuccessWireResponse,
): Response {
  const headers = new Headers();
  for (const [name, value] of response.headers) headers.append(name, value);
  return new Response(response.body.slice(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withInterfaceIdempotencyRequest(
  actor: ActorContext,
  key: string,
): ActorContext {
  return { ...actor, requestId: `${actor.requestId}:${key}`.slice(0, 256) };
}

function reviewFromBody(
  c: Context,
  body: JsonObject,
):
  | { readonly ok: true; readonly value: { readonly planDigest: string } }
  | { readonly ok: false; readonly response: Response } {
  if (!isJsonObject(body.review) || !stringValue(body.review.planDigest)) {
    return failed(c, "review.planDigest from preview is required");
  }
  return { ok: true, value: { planDigest: body.review.planDigest as string } };
}

function requiredQuery(c: Context, key: string) {
  const value = c.req.query(key);
  return value
    ? { ok: true as const, value }
    : failed(c, `${key} query is required`);
}

function declarationQuery(c: Context):
  | {
      readonly ok: true;
      readonly value: {
        readonly space: string;
        readonly name?: string;
        readonly version?: string;
        readonly resourceKind?: string;
        readonly resourceName?: string;
      };
    }
  | { readonly ok: false; readonly response: Response } {
  const space = requiredQuery(c, "space");
  if (!space.ok) return space;
  const name = c.req.query("name")?.trim() || undefined;
  const version = c.req.query("version")?.trim() || undefined;
  const resourceKind = c.req.query("resourceKind")?.trim() || undefined;
  const resourceName = c.req.query("resourceName")?.trim() || undefined;
  if ((resourceKind === undefined) !== (resourceName === undefined)) {
    return failed(c, "resourceKind and resourceName must be provided together");
  }
  return {
    ok: true,
    value: {
      space: space.value,
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      ...(resourceKind && resourceName ? { resourceKind, resourceName } : {}),
    },
  };
}

function exactDeclarationQuery(c: Context):
  | {
      readonly ok: true;
      readonly value: {
        readonly space: string;
        readonly version: string;
        readonly resourceKind: string;
        readonly resourceName: string;
      };
    }
  | { readonly ok: false; readonly response: Response } {
  const query = declarationQuery(c);
  if (!query.ok) return query;
  if (
    !query.value.version ||
    !query.value.resourceKind ||
    !query.value.resourceName
  ) {
    return failed(
      c,
      "version, resourceKind, and resourceName are required for Interface writes",
    );
  }
  return {
    ok: true,
    value: {
      space: query.value.space,
      version: query.value.version,
      resourceKind: query.value.resourceKind,
      resourceName: query.value.resourceName,
    },
  };
}

const PORTABLE_INTERFACE_BODY_KEYS = new Set([
  "name",
  "version",
  "resource",
  "document",
  "documentSchema",
  "inputs",
  "resourceUriInput",
  "resourceVersion",
]);

function parseDeclarationBody(
  c: Context,
  body: JsonObject,
  identity: {
    readonly name: string;
    readonly version: string;
    readonly resourceKind: string;
    readonly resourceName: string;
  },
):
  | {
      readonly ok: true;
      readonly value: TakoformDeclaredInterface;
    }
  | { readonly ok: false; readonly response: Response } {
  for (const key of Object.keys(body)) {
    if (!PORTABLE_INTERFACE_BODY_KEYS.has(key)) {
      return failed(c, `${key} is not a portable Interface declaration field`);
    }
  }
  if (
    body.name !== identity.name ||
    body.version !== identity.version ||
    !isJsonObject(body.resource) ||
    body.resource.kind !== identity.resourceKind ||
    body.resource.name !== identity.resourceName ||
    !isJsonObject(body.document)
  ) {
    return failed(
      c,
      "body identity, Resource, and document must match the exact write address",
    );
  }
  if (body.documentSchema !== undefined && !isJsonObject(body.documentSchema)) {
    return failed(c, "documentSchema must be a JSON object");
  }
  if (body.inputs !== undefined && !Array.isArray(body.inputs)) {
    return failed(c, "inputs must be a JSON array");
  }
  if (
    body.resourceUriInput !== undefined &&
    typeof body.resourceUriInput !== "string"
  ) {
    return failed(c, "resourceUriInput must be a string");
  }
  if (
    body.resourceVersion !== undefined &&
    typeof body.resourceVersion !== "string"
  ) {
    return failed(c, "resourceVersion must be a string");
  }
  return {
    ok: true,
    value: body as unknown as TakoformDeclaredInterface,
  };
}

function interfaceIfMatch(
  c: Context,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly response: Response } {
  if (c.req.header("if-none-match") !== undefined) {
    return failed(c, "If-None-Match is not valid for Interface delete");
  }
  const raw = c.req.header("if-match")?.trim();
  const match = raw ? /^"([1-9][0-9]*)"$/u.exec(raw) : undefined;
  return match
    ? { ok: true, value: Number(match[1]) }
    : failed(c, "If-Match must contain one quoted resourceVersion");
}

function interfaceWriteError(c: Context, error: unknown): Response {
  if (!(error instanceof InterfaceServiceError)) throw error;
  switch (error.code) {
    case "invalid_argument":
      return portableError(c, "invalid_argument", error.message, 400);
    case "not_found":
      return portableError(c, "resource_not_found", error.message, 404);
    case "already_exists":
    case "conflict":
      return portableError(c, "resource_version_conflict", error.message, 412);
    case "failed_precondition":
      return portableError(c, "resource_busy", error.message, 409);
  }
}

async function readPortableDeclarations(
  c: Context,
  reader: PortableInterfaceDeclarationReader,
  input: Parameters<
    PortableInterfaceDeclarationReader["listDeclaredInterfaces"]
  >[0],
): Promise<
  | { readonly ok: true; readonly value: readonly TakoformDeclaredInterface[] }
  | { readonly ok: false; readonly response: Response }
> {
  try {
    return { ok: true, value: await reader.listDeclaredInterfaces(input) };
  } catch (error) {
    if (!(error instanceof PortableDeclarationReadLimitError)) throw error;
    return {
      ok: false,
      response: portableError(c, "invalid_argument", error.message, 400),
    };
  }
}

function pageQuery(c: Context) {
  const parsed = parsePageQuery(c.req.query("limit"), c.req.query("cursor"));
  return parsed.ok
    ? { ok: true as const, value: parsed.value }
    : failed(c, parsed.message);
}

function failed(c: Context, message: string) {
  return {
    ok: false as const,
    response: portableError(c, "invalid_argument", message, 400),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portableReplayHasStatus(
  response: PortableHostSuccessWireResponse,
): boolean {
  try {
    const body = parseCanonicalJson(response.body);
    return isJsonObject(body) && isJsonObject(body.status);
  } catch {
    return false;
  }
}
