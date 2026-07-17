import type { Context, Hono } from "hono";
import type {
  ActorContext,
  FormActivation,
  InstalledFormReference,
  JsonObject,
} from "takosumi-contract";
import { isInstalledFormReference } from "takosumi-contract";
import { constantTimeEqualsString } from "../shared/constant_time.ts";
import {
  FormRegistryError,
  type FormRegistryService,
} from "../domains/service-forms/mod.ts";
import { apiError, readJsonObject, requestIdFromContext } from "./errors.ts";
import { parsePageQuery } from "./page_query.ts";
import type { ApiEndpoint } from "./route_families.ts";

export interface RegisterFormActivationRoutesOptions {
  readonly service: FormRegistryService;
  /**
   * Operator bearer for the generic noncommercial activation lifecycle.
   * This deliberately does not reuse customer session/PAT authorization:
   * exposing an exact FormRef to an audience is operator policy authority.
   */
  readonly getBearerToken: () => string | undefined;
  readonly resolveActor?: (c: Context) => ActorContext | Promise<ActorContext>;
}

export const FORM_ACTIVATION_ENDPOINTS: readonly ApiEndpoint[] = [
  endpoint("POST", "/v1/form-activations", "createFormActivation", {
    okStatus: "201",
    okSchema: "FormActivation",
    requestSchema: "CreateFormActivationRequest",
  }),
  endpoint("GET", "/v1/form-activations", "listFormActivations", {
    okSchema: "ListFormActivationsResponse",
    query: ["limit", "cursor"],
  }),
  endpoint("GET", "/v1/form-activations/:id", "getFormActivation", {
    okSchema: "FormActivation",
  }),
  endpoint("PATCH", "/v1/form-activations/:id", "updateFormActivation", {
    okSchema: "FormActivation",
    requestSchema: "UpdateFormActivationRequest",
  }),
] as const;

export function registerFormActivationRoutes(
  app: Hono,
  options: RegisterFormActivationRoutesOptions,
): void {
  app.post("/v1/form-activations", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const body = await readJsonObject(c.req.raw, { maxBytes: 262_144 });
      const request = parseCreateRequest(body, auth.actor.actorAccountId);
      const activation = await options.service.createActivation(request);
      return withRevisionEtag(c, activation, 201);
    });
  });

  app.get("/v1/form-activations", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const page = parsePageQuery(c.req.query("limit"), c.req.query("cursor"));
      if (!page.ok) throw invalid(page.message);
      const result = await options.service.listActivations(page.value);
      return c.json(
        {
          activations: result.items,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        },
        200,
      );
    });
  });

  app.get("/v1/form-activations/:id", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const id = requiredToken(c.req.param("id"), "activation id");
      const activation = await options.service.getActivation(id);
      if (!activation) {
        throw new FormRegistryError(
          "activation_not_found",
          "activation was not found",
        );
      }
      return withRevisionEtag(c, activation, 200);
    });
  });

  app.patch("/v1/form-activations/:id", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const id = requiredToken(c.req.param("id"), "activation id");
      const body = await readJsonObject(c.req.raw, { maxBytes: 262_144 });
      const request = parseUpdateRequest(id, body, auth.actor.actorAccountId);
      const activation = await options.service.updateActivation(request);
      return withRevisionEtag(c, activation, 200);
    });
  });
}

type AuthResult =
  | { readonly ok: true; readonly actor: ActorContext }
  | { readonly ok: false; readonly response: Response };

async function authorize(
  c: Context,
  options: RegisterFormActivationRoutesOptions,
): Promise<AuthResult> {
  const expected = options.getBearerToken();
  if (!expected) {
    return {
      ok: false,
      response: c.json(
        apiError(
          "not_found",
          "form activation API disabled",
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
          "invalid form activation bearer",
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

function parseCreateRequest(body: Record<string, unknown>, actorId: string) {
  assertOnlyKeys(body, [
    "id",
    "identity",
    "scope",
    "audience",
    "policy",
    "eligibleTargetPoolClasses",
    "status",
  ]);
  const identity = installedIdentity(body.identity);
  const scope = activationScope(body.scope);
  const audience = optionalAudience(body.audience);
  const policy = optionalJsonObject(body.policy, "policy");
  const eligibleTargetPoolClasses = optionalStringArray(
    body.eligibleTargetPoolClasses,
    "eligibleTargetPoolClasses",
  );
  const status = optionalStatus(body.status);
  return {
    id: requiredToken(body.id, "activation id"),
    identity,
    scope,
    ...(audience ? { audience } : {}),
    ...(policy ? { policy } : {}),
    ...(eligibleTargetPoolClasses ? { eligibleTargetPoolClasses } : {}),
    ...(status ? { status } : {}),
    actorId,
  };
}

function parseUpdateRequest(
  id: string,
  body: Record<string, unknown>,
  actorId: string,
) {
  assertOnlyKeys(body, [
    "expectedRevision",
    "audience",
    "policy",
    "eligibleTargetPoolClasses",
    "status",
  ]);
  if (
    typeof body.expectedRevision !== "number" ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 1
  ) {
    throw invalid("expectedRevision must be a positive integer");
  }
  const audience = optionalAudience(body.audience);
  const policy = optionalJsonObject(body.policy, "policy");
  const eligibleTargetPoolClasses = optionalStringArray(
    body.eligibleTargetPoolClasses,
    "eligibleTargetPoolClasses",
  );
  const status = optionalStatus(body.status);
  return {
    id,
    expectedRevision: body.expectedRevision,
    ...(audience ? { audience } : {}),
    ...(policy ? { policy } : {}),
    ...(eligibleTargetPoolClasses ? { eligibleTargetPoolClasses } : {}),
    ...(status ? { status } : {}),
    actorId,
  };
}

function installedIdentity(value: unknown): InstalledFormReference {
  if (!isInstalledFormReference(value)) {
    throw invalid("identity must be an exact installed FormRef");
  }
  return {
    formRef: {
      apiVersion: value.formRef.apiVersion,
      kind: value.formRef.kind,
      definitionVersion: value.formRef.definitionVersion,
      schemaDigest: value.formRef.schemaDigest,
    },
    packageDigest: value.packageDigest,
  };
}

function activationScope(value: unknown): FormActivation["scope"] {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalid("scope is required");
  }
  if (value.type === "operator") {
    assertOnlyKeys(value, ["type"]);
    return { type: "operator" };
  }
  if (value.type === "workspace" || value.type === "space") {
    assertOnlyKeys(value, ["type", "id"]);
    return { type: value.type, id: requiredToken(value.id, "scope id") };
  }
  throw invalid("scope type must be operator, workspace, or space");
}

function optionalAudience(
  value: unknown,
): FormActivation["audience"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalid("audience must be an object");
  assertOnlyKeys(value, ["public", "principalIds", "roles"]);
  if (value.public !== undefined && typeof value.public !== "boolean") {
    throw invalid("audience.public must be a boolean");
  }
  const principalIds = optionalStringArray(
    value.principalIds,
    "audience.principalIds",
  );
  const roles = optionalStringArray(value.roles, "audience.roles");
  return {
    ...(value.public !== undefined ? { public: value.public } : {}),
    ...(principalIds ? { principalIds } : {}),
    ...(roles ? { roles } : {}),
  };
}

function optionalJsonObject(
  value: unknown,
  label: string,
): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalid(`${label} must be a JSON object`);
  return value as JsonObject;
}

function optionalStringArray(
  value: unknown,
  label: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalid(`${label} must be an array of strings`);
  }
  return value as readonly string[];
}

function optionalStatus(value: unknown): FormActivation["status"] | undefined {
  if (value === undefined) return undefined;
  if (value !== "active" && value !== "inactive") {
    throw invalid("status must be active or inactive");
  }
  return value;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw invalid(`unsupported field: ${unexpected.sort()[0]}`);
  }
}

function requiredToken(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw invalid(`${label} is required`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const [scheme, ...rest] = value.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return undefined;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : undefined;
}

function withRevisionEtag(
  c: Context,
  activation: FormActivation,
  status: 200 | 201,
): Response {
  c.header("etag", `\"${activation.revision}\"`);
  return c.json(activation, status);
}

async function respond(
  c: Context,
  action: () => Promise<Response>,
): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof FormRegistryError) {
      return c.json(
        apiError(error.code, error.message, undefined, requestIdFromContext(c)),
        statusFor(error.code),
      );
    }
    throw error;
  }
}

function invalid(message: string): FormRegistryError {
  return new FormRegistryError("invalid_request", message);
}

function statusFor(code: FormRegistryError["code"]): 400 | 404 | 409 | 503 {
  switch (code) {
    case "invalid_request":
    case "verification_failed":
      return 400;
    case "activation_not_found":
    case "definition_not_installed":
      return 404;
    case "package_conflict":
    case "package_unavailable":
    case "package_retained":
    case "activation_conflict":
      return 409;
    case "verification_unavailable":
      return 503;
  }
}

function endpoint(
  method: ApiEndpoint["method"],
  path: string,
  operationId: string,
  openapi: Partial<ApiEndpoint["openapi"]>,
): ApiEndpoint {
  const pathParams = [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(
    (match) => match[1]!,
  );
  return {
    method,
    path,
    summary: `Form Activation API: ${operationId}`,
    auth: "deploy-control-token",
    operationId,
    tag: "form-activations",
    openapi: {
      okSchema: "FormActivation",
      ...(pathParams.length > 0 ? { pathParams } : {}),
      ...openapi,
    },
  };
}
