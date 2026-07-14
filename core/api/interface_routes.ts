import type { Context, Hono } from "hono";
import type {
  ActorContext,
  CreateInterfaceBindingRequest,
  CreateInterfaceRequest,
  Interface,
  InterfacePhase,
  IssueInterfaceTokenRequest,
  UpdateInterfaceRequest,
} from "takosumi-contract";
import { isValidInterfacePermissionToken } from "takosumi-contract";
import { TAKOSUMI_INTERNAL_ACTOR_HEADER } from "takosumi-contract/reference/compat";
import { decodeActorContext } from "takosumi-contract/internal/rpc";
import { constantTimeEqualsString } from "../shared/constant_time.ts";
import {
  InterfaceService,
  InterfaceServiceError,
} from "../domains/interfaces/mod.ts";
import { apiError, readJsonObject, requestIdFromContext } from "./errors.ts";
import type { ApiEndpoint } from "./route_families.ts";

export interface RegisterInterfaceRoutesOptions {
  readonly service: InterfaceService;
  readonly getInterfaceBearerToken?: () => string | undefined;
  readonly authorizeInterfaceBearer?: (input: {
    readonly token: string;
    readonly request: Request;
  }) => ActorContext | undefined | Promise<ActorContext | undefined>;
  /**
   * Optional host authorization for actors whose credential is not already
   * bound to one Workspace. The callback runs only after the route has resolved
   * the authoritative Interface Workspace. A successful result scopes the
   * actor to that Workspace for the remainder of the request.
   */
  readonly authorizeInterfaceWorkspace?: (input: {
    readonly actor: ActorContext;
    readonly workspaceId: string;
    readonly request: Request;
  }) => boolean | Promise<boolean>;
}

export const INTERFACE_ENDPOINTS: readonly ApiEndpoint[] = [
  endpoint("POST", "/v1/interfaces", "createInterface", {
    okStatus: "201",
    okSchema: "Interface",
    requestSchema: "CreateInterfaceRequest",
  }),
  endpoint("GET", "/v1/interfaces", "listInterfaces", {
    okSchema: "ListInterfacesResponse",
    query: [
      "workspaceId",
      "workspace",
      "type",
      "phase",
      "ownerKind",
      "ownerId",
      "includeRetired",
      "permission",
    ],
  }),
  endpoint("GET", "/v1/interfaces/:id", "getInterface", {
    okSchema: "Interface",
    pathParams: ["id"],
    query: ["permission"],
  }),
  endpoint("POST", "/v1/interfaces/:id/token", "issueInterfaceToken", {
    okSchema: "IssueInterfaceTokenResponse",
    requestSchema: "IssueInterfaceTokenRequest",
    pathParams: ["id"],
  }),
  endpoint("PATCH", "/v1/interfaces/:id", "updateInterface", {
    okSchema: "Interface",
    requestSchema: "UpdateInterfaceRequest",
    pathParams: ["id"],
  }),
  endpoint("DELETE", "/v1/interfaces/:id", "retireInterface", {
    okSchema: "Interface",
    pathParams: ["id"],
  }),
  endpoint("POST", "/v1/interfaces/:id/bindings", "createInterfaceBinding", {
    okStatus: "201",
    okSchema: "InterfaceBinding",
    requestSchema: "CreateInterfaceBindingRequest",
    pathParams: ["id"],
  }),
  endpoint("GET", "/v1/interfaces/:id/bindings", "listInterfaceBindings", {
    okSchema: "ListInterfaceBindingsResponse",
    pathParams: ["id"],
    query: ["permission"],
  }),
  endpoint(
    "GET",
    "/v1/interfaces/:id/bindings/:bindingId",
    "getInterfaceBinding",
    {
      okSchema: "InterfaceBinding",
      pathParams: ["id", "bindingId"],
      query: ["permission"],
    },
  ),
  endpoint(
    "DELETE",
    "/v1/interfaces/:id/bindings/:bindingId",
    "revokeInterfaceBinding",
    {
      okSchema: "InterfaceBinding",
      pathParams: ["id", "bindingId"],
    },
  ),
] as const;

export function registerInterfaceRoutes(
  app: Hono,
  options: RegisterInterfaceRoutesOptions,
): void {
  app.post("/v1/interfaces", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const controlDenied = enforceControlActor(c, auth.actor);
    if (controlDenied) return controlDenied;
    return respond(c, async () => {
      const body = await readJsonObject(c.req.raw, { maxBytes: 1_048_576 });
      const scoped = await scopeInterfaceWorkspace(
        c,
        options,
        auth.actor,
        string(body.workspaceId),
      );
      if (!scoped.ok) return scoped.response;
      const record = await options.service.create(
        body as unknown as CreateInterfaceRequest,
        scoped.actor,
      );
      return withEtag(c, record, 201);
    });
  });

  app.get("/v1/interfaces", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const workspaceId = c.req.query("workspaceId");
      if (!workspaceId) throw invalid("workspaceId is required");
      const scoped = await scopeInterfaceWorkspace(
        c,
        options,
        auth.actor,
        workspaceId,
      );
      if (!scoped.ok) return scoped.response;
      const phase = c.req.query("phase") as InterfacePhase | undefined;
      if (phase && !INTERFACE_PHASES.has(phase)) {
        throw invalid("phase is not a valid Interface phase");
      }
      const ownerKind = c.req.query("ownerKind") as
        Interface["metadata"]["ownerRef"]["kind"] | undefined;
      if (ownerKind && !OWNER_KINDS.has(ownerKind)) {
        throw invalid("ownerKind is not supported");
      }
      const filter = {
        workspaceId,
        ...(c.req.query("type") ? { type: c.req.query("type") } : {}),
        ...(phase ? { phase } : {}),
        ...(ownerKind ? { ownerKind } : {}),
        ...(c.req.query("ownerId") ? { ownerId: c.req.query("ownerId") } : {}),
        includeRetired: truthy(c.req.query("includeRetired")),
      };
      const interfaces = isRuntimePrincipal(scoped.actor)
        ? await options.service.listAuthorizedForPrincipal(
            filter,
            scoped.actor.actorAccountId,
            requireRuntimePermission(c),
          )
        : await options.service.list(filter);
      return c.json({ interfaces }, 200);
    });
  });

  app.get("/v1/interfaces/:id", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const record = isRuntimePrincipal(auth.actor)
        ? await options.service.getAuthorizedForPrincipal(
            c.req.param("id"),
            auth.actor.actorAccountId,
            requireRuntimePermission(c),
          )
        : await options.service.get(c.req.param("id"));
      const scoped = await scopeInterfaceWorkspace(
        c,
        options,
        auth.actor,
        record.metadata.workspaceId,
      );
      return scoped.ok ? withEtag(c, record, 200) : scoped.response;
    });
  });

  app.post("/v1/interfaces/:id/token", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const runtimeActor = isRuntimePrincipal(auth.actor)
      ? auth.actor
      : undefined;
    if (!runtimeActor) return runtimePrincipalForbidden(c);
    return respond(c, async () => {
      const body = await readJsonObject(c.req.raw, { maxBytes: 16_384 });
      const permission = runtimePermission(body.permission);
      const iface = await options.service.getAuthorizedForPrincipal(
        c.req.param("id"),
        runtimeActor.actorAccountId,
        permission,
      );
      const scoped = await scopeInterfaceWorkspace(
        c,
        options,
        runtimeActor,
        iface.metadata.workspaceId,
      );
      if (!scoped.ok) return scoped.response;
      const issued = await options.service.issueToken(
        iface.metadata.id,
        body as unknown as IssueInterfaceTokenRequest,
        {
          workspaceId: iface.metadata.workspaceId,
          subjectId: runtimeActor.actorAccountId,
        },
        scoped.actor,
      );
      c.header("cache-control", "no-store");
      c.header("pragma", "no-cache");
      return c.json(issued, 200);
    });
  });

  app.patch("/v1/interfaces/:id", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const controlDenied = enforceControlActor(c, auth.actor);
    if (controlDenied) return controlDenied;
    return respond(c, async () => {
      const current = await options.service.get(c.req.param("id"));
      const scoped = await scopeInterfaceWorkspace(
        c,
        options,
        auth.actor,
        current.metadata.workspaceId,
      );
      if (!scoped.ok) return scoped.response;
      requireEtag(c, current);
      const body = await readJsonObject(c.req.raw, { maxBytes: 1_048_576 });
      const record = await options.service.update(
        current.metadata.id,
        body as unknown as UpdateInterfaceRequest,
        current.metadata.generation,
        scoped.actor,
        current.status.resolvedRevision,
      );
      return withEtag(c, record, 200);
    });
  });

  app.delete("/v1/interfaces/:id", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const controlDenied = enforceControlActor(c, auth.actor);
    if (controlDenied) return controlDenied;
    return respond(c, async () => {
      const current = await options.service.get(c.req.param("id"));
      const scoped = await scopeInterfaceWorkspace(
        c,
        options,
        auth.actor,
        current.metadata.workspaceId,
      );
      if (!scoped.ok) return scoped.response;
      requireEtag(c, current);
      const record = await options.service.retire(
        current.metadata.id,
        current.metadata.generation,
        scoped.actor,
        current.status.resolvedRevision,
      );
      return withEtag(c, record, 200);
    });
  });

  app.post("/v1/interfaces/:id/bindings", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const controlDenied = enforceControlActor(c, auth.actor);
    if (controlDenied) return controlDenied;
    return respond(c, async () => {
      const iface = await options.service.get(c.req.param("id"));
      const scoped = await scopeInterfaceWorkspace(
        c,
        options,
        auth.actor,
        iface.metadata.workspaceId,
      );
      if (!scoped.ok) return scoped.response;
      const body = await readJsonObject(c.req.raw, { maxBytes: 1_048_576 });
      const binding = await options.service.createBinding(
        c.req.param("id"),
        body as unknown as CreateInterfaceBindingRequest,
        scoped.actor,
      );
      return c.json(binding, 201);
    });
  });

  app.get("/v1/interfaces/:id/bindings", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const iface = isRuntimePrincipal(auth.actor)
        ? await options.service.getAuthorizedForPrincipal(
            c.req.param("id"),
            auth.actor.actorAccountId,
            requireRuntimePermission(c),
          )
        : await options.service.get(c.req.param("id"));
      const scoped = await scopeInterfaceWorkspace(
        c,
        options,
        auth.actor,
        iface.metadata.workspaceId,
      );
      if (!scoped.ok) return scoped.response;
      return c.json(
        {
          bindings: isRuntimePrincipal(scoped.actor)
            ? await options.service.listAuthorizedBindingsForPrincipal(
                c.req.param("id"),
                scoped.actor.actorAccountId,
                requireRuntimePermission(c),
              )
            : await options.service.listBindings(c.req.param("id")),
        },
        200,
      );
    });
  });

  app.get("/v1/interfaces/:id/bindings/:bindingId", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const iface = isRuntimePrincipal(auth.actor)
        ? await options.service.getAuthorizedForPrincipal(
            c.req.param("id"),
            auth.actor.actorAccountId,
            requireRuntimePermission(c),
          )
        : await options.service.get(c.req.param("id"));
      const scoped = await scopeInterfaceWorkspace(
        c,
        options,
        auth.actor,
        iface.metadata.workspaceId,
      );
      if (!scoped.ok) return scoped.response;
      if (isRuntimePrincipal(scoped.actor)) {
        const binding = (
          await options.service.listAuthorizedBindingsForPrincipal(
            c.req.param("id"),
            scoped.actor.actorAccountId,
            requireRuntimePermission(c),
          )
        ).find((entry) => entry.metadata.id === c.req.param("bindingId"));
        if (!binding) {
          throw new InterfaceServiceError(
            "not_found",
            "InterfaceBinding not found",
          );
        }
        return c.json(binding, 200);
      }
      return c.json(
        await options.service.getBinding(
          c.req.param("id"),
          c.req.param("bindingId"),
        ),
        200,
      );
    });
  });

  app.delete("/v1/interfaces/:id/bindings/:bindingId", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const controlDenied = enforceControlActor(c, auth.actor);
    if (controlDenied) return controlDenied;
    return respond(c, async () => {
      const iface = await options.service.get(c.req.param("id"));
      const scoped = await scopeInterfaceWorkspace(
        c,
        options,
        auth.actor,
        iface.metadata.workspaceId,
      );
      if (!scoped.ok) return scoped.response;
      return c.json(
        await options.service.revokeBinding(
          c.req.param("id"),
          c.req.param("bindingId"),
          scoped.actor,
        ),
        200,
      );
    });
  });
}

const INTERFACE_PHASES = new Set<InterfacePhase>([
  "Pending",
  "Resolved",
  "NotReady",
  "Unknown",
  "Terminating",
  "Retired",
]);
const OWNER_KINDS = new Set<Interface["metadata"]["ownerRef"]["kind"]>([
  "Workspace",
  "Capsule",
  "Resource",
]);

type InterfaceAuthResult =
  | { readonly ok: true; readonly actor?: ActorContext }
  | { readonly ok: false; readonly response: Response };

async function authorize(
  c: Context,
  options: RegisterInterfaceRoutesOptions,
): Promise<InterfaceAuthResult> {
  const configured = options.getInterfaceBearerToken?.();
  if (!configured && !options.authorizeInterfaceBearer) return { ok: true };
  const bearer = bearerToken(c.req.header("authorization"));
  if (!bearer) return { ok: false, response: unauthorized(c) };
  if (configured && constantTimeEqualsString(configured, bearer)) {
    const actorHeader = c.req.header(TAKOSUMI_INTERNAL_ACTOR_HEADER);
    if (!actorHeader) return { ok: true };
    try {
      return { ok: true, actor: decodeActorContext(actorHeader) };
    } catch {
      return { ok: false, response: unauthorized(c) };
    }
  }
  if (options.authorizeInterfaceBearer) {
    const actor = await options.authorizeInterfaceBearer({
      token: bearer,
      request: c.req.raw,
    });
    return actor
      ? { ok: true, actor }
      : { ok: false, response: unauthorized(c) };
  }
  return { ok: false, response: unauthorized(c) };
}

type InterfaceWorkspaceAuthResult =
  | { readonly ok: true; readonly actor?: ActorContext }
  | { readonly ok: false; readonly response: Response };

async function scopeInterfaceWorkspace(
  c: Context,
  options: RegisterInterfaceRoutesOptions,
  actor: ActorContext | undefined,
  workspaceId: string | undefined,
): Promise<InterfaceWorkspaceAuthResult> {
  if (!workspaceId) throw invalid("workspaceId is required");
  // No actor means the configured internal deploy-control bearer was used
  // without an actor header. That remains the explicit operator authority.
  if (!actor) return { ok: true };
  if (actor.workspaceId && actor.workspaceId !== workspaceId) {
    return { ok: false, response: workspaceForbidden(c) };
  }
  if (options.authorizeInterfaceWorkspace) {
    if (
      !(await options.authorizeInterfaceWorkspace({
        actor,
        workspaceId,
        request: c.req.raw,
      }))
    ) {
      return { ok: false, response: workspaceForbidden(c) };
    }
  } else if (!actor.workspaceId) {
    // An authenticated but unscoped actor is never global authority. Hosts
    // that accept account sessions or unbound PATs must prove membership via
    // authorizeInterfaceWorkspace above.
    return { ok: false, response: workspaceForbidden(c) };
  }
  return {
    ok: true,
    actor:
      actor.workspaceId === workspaceId
        ? actor
        : { ...actor, workspaceId },
  };
}

function workspaceForbidden(c: Context): Response {
  return c.json(
    apiError(
      "forbidden",
      "Interface belongs to a different Workspace",
      undefined,
      requestIdFromContext(c),
    ),
    403,
  );
}

function isRuntimePrincipal(
  actor: ActorContext | undefined,
): actor is ActorContext {
  return actor?.roles.includes("runtime-principal") === true;
}

function enforceControlActor(
  c: Context,
  actor: ActorContext | undefined,
): Response | undefined {
  if (!isRuntimePrincipal(actor)) return undefined;
  return c.json(
    apiError(
      "forbidden",
      "runtime principals cannot mutate Interface desired state or bindings",
      undefined,
      requestIdFromContext(c),
    ),
    403,
  );
}

function runtimePrincipalForbidden(c: Context): Response {
  return c.json(
    apiError(
      "forbidden",
      "only a runtime Principal can request an Interface token",
      undefined,
      requestIdFromContext(c),
    ),
    403,
  );
}

function requireRuntimePermission(c: Context): string {
  return runtimePermission(c.req.query("permission"));
}

function runtimePermission(value: unknown): string {
  const permission = string(value);
  if (!isValidInterfacePermissionToken(permission)) {
    throw invalid(
      "permission is required for runtime Interface discovery and must be one RFC 6749 scope token",
    );
  }
  return permission;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(value ?? "");
  return match?.[1]?.trim() || undefined;
}

function unauthorized(c: Context): Response {
  return c.json(
    apiError(
      "unauthenticated",
      "invalid Interface API bearer",
      undefined,
      requestIdFromContext(c),
    ),
    401,
  );
}

async function respond(
  c: Context,
  work: () => Promise<Response>,
): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof InterfaceServiceError)) throw error;
    return c.json(
      apiError(error.code, error.message, undefined, requestIdFromContext(c)),
      status(error),
    );
  }
}

function status(error: InterfaceServiceError): 400 | 404 | 409 | 412 {
  switch (error.code) {
    case "invalid_argument":
      return 400;
    case "not_found":
      return 404;
    case "already_exists":
    case "conflict":
      return 409;
    case "failed_precondition":
      return 412;
  }
}

function invalid(message: string): InterfaceServiceError {
  return new InterfaceServiceError("invalid_argument", message);
}

function etag(record: Interface): string {
  return `\"if-${record.metadata.generation}-${record.status.resolvedRevision}\"`;
}

function requireEtag(c: Context, record: Interface): void {
  if (c.req.header("if-match") !== etag(record)) {
    throw new InterfaceServiceError(
      "failed_precondition",
      "If-Match must equal the current Interface ETag",
    );
  }
}

function withEtag(
  c: Context,
  record: Interface,
  statusCode: 200 | 201,
): Response {
  c.header("etag", etag(record));
  return c.json(record, statusCode);
}

function truthy(value: string | undefined): boolean {
  return (
    value !== undefined &&
    ["1", "true", "yes", "on"].includes(value.toLowerCase())
  );
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
    summary: `Runtime Interface API: ${operationId}`,
    auth: "deploy-control-token",
    operationId,
    tag: "interfaces",
    openapi,
  };
}
