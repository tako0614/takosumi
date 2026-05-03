import type { Context, Hono as HonoApp } from "hono";
import {
  type ActorContext,
  type Deployment,
  type DeploymentInput,
  type DeploymentStatus,
  type InternalGroupRequest,
  type InternalGroupSummary,
  type InternalSpaceRequest,
  type JsonObject,
  TAKOSUMI_INTERNAL_PATHS,
} from "takosumi-contract";
import type { createCoreDomainServices } from "../domains/core/mod.ts";
import type { MutationBoundaryOperation } from "../services/entitlements/mod.ts";
import type { WorkerAuthzService } from "../services/security/mod.ts";
import { DomainError } from "../shared/errors.ts";
import { findNonCatalogConditionReasons } from "./condition_reasons.ts";
import { apiError, readJsonObject, registerApiErrorHandler } from "./errors.ts";
import { type InternalAuthResult, readInternalAuth } from "./internal_auth.ts";
import type {
  DeploymentEnvelope,
  DeploymentExpansionSummary,
  DeploymentService,
} from "./public_routes.ts";

export interface MutationBoundaryEntitlementService {
  requireMutationBoundary(input: {
    readonly spaceId: string;
    readonly groupId?: string;
    readonly accountId: string;
    readonly operation: MutationBoundaryOperation;
  }): Promise<unknown>;
}

export interface InternalRouteServices {
  readonly core: ReturnType<typeof createCoreDomainServices>;
  readonly deployments: DeploymentService;
  readonly planService: {
    createPlan(input: {
      spaceId: string;
      manifest: unknown;
      env?: string;
      envName?: string;
      input?: DeploymentInput;
    }): Promise<unknown>;
    getDeployment?(id: string): Promise<unknown>;
    listDeployments?(filter: {
      readonly spaceId?: string;
      readonly groupId?: string;
      readonly status?: string;
    }): Promise<readonly unknown[]>;
  };
  readonly applyService: {
    applyManifest(input: {
      spaceId: string;
      manifest: unknown;
      input?: DeploymentInput;
      envName?: string;
      createdBy: string;
      actor: unknown;
    }): Promise<unknown>;
    applyDeployment?(input: {
      readonly deploymentId: string;
    }): Promise<unknown>;
    rollbackToDeployment?(input: {
      readonly spaceId: string;
      readonly groupId: string;
      readonly targetDeploymentId: string;
      readonly reason?: string;
    }): Promise<unknown>;
  };
  readonly security?: WorkerAuthzService;
  readonly entitlements?: MutationBoundaryEntitlementService;
}

export interface RegisterInternalRoutesOptions {
  readonly services: InternalRouteServices;
  readonly getInternalServiceSecret?: () => string | undefined;
}

export function registerInternalRoutes(
  app: HonoApp,
  options: RegisterInternalRoutesOptions,
): void {
  registerApiErrorHandler(app);
  const { core, deployments } = options.services;
  const getInternalServiceSecret = options.getInternalServiceSecret ??
    (() => Deno.env.get("TAKOSUMI_INTERNAL_SERVICE_SECRET"));

  app.get(TAKOSUMI_INTERNAL_PATHS.spaces, async (c) => {
    const auth = await readInternalAuth(c.req.raw, {
      secret: getInternalServiceSecret(),
    });
    if (!auth.ok) return internalAuthError(c, auth);
    const authorization = await authorizeInternalServiceCall({
      auth,
      services: options.services,
      spaceId: auth.actor.spaceId,
      serviceGrantPermission: "spaces.read",
    });
    if (!authorization.ok) {
      return c.json(
        authorization.body,
        authorization.status,
      );
    }
    const spaces = await core.spaceQueries.listInternalSpaceSummaries({
      actor: auth.actor,
    });
    return c.json({ spaces });
  });

  app.post(TAKOSUMI_INTERNAL_PATHS.spaces, async (c) => {
    const auth = await readInternalAuth(c.req.raw, {
      secret: getInternalServiceSecret(),
    });
    if (!auth.ok) return internalAuthError(c, auth);
    const request = parseInternalSpaceRequest(
      await readJsonObject(c.req.raw),
      auth.actor,
    );
    const authorization = await authorizeInternalServiceCall({
      auth,
      services: options.services,
      spaceId: request.spaceId,
      serviceGrantPermission: "spaces.create",
    });
    if (!authorization.ok) {
      return c.json(
        authorization.body,
        authorization.status,
      );
    }
    const result = await core.spaces.createSpace({
      actor: auth.actor,
      spaceId: request.spaceId,
      name: request.name,
      metadata: request.metadata,
    });
    if (!result.ok) {
      return c.json(
        apiError(result.error.code, result.error.message),
        400,
      );
    }
    return c.json({ space: toInternalSpaceSummary(result.value) }, 201);
  });

  app.get(TAKOSUMI_INTERNAL_PATHS.groups, async (c) => {
    const auth = await readInternalAuth(c.req.raw, {
      secret: getInternalServiceSecret(),
    });
    if (!auth.ok) return internalAuthError(c, auth);
    const spaceId = c.req.query("spaceId") ?? auth.actor.spaceId;
    if (!spaceId) {
      return c.json(apiError("invalid_argument", "spaceId is required"), 400);
    }
    const authorization = await authorizeInternalServiceCall({
      auth,
      services: options.services,
      spaceId,
      serviceGrantPermission: "groups.read",
    });
    if (!authorization.ok) {
      return c.json(
        authorization.body,
        authorization.status,
      );
    }
    const groups = await core.groupQueries.listGroups({
      actor: auth.actor,
      spaceId,
    });
    const summaries = groups.map(toInternalGroupSummary);
    assertCatalogConditionReasons(summaries, "internal groups list");
    return c.json({ groups: summaries });
  });

  app.post(TAKOSUMI_INTERNAL_PATHS.groups, async (c) => {
    const auth = await readInternalAuth(c.req.raw, {
      secret: getInternalServiceSecret(),
    });
    if (!auth.ok) return internalAuthError(c, auth);
    const request = parseInternalGroupRequest(
      await readJsonObject(c.req.raw),
      auth.actor,
    );
    const authorization = await authorizeInternalServiceCall({
      auth,
      services: options.services,
      spaceId: request.spaceId,
      groupId: request.groupId,
      serviceGrantPermission: "groups.create",
    });
    if (!authorization.ok) {
      return c.json(
        authorization.body,
        authorization.status,
      );
    }
    const result = await core.groups.createGroup({
      actor: auth.actor,
      spaceId: request.spaceId,
      groupId: request.groupId,
      slug: request.envName ?? request.name ?? request.groupId ?? "default",
      displayName: request.name ?? request.envName ?? "Default group",
      metadata: request.metadata,
    });
    if (!result.ok) {
      return c.json(
        apiError(result.error.code, result.error.message),
        400,
      );
    }
    const summary = toInternalGroupSummary(result.value);
    assertCatalogConditionReasons(summary, "internal group create");
    return c.json({ group: summary }, 201);
  });

  app.post(TAKOSUMI_INTERNAL_PATHS.deployments, async (c) => {
    const auth = await readInternalAuth(c.req.raw, {
      secret: getInternalServiceSecret(),
    });
    if (!auth.ok) return internalAuthError(c, auth);
    const request = await readJsonObject(c.req.raw) as {
      spaceId?: string;
      envName?: string;
      group?: string;
      manifest: unknown;
    };
    const spaceId = request.spaceId ?? auth.actor.spaceId;
    if (!spaceId) {
      return c.json(apiError("invalid_argument", "spaceId is required"), 400);
    }
    const groupId = optionalString(request.group) ??
      groupIdFromManifest(request.manifest);
    const authorization = await authorizeInternalServiceCall({
      auth,
      services: options.services,
      spaceId,
      groupId,
      serviceGrantPermission: "deploy.plan",
      entitlementOperation: "deploy.plan",
    });
    if (!authorization.ok) {
      return c.json(
        authorization.body,
        authorization.status,
      );
    }
    const result = await deployments.resolveDeployment({
      actor: auth.actor,
      mode: "resolve",
      space_id: spaceId,
      group: groupId,
      env: optionalString(request.envName),
      manifest: request.manifest,
    });
    assertCatalogConditionReasons(result, "internal deployment resolve");
    return c.json(toMutationResponse(result), 201);
  });

  app.post(TAKOSUMI_INTERNAL_PATHS.deploymentApply, async (c) => {
    const auth = await readInternalAuth(c.req.raw, {
      secret: getInternalServiceSecret(),
    });
    if (!auth.ok) return internalAuthError(c, auth);
    const request = await readJsonObject(c.req.raw) as {
      spaceId?: string;
      space_id?: string;
    };
    const deploymentId = c.req.param("deploymentId");
    const deployment = await deployments.getDeployment({
      actor: auth.actor,
      deploymentId,
    });
    if (!deployment) {
      return c.json(apiError("not_found", "deployment not found"), 404);
    }
    const requestedSpaceId = optionalString(request.spaceId) ??
      optionalString(request.space_id) ?? auth.actor.spaceId;
    if (requestedSpaceId && requestedSpaceId !== deployment.space_id) {
      return c.json(apiError("not_found", "deployment not found"), 404);
    }
    const authorization = await authorizeInternalServiceCall({
      auth,
      services: options.services,
      spaceId: deployment.space_id,
      groupId: deployment.group_id,
      serviceGrantPermission: "deploy.apply",
      entitlementOperation: "deploy.apply",
    });
    if (!authorization.ok) {
      return c.json(
        authorization.body,
        authorization.status,
      );
    }
    const result = await deployments.applyResolved({
      actor: auth.actor,
      deploymentId,
    });
    assertCatalogConditionReasons(result, "internal deployment apply");
    return c.json(toMutationResponse(result), 201);
  });
}

interface AuthorizeInternalServiceCallInput {
  readonly auth: Extract<InternalAuthResult, { ok: true }>;
  readonly services: InternalRouteServices;
  readonly spaceId?: string;
  readonly groupId?: string;
  readonly serviceGrantPermission: string;
  readonly entitlementOperation?: MutationBoundaryOperation;
}

type AuthorizationResponse =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly status: 403;
    readonly body: {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
      };
    };
  };

function toMutationResponse(envelope: DeploymentEnvelope): {
  readonly deployment_id: string;
  readonly status: DeploymentStatus;
  readonly conditions: Deployment["conditions"];
  readonly expansion_summary?: DeploymentExpansionSummary;
} {
  return {
    deployment_id: envelope.deployment.id,
    status: envelope.deployment.status,
    conditions: envelope.deployment.conditions,
    expansion_summary: envelope.expansion_summary,
  };
}

async function authorizeInternalServiceCall(
  input: AuthorizeInternalServiceCallInput,
): Promise<AuthorizationResponse> {
  try {
    if (input.services.security) {
      await input.services.security.authorizeInternalServiceCall({
        sourceIdentityId: input.auth.workloadIdentityId,
        targetService: "takosumi",
        permission: input.serviceGrantPermission,
        spaceId: input.spaceId,
        groupId: input.groupId,
      });
    }

    if (
      input.services.entitlements && input.entitlementOperation &&
      input.spaceId
    ) {
      await input.services.entitlements.requireMutationBoundary({
        spaceId: input.spaceId,
        groupId: input.groupId,
        accountId: input.auth.actor.actorAccountId,
        operation: input.entitlementOperation,
      });
    }

    return { ok: true };
  } catch (error) {
    if (error instanceof DomainError && error.code === "permission_denied") {
      return {
        ok: false,
        status: 403,
        body: apiError(error.code, error.message, error.details),
      };
    }
    throw error;
  }
}

function internalAuthError(
  c: Context,
  auth: Extract<InternalAuthResult, { ok: false }>,
): Response {
  return c.json(
    apiError("unauthenticated", auth.error),
    auth.status,
  );
}

function parseInternalSpaceRequest(
  value: Record<string, unknown>,
  actor: ActorContext,
): InternalSpaceRequest {
  return {
    actor,
    ...(optionalString(value.spaceId)
      ? { spaceId: optionalString(value.spaceId) }
      : {}),
    ...(optionalString(value.name) ? { name: optionalString(value.name) } : {}),
    ...(optionalString(value.slug) ? { slug: optionalString(value.slug) } : {}),
    ...(isJsonObject(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

function parseInternalGroupRequest(
  value: Record<string, unknown>,
  actor: ActorContext,
): InternalGroupRequest {
  return {
    actor,
    spaceId: requiredString(value.spaceId, "spaceId"),
    ...(optionalString(value.groupId)
      ? { groupId: optionalString(value.groupId) }
      : {}),
    ...(optionalString(value.name) ? { name: optionalString(value.name) } : {}),
    ...(optionalString(value.envName)
      ? { envName: optionalString(value.envName) }
      : {}),
    ...(isJsonObject(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new TypeError(`request.${field} must be a non-empty string`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonObject[keyof JsonObject] {
  return value === null || typeof value === "string" ||
    typeof value === "number" || typeof value === "boolean" ||
    (Array.isArray(value) && value.every(isJsonValue)) ||
    isJsonObject(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function groupIdFromManifest(manifest: unknown): string | undefined {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return undefined;
  }
  const name = (manifest as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function assertCatalogConditionReasons(value: unknown, surface: string): void {
  const errors = findNonCatalogConditionReasons(value);
  if (errors.length === 0) return;
  throw new TypeError(
    `${surface} emitted non-catalog condition reason at ${errors[0].path}: ${
      errors[0].reason
    }`,
  );
}

function toInternalSpaceSummary(space: {
  id: string;
  name: string;
  createdByAccountId: string;
}) {
  return {
    id: space.id,
    name: space.name,
    actorAccountId: space.createdByAccountId,
  };
}

function toInternalGroupSummary(group: {
  id: string;
  spaceId: string;
  slug: string;
  displayName: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}): InternalGroupSummary {
  return {
    id: group.id,
    spaceId: group.spaceId,
    name: group.displayName,
    envName: group.slug,
    status: "empty",
    generation: 0,
    currentDeploymentId: null,
    updatedAt: group.updatedAt,
    metadata: group.metadata as JsonObject,
  };
}
