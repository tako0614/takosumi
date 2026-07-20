import type { Context, Hono } from "hono";
import type {
  ActorContext,
  OfferingContextReference,
  OfferingReference,
} from "takosumi-contract";
import { constantTimeEqualsString } from "../shared/constant_time.ts";
import {
  OfferingCatalogAdminError,
  type OfferingCatalogAdminService,
  OfferingError,
  type OfferingService,
} from "../domains/offerings/mod.ts";
import { apiError, readJsonObject, requestIdFromContext } from "./errors.ts";
import { parsePageQuery } from "./page_query.ts";
import type { ApiEndpoint } from "./route_families.ts";

export interface RegisterOfferingCatalogRoutesOptions {
  readonly catalogs: OfferingCatalogAdminService;
  readonly offerings: OfferingService;
  readonly getBearerToken: () => string | undefined;
  readonly resolveActor?: (c: Context) => ActorContext | Promise<ActorContext>;
}

export const OFFERING_CATALOG_ENDPOINTS: readonly ApiEndpoint[] = [
  endpoint("POST", "/v1/offering-catalogs", "publishOfferingCatalog", {
    okStatus: "201",
    alternateOkStatuses: ["200"],
    okSchema: "OfferingCatalog",
    requestSchema: "OfferingCatalog",
  }),
  endpoint("GET", "/v1/offering-catalogs", "listOfferingCatalogs", {
    okSchema: "ListOfferingCatalogsResponse",
    query: ["limit", "cursor"],
  }),
  endpoint(
    "GET",
    "/v1/offering-catalogs/:catalogId/versions/:catalogVersion",
    "getOfferingCatalog",
    {
      okSchema: "OfferingCatalog",
      pathParams: ["catalogId", "catalogVersion"],
    },
  ),
  endpoint(
    "POST",
    "/v1/offering-availability/query",
    "queryOfferingAvailability",
    {
      okSchema: "OfferingAvailabilityResponse",
      requestSchema: "OfferingAvailabilityRequest",
    },
  ),
  endpoint(
    "POST",
    "/v1/offering-selections/resolve",
    "resolveOfferingSelection",
    {
      okSchema: "OfferingSelection",
      requestSchema: "ResolveOfferingSelectionRequest",
    },
  ),
] as const;

export function registerOfferingCatalogRoutes(
  app: Hono,
  options: RegisterOfferingCatalogRoutesOptions,
): void {
  app.post("/v1/offering-catalogs", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const catalog = await readJsonObject(c.req.raw, { maxBytes: 1_048_576 });
      const result = await options.catalogs.publish({
        catalog,
        actorId: auth.actor.actorAccountId,
      });
      return c.json(result.catalog, result.status === "created" ? 201 : 200);
    });
  });

  app.get("/v1/offering-catalogs", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const page = parsePageQuery(c.req.query("limit"), c.req.query("cursor"));
      if (!page.ok) {
        throw new OfferingCatalogAdminError("invalid_catalog", page.message);
      }
      const result = await options.catalogs.list(page.value);
      return c.json(
        {
          catalogs: result.items,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        },
        200,
      );
    });
  });

  app.get(
    "/v1/offering-catalogs/:catalogId/versions/:catalogVersion",
    async (c) => {
      const auth = await authorize(c, options);
      if (!auth.ok) return auth.response;
      return respond(c, async () =>
        c.json(
          await options.catalogs.get(
            c.req.param("catalogId"),
            c.req.param("catalogVersion"),
          ),
          200,
        ),
      );
    },
  );

  app.post("/v1/offering-availability/query", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const body = await readJsonObject(c.req.raw, { maxBytes: 262_144 });
      const request = availabilityRequest(body, auth.actor);
      const availability = await options.offerings.listAvailability(request);
      return c.json({ availability }, 200);
    });
  });

  app.post("/v1/offering-selections/resolve", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const body = await readJsonObject(c.req.raw, { maxBytes: 262_144 });
      return c.json(
        await options.offerings.resolve(selectionRequest(body, auth.actor)),
        200,
      );
    });
  });
}

type AuthResult =
  | { readonly ok: true; readonly actor: ActorContext }
  | { readonly ok: false; readonly response: Response };

async function authorize(
  c: Context,
  options: RegisterOfferingCatalogRoutesOptions,
): Promise<AuthResult> {
  const expected = options.getBearerToken();
  if (!expected) {
    return {
      ok: false,
      response: c.json(
        apiError(
          "not_found",
          "Offering catalog API disabled",
          undefined,
          requestIdFromContext(c),
        ),
        404,
      ),
    };
  }
  const bearer = bearerToken(c.req.header("authorization"));
  if (!bearer || !constantTimeEqualsString(bearer, expected)) {
    return {
      ok: false,
      response: c.json(
        apiError(
          "unauthenticated",
          "invalid Offering catalog bearer",
          undefined,
          requestIdFromContext(c),
        ),
        401,
      ),
    };
  }
  return {
    ok: true,
    actor: options.resolveActor
      ? await options.resolveActor(c)
      : {
          actorAccountId: "self-host-operator",
          roles: ["owner"],
          requestId: requestIdFromContext(c),
        },
  };
}

function availabilityRequest(
  body: Record<string, unknown>,
  actor: ActorContext,
) {
  assertOnlyKeys(body, [
    "catalogId",
    "catalogVersion",
    "principalId",
    "roles",
    "workspaceId",
    "contexts",
  ]);
  return {
    catalogId: requiredString(body.catalogId, "catalogId"),
    catalogVersion: requiredString(body.catalogVersion, "catalogVersion"),
    principalId:
      optionalString(body.principalId, "principalId") ?? actor.actorAccountId,
    roles: optionalStrings(body.roles, "roles") ?? actor.roles,
    ...(optionalString(body.workspaceId, "workspaceId")
      ? { workspaceId: optionalString(body.workspaceId, "workspaceId")! }
      : {}),
    contexts: contexts(body.contexts),
  };
}

function selectionRequest(body: Record<string, unknown>, actor: ActorContext) {
  assertOnlyKeys(body, [
    "reference",
    "principalId",
    "roles",
    "workspaceId",
    "contexts",
  ]);
  return {
    reference: offeringReference(body.reference),
    principalId:
      optionalString(body.principalId, "principalId") ?? actor.actorAccountId,
    roles: optionalStrings(body.roles, "roles") ?? actor.roles,
    ...(optionalString(body.workspaceId, "workspaceId")
      ? { workspaceId: optionalString(body.workspaceId, "workspaceId")! }
      : {}),
    contexts: contexts(body.contexts),
  };
}

function offeringReference(value: unknown): OfferingReference {
  if (!isRecord(value)) throw invalid("reference must be an object");
  assertOnlyKeys(value, [
    "catalogId",
    "catalogVersion",
    "offeringId",
    "offeringVersion",
  ]);
  return {
    catalogId: requiredString(value.catalogId, "reference.catalogId"),
    catalogVersion: requiredString(
      value.catalogVersion,
      "reference.catalogVersion",
    ),
    offeringId: requiredString(value.offeringId, "reference.offeringId"),
    offeringVersion: requiredString(
      value.offeringVersion,
      "reference.offeringVersion",
    ),
  };
}

function contexts(value: unknown): readonly OfferingContextReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw invalid("contexts must be an array with at most 64 entries");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw invalid(`contexts[${index}] must be an object`);
    assertOnlyKeys(entry, ["type", "id"]);
    return {
      type: requiredString(entry.type, `contexts[${index}].type`),
      id: requiredString(entry.id, `contexts[${index}].id`),
    };
  });
}

function optionalStrings(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw invalid(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value as string[])];
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function requiredString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 1024
  ) {
    throw invalid(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw invalid(`unsupported fields: ${extra.sort().join(", ")}`);
  }
}

async function respond(
  c: Context,
  action: () => Promise<Response>,
): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof OfferingCatalogAdminError) {
      const status =
        error.code === "catalog_not_found"
          ? 404
          : error.code === "catalog_conflict"
            ? 409
            : 400;
      return c.json(
        apiError(
          error.code === "catalog_not_found"
            ? "not_found"
            : error.code === "catalog_conflict"
              ? "failed_precondition"
              : "invalid_argument",
          error.message,
          { domainCode: error.code },
          requestIdFromContext(c),
        ),
        status,
      );
    }
    if (error instanceof OfferingError) {
      const status =
        error.code === "catalog_not_found" ||
        error.code === "offering_not_found"
          ? 404
          : error.code === "offering_unavailable"
            ? 409
            : 503;
      return c.json(
        apiError(
          error.code === "catalog_not_found" ||
            error.code === "offering_not_found"
            ? "not_found"
            : error.code === "offering_unavailable"
              ? "failed_precondition"
              : "internal_error",
          error.message,
          {
            domainCode: error.code,
            ...(error.availabilityReason
              ? { reason: error.availabilityReason }
              : {}),
          },
          requestIdFromContext(c),
        ),
        status,
      );
    }
    throw error;
  }
}

function invalid(message: string): OfferingCatalogAdminError {
  return new OfferingCatalogAdminError("invalid_catalog", message);
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(header ?? "");
  return match?.[1]?.trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function endpoint(
  method: ApiEndpoint["method"],
  path: string,
  operationId: string,
  openapi: ApiEndpoint["openapi"],
): ApiEndpoint {
  return {
    method,
    path,
    operationId,
    summary: operationId,
    auth: "deploy-control-token",
    tag: "offering-catalogs",
    openapi,
  };
}
