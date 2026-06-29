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
  JsonObject,
  ResourceShapeKind,
  SpacePolicySpec,
  TargetPoolSpec,
} from "takosumi-contract";
import { RESOURCE_SHAPE_KINDS } from "takosumi-contract";
import { apiError, readJsonObject, requestIdFromContext } from "./errors.ts";
import type { ApiEndpoint } from "./route_families.ts";
import {
  type ApplyResourceRequest,
  formatResourceShapeId,
  type ResourceServiceErrorCode,
  type ResourceShapeService,
} from "../domains/resource-shape/mod.ts";

export interface RegisterResourceShapeRoutesOptions {
  readonly service: ResourceShapeService;
  /**
   * Resolves the acting principal for a request. Defaults to a single-tenant
   * self-host owner actor; operator/Cloud composition injects real auth.
   */
  readonly resolveActor?: (
    c: Context,
  ) => ActorContext | Promise<ActorContext>;
}

/** Route inventory for the resource-shape family (not yet OpenAPI-published). */
export const RESOURCE_SHAPE_ENDPOINTS: readonly ApiEndpoint[] = [
  endpoint("POST", "/v1/resources/preview", "previewResource"),
  endpoint("PUT", "/v1/resources/:kind/:name", "putResource"),
  endpoint("GET", "/v1/resources/:kind/:name", "getResource"),
  endpoint("GET", "/v1/resources", "listResources"),
  endpoint("DELETE", "/v1/resources/:kind/:name", "deleteResource"),
  endpoint("PUT", "/v1/target-pools/:name", "putTargetPool"),
  endpoint("GET", "/v1/target-pools", "listTargetPools"),
  endpoint("PUT", "/v1/space-policies/:name", "putSpacePolicy"),
] as const;

export function registerResourceShapeRoutes(
  app: Hono,
  options: RegisterResourceShapeRoutesOptions,
): void {
  const { service } = options;

  app.post("/v1/resources/preview", async (c) => {
    const parsed = await parseResourceBody(c);
    if ("response" in parsed) return parsed.response;
    const result = await service.preview(parsed.request);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.value, 200);
  });

  app.put("/v1/resources/:kind/:name", async (c) => {
    const parsed = await parseResourceBody(c);
    if ("response" in parsed) return parsed.response;
    const result = await service.apply(parsed.request);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(withId(parsed.request, result.value), 200);
  });

  app.get("/v1/resources/:kind/:name", async (c) => {
    const kind = parseKind(c);
    if ("response" in kind) return kind.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const result = await service.get(space.value, kind.value, c.req.param("name"));
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(
      { id: formatResourceShapeId(space.value, kind.value, c.req.param("name")), ...result.value },
      200,
    );
  });

  app.get("/v1/resources", async (c) => {
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const resources = await service.list(space.value);
    return c.json({ resources }, 200);
  });

  app.delete("/v1/resources/:kind/:name", async (c) => {
    const kind = parseKind(c);
    if ("response" in kind) return kind.response;
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const actor = await resolveActor(c, options);
    const result = await service.delete(
      space.value,
      kind.value,
      c.req.param("name"),
      actor,
    );
    if (!result.ok) return errorResponse(c, result.error);
    return c.body(null, 204);
  });

  app.put("/v1/target-pools/:name", async (c) => {
    const body = await readJsonObject(c.req.raw);
    const space = stringField(body, "space");
    if (!space) return badRequest(c, "space is required");
    const spec = (body.spec ?? { targets: body.targets ?? [] }) as TargetPoolSpec;
    const record = await service.putTargetPool(space, c.req.param("name"), spec);
    return c.json(record, 200);
  });

  app.get("/v1/target-pools", async (c) => {
    const space = requireQuery(c, "space");
    if ("response" in space) return space.response;
    const pools = await service.listTargetPools(space.value);
    return c.json({ targetPools: pools }, 200);
  });

  app.put("/v1/space-policies/:name", async (c) => {
    const body = await readJsonObject(c.req.raw);
    const space = stringField(body, "space");
    if (!space) return badRequest(c, "space is required");
    const spec = (body.spec ?? body) as SpacePolicySpec;
    const record = await service.putSpacePolicy(space, c.req.param("name"), spec);
    return c.json(record, 200);
  });

  async function parseResourceBody(
    c: Context,
  ): Promise<
    { readonly request: ApplyResourceRequest } | { readonly response: Response }
  > {
    const body = await readJsonObject(c.req.raw);
    const kind = parseKindFromBodyOrParam(c, body);
    if ("response" in kind) return kind;
    const metadata = (body.metadata ?? {}) as Record<string, unknown>;
    const spec = (body.spec ?? {}) as JsonObject;
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
    const name = c.req.param("name") ?? stringValue(metadata.name) ??
      stringValue((spec as Record<string, unknown>).name);
    if (!name) return { response: badRequest(c, "resource name is required") };
    const space = stringValue(metadata.space) ?? stringField(body, "space");
    if (!space) return { response: badRequest(c, "metadata.space is required") };
    const actor = await resolveActor(c, options);
    return {
      request: {
        actor,
        space,
        project: stringValue(metadata.project),
        environment: stringValue(metadata.environment),
        kind: kind.value,
        name,
        spec,
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

function withId(req: ApplyResourceRequest, value: object): object {
  return { id: formatResourceShapeId(req.space, req.kind, req.name), ...value };
}

function isResourceKind(value: string): value is ResourceShapeKind {
  return (RESOURCE_SHAPE_KINDS as readonly string[]).includes(value);
}

function parseKind(
  c: Context,
): { readonly value: ResourceShapeKind } | { readonly response: Response } {
  const kind = c.req.param("kind");
  if (!kind || !isResourceKind(kind)) {
    return { response: badRequest(c, `unknown resource kind: ${kind}`) };
  }
  return { value: kind };
}

function parseKindFromBodyOrParam(
  c: Context,
  body: Record<string, unknown>,
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
    return parseKind(c);
  }
  const fromBody = stringField(body, "kind");
  if (!fromBody || !isResourceKind(fromBody)) {
    return { response: badRequest(c, `unknown resource kind: ${fromBody}`) };
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

function stringField(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  return stringValue(body[key]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
): 400 | 404 | 409 | 502 {
  switch (code) {
    case "invalid_spec":
    case "invalid_name":
    case "invalid_interfaces":
    case "invalid_interface":
    case "invalid_runtime":
    case "invalid_runtime_interface":
    case "invalid_profile":
    case "invalid_source":
    case "invalid_exposure":
    case "invalid_connections":
    case "invalid_lifecycle_policy":
    case "invalid_delete_policy":
    case "unsupported_shape":
      return 400;
    case "target_pool_not_found":
    case "not_found":
      return 404;
    case "no_eligible_target":
    case "selected_target_missing":
    case "delete_blocked":
      return 409;
    case "apply_failed":
      return 502;
  }
}

function endpoint(
  method: ApiEndpoint["method"],
  path: string,
  operationId: string,
): ApiEndpoint {
  return {
    method,
    path,
    summary: `Resource Shape API: ${operationId}`,
    auth: "none",
    operationId,
    tag: "resource-shape",
    openapi: { okSchema: "ResourceShapeResponse" },
  };
}
