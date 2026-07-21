// Resource Shape API routes (`takosumi.dev/v1alpha1`, Flow B).
//
// Mounted at the worker origin root alongside `/v1/capabilities`, so the thin
// `takosumi` OpenTofu provider reaches `{origin}/v1/resources/{Kind}/{name}`
// after capability discovery. The routes are a thin HTTP shell over
// {@link ResourceShapeService}; resolution, locking, persistence, and adapter
// dispatch live in the domain.

import type { Context, Hono } from "hono";
import type {
  ActorContext,
  InstalledFormReference,
  JsonObject,
  ResourceArtifactWriteScope,
  ResourceManagedBy,
  ResourceShapeKind,
  SpacePolicySpec,
  TargetPoolSpec,
} from "takosumi-contract";
import {
  isInstalledFormReference,
  isResourceShapeKind,
} from "takosumi-contract";
import type { PageParams } from "takosumi-contract/pagination";
import { apiError, readJsonObject, requestIdFromContext } from "./errors.ts";
import type { ApiEndpoint } from "./route_families.ts";
import { constantTimeEqualsString } from "../shared/constant_time.ts";
import { parsePageQuery } from "./page_query.ts";
import {
  type PortableInterfaceDeclarationReader,
  registerPortableFormHostRoutes,
} from "./form_host_routes.ts";
import {
  type ApplyResourceRequest,
  formatResourceShapeId,
  type ResourceArtifactService,
  type ResourceArtifactServiceErrorCode,
  type ResourceServiceErrorCode,
  type ResourceShapeService,
} from "../domains/resource-shape/mod.ts";

/**
 * Trusted in-process authoring-surface identity. Public ingress must strip this
 * header before setting its own value; a deploy-control bearer is operator
 * authority and may instead declare `metadata.managedBy` explicitly.
 */
export const TAKOSUMI_INTERNAL_RESOURCE_MANAGED_BY_HEADER =
  "x-takosumi-resource-managed-by";

export interface RegisterResourceShapeRoutesOptions {
  readonly service: ResourceShapeService;
  /** Optional canonical byte ingress backed by a host-installed artifact writer. */
  readonly artifactService?: ResourceArtifactService;
  readonly interfaceDeclarations?: PortableInterfaceDeclarationReader;
  /**
   * Optional portable declaration read (ADR 0002). Omitted means this host
   * serves no portable declarations and does not advertise the feature.
   */
  readonly interfaceDeclarations?: PortableInterfaceDeclarationReader;
  /**
   * Public Resource Shape kinds this host exposes for preview/apply/import and
   * refresh. Omitted means no new desired-state authority.
   */
  readonly enabledResourceShapeKinds?: readonly ResourceShapeKind[];
  /**
   * Installed compatibility schemas that may read, observe, or delete retained
   * state even when new desired state for that kind is disabled. Omitted means
   * none. This preserves supported state without making it creation authority.
   */
  readonly installedResourceShapeKinds?: readonly ResourceShapeKind[];
  /**
   * Resolves the acting principal for a request. Defaults to a single-tenant
   * self-host owner actor; operator/Cloud composition injects real auth.
   */
  readonly resolveActor?: (c: Context) => ActorContext | Promise<ActorContext>;
  /**
   * Bearer used by self-host/operator deployments that expose the Resource
   * Shape API directly. When omitted, the routes retain the single-tenant local
   * default for tests and explicit unsafe dev setups.
   */
  readonly getResourceShapeBearerToken?: () => string | undefined;
  /**
   * Optional scoped bearer resolver supplied by an operator/account plane. It
   * receives the raw bearer and returns the request actor when allowed.
   */
  readonly authorizeResourceShapeBearer?: (input: {
    readonly token: string;
    readonly request: Request;
  }) => ActorContext | undefined | Promise<ActorContext | undefined>;
  /**
   * Break-glass Resource tombstone authorization. Omitted means force deletes
   * are not exposed over HTTP; operator compositions must explicitly opt in.
   */
  readonly authorizeResourceShapeForceDelete?: (input: {
    readonly actor: ActorContext;
    readonly request: Request;
    readonly space: string;
    readonly kind: ResourceShapeKind;
    readonly name: string;
  }) => boolean | Promise<boolean>;
}

/** Single-source route inventory for capabilities and OpenAPI publication. */
export const RESOURCE_SHAPE_ENDPOINTS: readonly ApiEndpoint[] = [
  endpoint("GET", "/v1/form-availability", "listFormAvailability", {
    okSchema: "ListFormAvailabilityResponse",
    query: [
      "space",
      "apiVersion",
      "kind",
      "definitionVersion",
      "schemaDigest",
      "packageDigest",
      "limit",
      "cursor",
    ],
  }),
  endpoint("POST", "/v1/resources/preview", "previewResource", {
    okSchema: "ResourceShapePreviewResponse",
  }),
  endpoint("PUT", "/v1/resources/:kind/:name", "putResource", {
    requestSchema: "ResourceShapeApplyRequest",
  }),
  endpoint(
    "POST",
    "/v1/resources/:kind/:name/artifacts",
    "stageResourceArtifact",
    {
      okSchema: "ResourceArtifactStageResponse",
      query: ["space"],
      requestBody: {
        required: true,
        content: {
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        },
      },
    },
  ),
  endpoint("POST", "/v1/resources/:kind/:name/import", "importResource", {
    requestSchema: "ResourceShapeImportRequest",
    okSchema: "ResourceShapeImportResponse",
  }),
  endpoint("GET", "/v1/resources/:kind/:name", "getResource", {
    query: ["space"],
  }),
  endpoint("GET", "/v1/resources/:kind/:name/events", "listResourceEvents", {
    okSchema: "ListResourceEventsResponse",
    query: ["space", "limit", "cursor"],
  }),
  endpoint("POST", "/v1/resources/:kind/:name/observe", "observeResource", {
    query: ["space"],
  }),
  endpoint("POST", "/v1/resources/:kind/:name/refresh", "refreshResource", {
    query: ["space"],
  }),
  endpoint("GET", "/v1/resources", "listResources", {
    okSchema: "ListResourceShapesResponse",
    query: ["space", "limit", "cursor"],
  }),
  endpoint("DELETE", "/v1/resources/:kind/:name", "deleteResource", {
    query: ["space", "force", "managedBy"],
  }),
  endpoint("PUT", "/v1/target-pools/:name", "putTargetPool", {
    okSchema: "TargetPoolResponse",
    alternateOkStatuses: ["201"],
  }),
  endpoint("GET", "/v1/target-pools/:name", "getTargetPool", {
    okSchema: "TargetPoolResponse",
    query: ["space"],
  }),
  endpoint("GET", "/v1/target-pools", "listTargetPools", {
    okSchema: "ListTargetPoolsResponse",
    query: ["space", "limit", "cursor"],
  }),
  endpoint("DELETE", "/v1/target-pools/:name", "deleteTargetPool", {
    query: ["space"],
  }),
  endpoint("PUT", "/v1/space-policies/:name", "putSpacePolicy", {
    okSchema: "SpacePolicyResponse",
  }),
  endpoint("GET", "/v1/space-policies/:name", "getSpacePolicy", {
    okSchema: "SpacePolicyResponse",
    query: ["space"],
  }),
  endpoint("GET", "/v1/space-policies", "listSpacePolicies", {
    okSchema: "ListSpacePoliciesResponse",
    query: ["space", "limit", "cursor"],
  }),
  endpoint("DELETE", "/v1/space-policies/:name", "deleteSpacePolicy", {
    query: ["space"],
  }),
] as const;

export function registerResourceShapeRoutes(
  app: Hono,
  options: RegisterResourceShapeRoutesOptions,
): void {
  const { service } = options;
  const enabledKinds = new Set<ResourceShapeKind>(
    options.enabledResourceShapeKinds ?? [],
  );
  const installedKinds = new Set<ResourceShapeKind>(
    options.installedResourceShapeKinds ?? [],
  );
  for (const kind of enabledKinds) {
    if (!installedKinds.has(kind)) {
      throw new TypeError(
        `enabled Resource Shape kind is not backed by an installed compatibility schema: ${kind}`,
      );
    }
  }

  registerPortableFormHostRoutes(app, {
    service,
    availability: service,
    authorize: (c) => authorizeResourceShapeRequest(c, options),
    canReadForms: hasFormAvailabilityReadScope,
    ...(options.interfaceDeclarations
      ? { interfaceDeclarations: options.interfaceDeclarations }
      : {}),
  });

  app.get("/v1/form-availability", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    if (!hasFormAvailabilityReadScope(auth.actor)) {
      return c.json(
        apiError(
          "permission_denied",
          "form availability requires forms:read or resources:read scope",
          undefined,
          requestIdFromContext(c),
        ),
        403,
      );
    }
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const identity = parseAvailabilityIdentity(c);
    if ("response" in identity) return identity.response;
    const page = parseResourcePageQuery(c);
    if ("response" in page) return page.response;
    const result = await service.listFormAvailability({
      actor: auth.actor,
      space: space.value,
      ...(identity.value ? { identity: identity.value } : {}),
      page: page.value,
    });
    return c.json(
      {
        forms: result.items,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      },
      200,
    );
  });

  app.post("/v1/resources/preview", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const parsed = await parseResourceBody(c, auth.actor);
    if ("response" in parsed) return parsed.response;
    const result = await service.preview(parsed.request);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.value, 200);
  });

  app.put("/v1/resources/:kind/:name", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const parsed = await parseResourceBody(c, auth.actor);
    if ("response" in parsed) return parsed.response;
    const review = parseDeploymentReview(c, parsed.body);
    if ("response" in review) return review.response;
    const result = await service.apply(parsed.request, review.value);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(withId(parsed.request, result.value), 200);
  });

  if (options.artifactService) {
    app.post("/v1/resources/:kind/:name/artifacts", async (c) => {
      const auth = await authorizeResourceShape(c, options);
      if (!auth.ok) return auth.response;
      if (!hasResourceArtifactWriteScope(auth.actor)) {
        return c.json(
          apiError(
            "permission_denied",
            "artifact staging requires resources:write scope",
            undefined,
            requestIdFromContext(c),
          ),
          403,
        );
      }
      const kind = parseKind(c, enabledKinds);
      if ("response" in kind) return kind.response;
      const space = requireQuery(c, "space");
      if ("response" in space) return space.response;
      if (
        auth.actor.workspaceId !== undefined &&
        auth.actor.workspaceId !== space.value
      ) {
        return c.json(
          apiError(
            "forbidden",
            "actor Workspace does not match Resource Space",
            undefined,
            requestIdFromContext(c),
          ),
          403,
        );
      }
      const name = c.req.param("name");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
        return badRequest(c, "invalid resource name");
      }
      const purpose = c.req.header("x-takosumi-artifact-purpose")?.trim();
      const digest = c.req.header("x-takosumi-artifact-sha256")?.trim();
      const idempotencyKey = c.req.header("idempotency-key")?.trim();
      const contentType = c.req.header("content-type")?.trim();
      const contentEncoding = c.req.header("content-encoding")?.trim();
      if (!purpose) {
        return badRequest(c, "X-Takosumi-Artifact-Purpose is required");
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(purpose)) {
        return badRequest(c, "X-Takosumi-Artifact-Purpose is invalid");
      }
      if (!digest || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
        return badRequest(
          c,
          "X-Takosumi-Artifact-Sha256 must be a lowercase sha256 digest",
        );
      }
      if (!idempotencyKey) {
        return badRequest(c, "Idempotency-Key is required");
      }
      if (
        idempotencyKey.length < 8 ||
        idempotencyKey.length > 128 ||
        /[^\x21-\x7e]/u.test(idempotencyKey)
      ) {
        return badRequest(c, "Idempotency-Key is invalid");
      }
      if (!contentType) return badRequest(c, "Content-Type is required");
      if (contentType.length > 255 || /[^\x21-\x7e]/u.test(contentType)) {
        return badRequest(c, "Content-Type is invalid");
      }
      if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
        return badRequest(c, "compressed Content-Encoding is not supported");
      }

      const scope: ResourceArtifactWriteScope = {
        workspaceId: space.value,
        resourceId: formatResourceShapeId(space.value, kind.value, name),
        resourceKind: kind.value,
        resourceName: name,
        actorAccountId: auth.actor.actorAccountId,
        purpose,
        contentType,
      };
      const admitted = await options.artifactService!.maximumBytes(scope);
      if (!admitted.ok) {
        return resourceArtifactErrorResponse(c, admitted.error);
      }
      const body = await readBoundedBytes(c.req.raw, admitted.value);
      if (!body.ok) {
        return c.json(
          apiError(
            "payload_too_large",
            `artifact exceeds the host limit of ${admitted.value} bytes`,
            undefined,
            requestIdFromContext(c),
          ),
          413,
        );
      }
      const result = await options.artifactService!.stage({
        actor: auth.actor,
        space: space.value,
        kind: kind.value,
        name,
        purpose,
        contentType,
        expectedDigest: digest as `sha256:${string}`,
        idempotencyKey,
        bytes: body.value,
      });
      if (!result.ok) return resourceArtifactErrorResponse(c, result.error);
      c.header("cache-control", "no-store");
      c.header("idempotency-key", idempotencyKey);
      return c.json(result.value, 200);
    });
  }

  app.post("/v1/resources/:kind/:name/import", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const parsed = await parseResourceBody(c, auth.actor);
    if ("response" in parsed) return parsed.response;
    const nativeId = stringField(parsed.body, "nativeId");
    if (!nativeId) return badRequest(c, "nativeId is required");
    const result = await service.importResource({
      ...parsed.request,
      nativeId,
    });
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(
      {
        ...withId(parsed.request, result.value.resource),
        import: result.value.import,
      },
      200,
    );
  });

  app.get("/v1/resources/:kind/:name", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const kind = parseKind(c, installedKinds);
    if ("response" in kind) return kind.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const result = await service.get(
      space.value,
      kind.value,
      c.req.param("name"),
    );
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(
      {
        id: formatResourceShapeId(space.value, kind.value, c.req.param("name")),
        ...result.value,
      },
      200,
    );
  });

  app.get("/v1/resources/:kind/:name/events", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const kind = parseKind(c, installedKinds);
    if ("response" in kind) return kind.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const page = parseResourcePageQuery(c);
    if ("response" in page) return page.response;
    const result = await service.listEvents(
      space.value,
      kind.value,
      c.req.param("name"),
      page.value,
    );
    return c.json(
      {
        events: result.items,
        ...(result.nextCursor !== undefined
          ? { nextCursor: result.nextCursor }
          : {}),
      },
      200,
    );
  });

  app.post("/v1/resources/:kind/:name/observe", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const kind = parseKind(c, installedKinds);
    if ("response" in kind) return kind.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const result = await service.observe(
      space.value,
      kind.value,
      c.req.param("name"),
      auth.actor,
    );
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(
      {
        id: formatResourceShapeId(space.value, kind.value, c.req.param("name")),
        ...result.value.resource,
        observation: result.value.observation,
      },
      200,
    );
  });

  app.post("/v1/resources/:kind/:name/refresh", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const kind = parseKind(c, enabledKinds);
    if ("response" in kind) return kind.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const result = await service.refresh(
      space.value,
      kind.value,
      c.req.param("name"),
      auth.actor,
    );
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(
      {
        id: formatResourceShapeId(space.value, kind.value, c.req.param("name")),
        ...result.value.resource,
        refresh: result.value.refresh,
      },
      200,
    );
  });

  app.get("/v1/resources", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const page = parseResourcePageQuery(c);
    if ("response" in page) return page.response;
    const result = await service.listPage(space.value, page.value);
    return c.json(
      {
        resources: result.items,
        ...(result.nextCursor !== undefined
          ? { nextCursor: result.nextCursor }
          : {}),
      },
      200,
    );
  });

  app.delete("/v1/resources/:kind/:name", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const kind = parseKind(c, installedKinds);
    if ("response" in kind) return kind.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const force = isTruthyQuery(c.req.query("force"));
    const trustedManagedBy = trustedResourceManagedBy(c);
    const requestedManagedBy = c.req.query("managedBy");
    if (
      trustedManagedBy &&
      requestedManagedBy &&
      requestedManagedBy !== trustedManagedBy
    ) {
      return managedByMismatchResponse(c, requestedManagedBy, trustedManagedBy);
    }
    if (force) {
      const allowed = await options.authorizeResourceShapeForceDelete?.({
        actor: auth.actor,
        request: c.req.raw,
        space: space.value,
        kind: kind.value,
        name: c.req.param("name"),
      });
      if (allowed !== true) {
        return c.json(
          apiError(
            "forbidden",
            "resource force delete requires operator break-glass authorization",
            undefined,
            requestIdFromContext(c),
          ),
          403,
        );
      }
    }
    const result = await service.delete(
      space.value,
      kind.value,
      c.req.param("name"),
      auth.actor,
      {
        force,
        expectedManagedBy: trustedManagedBy ?? requestedManagedBy ?? "opentofu",
      },
    );
    if (!result.ok) return errorResponse(c, result.error);
    return c.body(null, 204);
  });

  app.put("/v1/target-pools/:name", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const body = await readJsonObject(c.req.raw);
    const space = stringField(body, "space");
    if (!space) return badRequest(c, "space is required");
    const spec = (body.spec ?? {
      targets: body.targets ?? [],
    }) as TargetPoolSpec;
    const ifNoneMatch = c.req.header("if-none-match")?.trim();
    if (ifNoneMatch !== undefined && ifNoneMatch !== "*") {
      return badRequest(
        c,
        "If-None-Match on TargetPool PUT supports only the create-only '*' precondition",
      );
    }
    const result =
      ifNoneMatch === "*"
        ? await service.createTargetPool(space, c.req.param("name"), spec)
        : await service.putTargetPool(space, c.req.param("name"), spec);
    if (!result.ok && result.error.code === "target_pool_exists") {
      return c.json(
        apiError(
          result.error.code,
          result.error.message,
          undefined,
          requestIdFromContext(c),
        ),
        412,
      );
    }
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.value, ifNoneMatch === "*" ? 201 : 200);
  });

  app.get("/v1/target-pools", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const page = parseResourcePageQuery(c);
    if ("response" in page) return page.response;
    const result = await service.listTargetPoolsPage(space.value, page.value);
    return c.json(
      {
        targetPools: result.items,
        ...(result.nextCursor !== undefined
          ? { nextCursor: result.nextCursor }
          : {}),
      },
      200,
    );
  });

  app.get("/v1/target-pools/:name", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const record = await service.getTargetPool(
      space.value,
      c.req.param("name"),
    );
    if (!record) {
      return errorResponse(c, {
        code: "not_found",
        message: "TargetPool was not found in this space",
      });
    }
    return c.json(record, 200);
  });

  app.delete("/v1/target-pools/:name", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const result = await service.deleteTargetPool(
      space.value,
      c.req.param("name"),
    );
    if (!result.ok) return errorResponse(c, result.error);
    return c.body(null, 204);
  });

  app.put("/v1/space-policies/:name", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const body = await readJsonObject(c.req.raw);
    const space = stringField(body, "space");
    if (!space) return badRequest(c, "space is required");
    const spec = (body.spec ?? body) as SpacePolicySpec;
    const record = await service.putSpacePolicy(
      space,
      c.req.param("name"),
      spec,
    );
    return c.json(record, 200);
  });

  app.get("/v1/space-policies", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const page = parseResourcePageQuery(c);
    if ("response" in page) return page.response;
    const result = await service.listSpacePoliciesPage(space.value, page.value);
    return c.json(
      {
        spacePolicies: result.items,
        ...(result.nextCursor !== undefined
          ? { nextCursor: result.nextCursor }
          : {}),
      },
      200,
    );
  });

  app.get("/v1/space-policies/:name", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const record = await service.getSpacePolicy(
      space.value,
      c.req.param("name"),
    );
    if (!record) {
      return errorResponse(c, {
        code: "not_found",
        message: "SpacePolicy was not found in this space",
      });
    }
    return c.json(record, 200);
  });

  app.delete("/v1/space-policies/:name", async (c) => {
    const auth = await authorizeResourceShape(c, options);
    if (!auth.ok) return auth.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    await service.deleteSpacePolicy(space.value, c.req.param("name"));
    return c.body(null, 204);
  });

  async function parseResourceBody(
    c: Context,
    actor: ActorContext,
  ): Promise<
    | {
        readonly request: ApplyResourceRequest;
        readonly body: Record<string, unknown>;
      }
    | { readonly response: Response }
  > {
    const body = await readJsonObject(c.req.raw);
    const kind = parseKindFromBodyOrParam(c, body, enabledKinds);
    if ("response" in kind) return kind;
    const metadata = (body.metadata ?? {}) as Record<string, unknown>;
    const requestedManagedBy = stringValue(metadata.managedBy);
    const trustedManagedBy = trustedResourceManagedBy(c);
    if (
      trustedManagedBy &&
      requestedManagedBy &&
      requestedManagedBy !== trustedManagedBy
    ) {
      return {
        response: managedByMismatchResponse(
          c,
          requestedManagedBy,
          trustedManagedBy,
        ),
      };
    }
    const spec = (body.spec ?? {}) as JsonObject;
    const rawForm = body.form;
    if (rawForm !== undefined && !isInstalledFormReference(rawForm)) {
      return {
        response: badRequest(
          c,
          "form must be an exact InstalledFormReference with formRef and packageDigest",
        ),
      };
    }
    const form = rawForm as InstalledFormReference | undefined;
    const pathName = c.req.param("name");
    const metadataName = stringValue(metadata.name);
    const specName = stringValue((spec as Record<string, unknown>).name);
    if (pathName && metadataName && pathName !== metadataName) {
      return {
        response: badRequest(
          c,
          `path resource name ${pathName} does not match metadata.name ${metadataName}`,
        ),
      };
    }
    if (pathName && specName && pathName !== specName) {
      return {
        response: badRequest(
          c,
          `path resource name ${pathName} does not match spec.name ${specName}`,
        ),
      };
    }
    if (metadataName && specName && metadataName !== specName) {
      return {
        response: badRequest(
          c,
          `metadata.name ${metadataName} does not match spec.name ${specName}`,
        ),
      };
    }
    const name =
      c.req.param("name") ??
      stringValue(metadata.name) ??
      stringValue((spec as Record<string, unknown>).name);
    if (!name) return { response: badRequest(c, "resource name is required") };
    const space = stringValue(metadata.space) ?? stringField(body, "space");
    if (!space)
      return { response: badRequest(c, "metadata.space is required") };
    return {
      body,
      request: {
        actor,
        space,
        project: stringValue(metadata.project),
        environment: stringValue(metadata.environment),
        kind: kind.value,
        form,
        name,
        spec,
        managedBy: trustedManagedBy ?? requestedManagedBy,
        labels: metadata.labels as Record<string, string> | undefined,
        targetPoolName: stringField(body, "targetPoolName"),
        spacePolicyName: stringField(body, "spacePolicyName"),
      },
    };
  }
}

// --- helpers ------------------------------------------------------------------

async function resolveActor(
  c: Context,
  options: RegisterResourceShapeRoutesOptions,
): Promise<ActorContext> {
  if (options.resolveActor) return options.resolveActor(c);
  return {
    actorAccountId: "self-host",
    roles: ["owner"],
    requestId: requestIdFromContext(c),
  };
}

type ResourceShapeAuthResult =
  | { readonly ok: true; readonly actor: ActorContext }
  | { readonly ok: false; readonly response: Response };

export async function authorizeResourceShapeRequest(
  c: Context,
  options: RegisterResourceShapeRoutesOptions,
): Promise<ResourceShapeAuthResult> {
  const configuredToken = options.getResourceShapeBearerToken?.();
  if (!configuredToken && !options.authorizeResourceShapeBearer) {
    return { ok: true, actor: await resolveActor(c, options) };
  }

  const bearer = bearerTokenFromAuthorization(c.req.header("authorization"));
  if (!bearer) return invalidResourceShapeBearer(c);

  if (options.authorizeResourceShapeBearer) {
    const actor = await options.authorizeResourceShapeBearer({
      token: bearer,
      request: c.req.raw,
    });
    if (actor) return { ok: true, actor };
    return invalidResourceShapeBearer(c);
  }

  if (!configuredToken || !constantTimeEqualsString(bearer, configuredToken)) {
    return invalidResourceShapeBearer(c);
  }
  return { ok: true, actor: await resolveActor(c, options) };
}

const authorizeResourceShape = authorizeResourceShapeRequest;

function bearerTokenFromAuthorization(
  value: string | undefined,
): string | undefined {
  const prefix = "Bearer ";
  return value?.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function invalidResourceShapeBearer(c: Context): ResourceShapeAuthResult {
  return {
    ok: false,
    response: c.json(
      apiError(
        "unauthenticated",
        "invalid resource shape bearer",
        undefined,
        requestIdFromContext(c),
      ),
      401,
    ),
  };
}

export function hasFormAvailabilityReadScope(actor: ActorContext): boolean {
  if (actor.scopes === undefined) return true;
  const scopes = new Set(actor.scopes);
  return (
    scopes.has("*") ||
    scopes.has("forms:read") ||
    scopes.has("resources:read") ||
    scopes.has("resources:*") ||
    // Platform session/PAT scope vocabulary. These remain authenticated
    // read/admin grants, not an unscoped fallback.
    scopes.has("read") ||
    scopes.has("admin")
  );
}

export function hasResourceArtifactWriteScope(actor: ActorContext): boolean {
  if (actor.scopes === undefined) return true;
  const scopes = new Set(actor.scopes);
  return (
    scopes.has("*") ||
    scopes.has("admin") ||
    scopes.has("write") ||
    scopes.has("resources:write") ||
    scopes.has("resources:*") ||
    scopes.has("capsules:write")
  );
}

async function readBoundedBytes(
  request: Request,
  maxBytes: number,
): Promise<
  { readonly ok: true; readonly value: Uint8Array } | { readonly ok: false }
> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, value: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("artifact exceeds host limit");
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: bytes };
}

function resourceArtifactErrorResponse(
  c: Context,
  error: {
    readonly code: ResourceArtifactServiceErrorCode;
    readonly message: string;
  },
): Response {
  const status = resourceArtifactErrorStatus(error.code);
  return c.json(
    apiError(error.code, error.message, undefined, requestIdFromContext(c)),
    status,
  );
}

function resourceArtifactErrorStatus(
  code: ResourceArtifactServiceErrorCode,
): 400 | 409 | 413 | 502 | 503 {
  switch (code) {
    case "artifact_invalid":
    case "artifact_digest_mismatch":
      return 400;
    case "artifact_not_supported":
    case "artifact_idempotency_conflict":
      return 409;
    case "artifact_too_large":
      return 413;
    case "artifact_writer_invalid":
      return 502;
    case "artifact_writer_failed":
      return 503;
  }
}

function parseAvailabilityIdentity(
  c: Context,
):
  | { readonly value: InstalledFormReference | undefined }
  | { readonly response: Response } {
  const fields = {
    apiVersion: c.req.query("apiVersion"),
    kind: c.req.query("kind"),
    definitionVersion: c.req.query("definitionVersion"),
    schemaDigest: c.req.query("schemaDigest"),
    packageDigest: c.req.query("packageDigest"),
  };
  const provided = Object.values(fields).filter(
    (value) => value !== undefined,
  ).length;
  if (provided === 0) return { value: undefined };
  if (provided !== Object.keys(fields).length) {
    return {
      response: badRequest(
        c,
        "exact availability lookup requires apiVersion, kind, definitionVersion, schemaDigest, and packageDigest",
      ),
    };
  }
  const identity = {
    formRef: {
      apiVersion: fields.apiVersion!,
      kind: fields.kind!,
      definitionVersion: fields.definitionVersion!,
      schemaDigest: fields.schemaDigest!,
    },
    packageDigest: fields.packageDigest!,
  };
  return isInstalledFormReference(identity)
    ? { value: identity }
    : {
        response: badRequest(
          c,
          "availability identity must be an exact InstalledFormReference",
        ),
      };
}

function withId(req: ApplyResourceRequest, value: object): object {
  return { id: formatResourceShapeId(req.space, req.kind, req.name), ...value };
}

function isResourceKindToken(value: string): value is ResourceShapeKind {
  return isResourceShapeKind(value);
}

function parseKind(
  c: Context,
  enabledKinds: ReadonlySet<ResourceShapeKind>,
): { readonly value: ResourceShapeKind } | { readonly response: Response } {
  const kind = c.req.param("kind");
  if (!kind || !isResourceKindToken(kind)) {
    return { response: badRequest(c, `invalid resource kind: ${kind}`) };
  }
  if (!enabledKinds.has(kind)) {
    return { response: badRequest(c, `resource kind is not enabled: ${kind}`) };
  }
  return { value: kind };
}

function parseKindFromBodyOrParam(
  c: Context,
  body: Record<string, unknown>,
  enabledKinds: ReadonlySet<ResourceShapeKind>,
): { readonly value: ResourceShapeKind } | { readonly response: Response } {
  const fromParam = c.req.param("kind");
  if (fromParam) {
    const fromBody = stringField(body, "kind");
    if (fromBody && fromBody !== fromParam) {
      return {
        response: badRequest(
          c,
          `path resource kind ${fromParam} does not match body kind ${fromBody}`,
        ),
      };
    }
    return parseKind(c, enabledKinds);
  }
  const fromBody = stringField(body, "kind");
  if (!fromBody || !isResourceKindToken(fromBody)) {
    return { response: badRequest(c, `invalid resource kind: ${fromBody}`) };
  }
  if (!enabledKinds.has(fromBody)) {
    return {
      response: badRequest(c, `resource kind is not enabled: ${fromBody}`),
    };
  }
  return { value: fromBody };
}

function requireQuery(
  c: Context,
  key: string,
): { readonly value: string } | { readonly response: Response } {
  const value = c.req.query(key);
  if (!value) return { response: badRequest(c, `${key} query is required`) };
  return { value };
}

function parseResourcePageQuery(
  c: Context,
): { readonly value: PageParams } | { readonly response: Response } {
  const parsed = parsePageQuery(c.req.query("limit"), c.req.query("cursor"));
  return parsed.ok
    ? { value: parsed.value }
    : { response: badRequest(c, parsed.message) };
}

function stringField(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  return stringValue(body[key]);
}

function parseDeploymentReview(
  c: Context,
  body: Record<string, unknown>,
):
  | {
      readonly value: {
        readonly planDigest: string;
        readonly quoteId?: string;
        readonly quoteDigest?: string;
      };
    }
  | { readonly response: Response } {
  const raw = body.review;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      response: badRequest(
        c,
        "deployment review from POST /v1/resources/preview is required",
      ),
    };
  }
  const review = raw as Record<string, unknown>;
  const planDigest = stringField(review, "planDigest");
  if (!planDigest) {
    return { response: badRequest(c, "review.planDigest is required") };
  }
  const quoteId = stringField(review, "quoteId");
  const quoteDigest = stringField(review, "quoteDigest");
  if (Boolean(quoteId) !== Boolean(quoteDigest)) {
    return {
      response: badRequest(
        c,
        "review.quoteId and review.quoteDigest must be provided together",
      ),
    };
  }
  return {
    value: {
      planDigest,
      ...(quoteId ? { quoteId } : {}),
      ...(quoteDigest ? { quoteDigest } : {}),
    },
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function trustedResourceManagedBy(c: Context): ResourceManagedBy | undefined {
  return stringValue(
    c.req.header(TAKOSUMI_INTERNAL_RESOURCE_MANAGED_BY_HEADER),
  );
}

function managedByMismatchResponse(
  c: Context,
  requested: ResourceManagedBy,
  trusted: ResourceManagedBy,
): Response {
  return c.json(
    apiError(
      "forbidden",
      `managedBy ${requested} does not match the trusted authoring surface ${trusted}`,
      undefined,
      requestIdFromContext(c),
    ),
    403,
  );
}

function isTruthyQuery(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function badRequest(c: Context, message: string): Response {
  return c.json(
    apiError("invalid_argument", message, undefined, requestIdFromContext(c)),
    400,
  );
}

function errorResponse(
  c: Context,
  error: { readonly code: ResourceServiceErrorCode; readonly message: string },
): Response {
  return c.json(
    apiError(error.code, error.message, undefined, requestIdFromContext(c)),
    httpStatusForServiceError(error.code),
  );
}

function httpStatusForServiceError(
  code: ResourceServiceErrorCode,
): 400 | 402 | 404 | 409 | 502 {
  switch (code) {
    case "invalid_form_ref":
    case "invalid_spec":
    case "invalid_name":
    case "invalid_interfaces":
    case "invalid_interface":
    case "invalid_protocols":
    case "invalid_protocol":
    case "invalid_consistency":
    case "invalid_delivery":
    case "invalid_engine":
    case "invalid_migrations_path":
    case "invalid_image":
    case "invalid_ports":
    case "invalid_public_http":
    case "invalid_environment":
    case "invalid_compatibility_date":
    case "invalid_runtime":
    case "invalid_profile":
    case "invalid_source":
    case "invalid_connections":
    case "invalid_model_policy":
    case "invalid_lifecycle_policy":
    case "invalid_delete_policy":
    case "invalid_target_pool":
    case "invalid_import":
    case "unsupported_shape":
    case "deployment_quote_invalid":
      return 400;
    case "target_pool_not_found":
    case "connection_not_found":
    case "not_found":
      return 404;
    case "policy_denied":
    case "form_registry_unavailable":
    case "form_not_installed":
    case "form_not_activated":
    case "form_identity_conflict":
    case "target_pool_exists":
    case "target_pool_in_use":
    case "capability_missing":
    case "selected_target_missing":
    case "resolution_descriptor_missing":
    case "connection_not_ready":
    case "delete_blocked":
    case "observe_blocked":
    case "refresh_blocked":
    case "import_conflict":
    case "ownership_conflict":
    case "reconcile_conflict":
    case "resource_version_conflict":
    case "deployment_review_required":
    case "deployment_plan_changed":
      return 409;
    case "deployment_admission_denied":
      return 402;
    case "apply_failed":
    case "deployment_finalize_pending":
    case "deployment_billing_finalize_failed":
    case "observe_failed":
    case "refresh_failed":
    case "import_failed":
    case "delete_failed":
      return 502;
  }
}

function endpoint(
  method: ApiEndpoint["method"],
  path: string,
  operationId: string,
  openapi: Partial<ApiEndpoint["openapi"]> = {},
): ApiEndpoint {
  const { okSchema = "ResourceShapeResponse", ...openapiOptions } = openapi;
  const pathParams = [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(
    (match) => match[1]!,
  );
  return {
    method,
    path,
    summary: `Resource Shape API: ${operationId}`,
    auth: "deploy-control-token",
    operationId,
    tag: "resource-shape",
    openapi: {
      okSchema,
      ...(method === "DELETE" ? { okStatus: "204" as const } : {}),
      ...(pathParams.length > 0 ? { pathParams } : {}),
      ...openapiOptions,
    },
  };
}
