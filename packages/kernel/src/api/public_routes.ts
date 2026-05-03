import type { Context, Hono as HonoApp } from "hono";
import type {
  ActorContext,
  Deployment,
  DeploymentStatus,
  GroupHead,
  JsonObject,
  ProviderObservation,
} from "takosumi-contract";
import { findNonCatalogConditionReasons } from "./condition_reasons.ts";
import { apiError, readJsonObject, registerApiErrorHandler } from "./errors.ts";

export const TAKOSUMI_PAAS_PUBLIC_PATHS = {
  capabilities: "/api/public/v1/capabilities",
  spaces: "/api/public/v1/spaces",
  groups: "/api/public/v1/groups",
  deployments: "/api/public/v1/deployments",
  deployment: "/api/public/v1/deployments/:deploymentId",
  deploymentApply: "/api/public/v1/deployments/:deploymentId/apply",
  deploymentApprove: "/api/public/v1/deployments/:deploymentId/approve",
  deploymentObservations:
    "/api/public/v1/deployments/:deploymentId/observations",
  groupHead: "/api/public/v1/groups/:groupId/head",
  groupRollback: "/api/public/v1/groups/:groupId/rollback",
} as const;

export type TakosPaaSPublicPath =
  (typeof TAKOSUMI_PAAS_PUBLIC_PATHS)[keyof typeof TAKOSUMI_PAAS_PUBLIC_PATHS];

export type DeploymentMode = "preview" | "resolve" | "apply" | "rollback";

export interface DeploymentExpansionSummary {
  readonly components?: number;
  readonly bindings?: number;
  readonly routes?: number;
  readonly resources?: number;
  readonly [key: string]: unknown;
}

export interface DeploymentEnvelope {
  readonly deployment: Deployment;
  readonly expansion_summary?: DeploymentExpansionSummary;
}

export interface DeploymentMutationResponse {
  readonly deployment_id: string;
  readonly status: DeploymentStatus;
  readonly conditions: Deployment["conditions"];
  readonly expansion_summary?: DeploymentExpansionSummary;
}

export interface PublicDeploymentCreateInput extends PublicActorInput {
  readonly mode: DeploymentMode;
  readonly manifest?: unknown;
  readonly source?: PublicDeploySourceInput;
  readonly target_id?: string;
  readonly group?: string;
  readonly env?: string;
  readonly space_id?: string;
}

export type PublicDeploySourceInput = PublicDeployGitSourceInput;

export interface PublicDeployGitSourceInput {
  readonly kind: "git";
  readonly repository_id: string;
  readonly ref: string;
  readonly path?: string;
  readonly manifest_path?: string;
}

export interface PublicDeploymentGetInput extends PublicActorInput {
  readonly deploymentId: string;
}

export interface PublicDeploymentListInput extends PublicActorInput {
  readonly group?: string;
  readonly status?: DeploymentStatus;
  readonly space_id?: string;
}

export interface PublicGroupRefInput extends PublicActorInput {
  readonly groupId: string;
  readonly space_id?: string;
}

export interface PublicGroupRollbackInput extends PublicGroupRefInput {
  readonly target_id?: string;
}

export interface PublicDeploymentApproveInput extends PublicActorInput {
  readonly deploymentId: string;
  readonly policy_decision_id?: string;
}

export interface PublicRouteServices {
  readonly authenticate: (
    request: Request,
  ) => Promise<PublicAuthResult> | PublicAuthResult;
  readonly spaces: {
    list(input: PublicActorInput): Promise<unknown> | unknown;
    create(input: PublicSpaceCreateInput): Promise<unknown> | unknown;
  };
  readonly groups: {
    list(input: PublicGroupListInput): Promise<unknown> | unknown;
    create(input: PublicGroupCreateInput): Promise<unknown> | unknown;
  };
  readonly deployments: DeploymentService;
  readonly capabilities?: {
    reference(input: PublicActorInput): Promise<unknown> | unknown;
  };
}

// DeploymentService is the canonical Deployment-centric façade. Phase 3 Agent A
// is producing the concrete implementation (`deployment_service.ts`); routes
// only depend on this interface so that the public API can land in lockstep
// with the docs / contract surface.
export interface DeploymentService {
  resolveDeployment(
    input: PublicDeploymentCreateInput,
  ): Promise<DeploymentEnvelope> | DeploymentEnvelope;
  applyDeployment(
    input: PublicDeploymentCreateInput,
  ): Promise<DeploymentEnvelope> | DeploymentEnvelope;
  previewDeployment(
    input: PublicDeploymentCreateInput,
  ):
    | Promise<DeploymentMutationResponse>
    | DeploymentMutationResponse;
  applyResolved(
    input: PublicDeploymentGetInput,
  ): Promise<DeploymentEnvelope> | DeploymentEnvelope;
  approveDeployment(
    input: PublicDeploymentApproveInput,
  ): Promise<DeploymentEnvelope> | DeploymentEnvelope;
  rollbackGroup(
    input: PublicGroupRollbackInput,
  ): Promise<DeploymentEnvelope> | DeploymentEnvelope;
  getDeployment(
    input: PublicDeploymentGetInput,
  ): Promise<Deployment | null> | Deployment | null;
  listDeployments(
    input: PublicDeploymentListInput,
  ): Promise<readonly Deployment[]> | readonly Deployment[];
  getGroupHead(
    input: PublicGroupRefInput,
  ): Promise<GroupHead | null> | GroupHead | null;
  listObservations(
    input: PublicDeploymentGetInput,
  ):
    | Promise<readonly ProviderObservation[]>
    | readonly ProviderObservation[];
}

export interface RegisterPublicRoutesOptions {
  readonly services: PublicRouteServices;
}

export type PublicAuthResult =
  | { readonly ok: true; readonly actor: ActorContext }
  | { readonly ok: false; readonly status?: 401 | 403; readonly error: string };

export interface PublicActorInput {
  readonly actor: ActorContext;
}

export interface PublicSpaceCreateInput extends PublicActorInput {
  readonly name?: string;
  readonly slug?: string;
  readonly metadata?: JsonObject;
}

export interface PublicGroupListInput extends PublicActorInput {
  readonly spaceId?: string;
}

export interface PublicGroupCreateInput extends PublicActorInput {
  readonly spaceId: string;
  readonly name?: string;
  readonly envName?: string;
  readonly metadata?: JsonObject;
}

export function registerPublicRoutes(
  app: HonoApp,
  options: RegisterPublicRoutesOptions,
): void {
  registerApiErrorHandler(app);
  const { services } = options;

  app.get(TAKOSUMI_PAAS_PUBLIC_PATHS.capabilities, async (c) => {
    const auth = await services.authenticate(c.req.raw);
    if (!auth.ok) return publicAuthError(c, auth);
    if (services.capabilities) {
      const capabilities = await services.capabilities.reference({
        actor: auth.actor,
      });
      return c.json({ capabilities });
    }
    return c.json({ capabilities: createPublicCapabilitiesReference() });
  });

  app.get(TAKOSUMI_PAAS_PUBLIC_PATHS.spaces, async (c) => {
    const auth = await services.authenticate(c.req.raw);
    if (!auth.ok) return publicAuthError(c, auth);
    const spaces = await services.spaces.list({ actor: auth.actor });
    return c.json({ spaces });
  });

  app.post(TAKOSUMI_PAAS_PUBLIC_PATHS.spaces, async (c) => {
    const auth = await services.authenticate(c.req.raw);
    if (!auth.ok) return publicAuthError(c, auth);
    const request = await readJsonObject(c.req.raw);
    const requestedSpaceId = optionalString(request.slug);
    const actorSpaceError = actorSpaceBoundaryError(
      c,
      auth.actor,
      requestedSpaceId,
    );
    if (actorSpaceError) return actorSpaceError;
    const space = await services.spaces.create({
      actor: auth.actor,
      name: optionalString(request.name),
      slug: optionalString(request.slug),
      metadata: optionalJsonObject(request.metadata),
    });
    return c.json({ space }, 201);
  });

  app.get(TAKOSUMI_PAAS_PUBLIC_PATHS.groups, async (c) => {
    const auth = await services.authenticate(c.req.raw);
    if (!auth.ok) return publicAuthError(c, auth);
    const requestedSpaceId = querySpaceId(c);
    const actorSpaceError = actorSpaceBoundaryError(
      c,
      auth.actor,
      requestedSpaceId,
    );
    if (actorSpaceError) return actorSpaceError;
    const groups = await services.groups.list({
      actor: auth.actor,
      spaceId: requestedSpaceId ?? auth.actor.spaceId,
    });
    assertCatalogConditionReasons(groups, "public groups list");
    return c.json({ groups });
  });

  app.post(TAKOSUMI_PAAS_PUBLIC_PATHS.groups, async (c) => {
    const auth = await services.authenticate(c.req.raw);
    if (!auth.ok) return publicAuthError(c, auth);
    const request = await readJsonObject(c.req.raw);
    const spaceId = optionalString(request.spaceId) ?? auth.actor.spaceId;
    const actorSpaceError = actorSpaceBoundaryError(c, auth.actor, spaceId);
    if (actorSpaceError) return actorSpaceError;
    if (!spaceId) {
      return c.json(apiError("invalid_argument", "spaceId is required"), 400);
    }
    const group = await services.groups.create({
      actor: auth.actor,
      spaceId,
      name: optionalString(request.name),
      envName: optionalString(request.envName),
      metadata: optionalJsonObject(request.metadata),
    });
    assertCatalogConditionReasons(group, "public group create");
    return c.json({ group }, 201);
  });

  app.post(TAKOSUMI_PAAS_PUBLIC_PATHS.deployments, async (c) => {
    const auth = await services.authenticate(c.req.raw);
    if (!auth.ok) return publicAuthError(c, auth);
    const request = await readJsonObject(c.req.raw);
    const mode = readDeploymentMode(request.mode);
    if (!mode.ok) {
      return c.json(apiError("invalid_argument", mode.error), 400);
    }
    const source = readPublicDeploySource(request.source);
    if (!source.ok) {
      return c.json(apiError("invalid_argument", source.error), 400);
    }
    const requestedSpaceId = optionalString(request.space_id) ??
      auth.actor.spaceId;
    const actorSpaceError = actorSpaceBoundaryError(
      c,
      auth.actor,
      requestedSpaceId,
    );
    if (actorSpaceError) return actorSpaceError;
    const input: PublicDeploymentCreateInput = {
      actor: auth.actor,
      mode: mode.value,
      manifest: request.manifest,
      source: source.value,
      target_id: optionalString(request.target_id),
      group: optionalString(request.group),
      env: optionalString(request.env),
      space_id: requestedSpaceId,
    };

    if (mode.value === "preview") {
      const summary = await services.deployments.previewDeployment(input);
      assertCatalogConditionReasons(summary, "public deployment preview");
      return c.json(summary, 200);
    }

    if (mode.value === "rollback") {
      const groupId = input.group;
      if (!groupId) {
        return c.json(
          apiError("invalid_argument", "group is required for rollback"),
          400,
        );
      }
      if (!requestedSpaceId) {
        return c.json(
          apiError("invalid_argument", "spaceId is required for rollback"),
          400,
        );
      }
      const result = await services.deployments.rollbackGroup({
        actor: auth.actor,
        groupId,
        target_id: input.target_id,
        space_id: requestedSpaceId,
      });
      assertCatalogConditionReasons(result, "public deployment rollback");
      return c.json(toMutationResponse(result), 201);
    }

    if (mode.value === "resolve") {
      const result = await services.deployments.resolveDeployment(input);
      assertCatalogConditionReasons(result, "public deployment resolve");
      return c.json(toMutationResponse(result), 201);
    }

    // mode === "apply"
    const result = await services.deployments.applyDeployment(input);
    assertCatalogConditionReasons(result, "public deployment apply");
    return c.json(toMutationResponse(result), 201);
  });

  app.get(TAKOSUMI_PAAS_PUBLIC_PATHS.deployments, async (c) => {
    const auth = await services.authenticate(c.req.raw);
    if (!auth.ok) return publicAuthError(c, auth);
    const status = c.req.query("status");
    const requestedSpaceId = querySpaceId(c);
    const actorSpaceError = actorSpaceBoundaryError(
      c,
      auth.actor,
      requestedSpaceId,
    );
    if (actorSpaceError) return actorSpaceError;
    const deployments = await services.deployments.listDeployments({
      actor: auth.actor,
      group: c.req.query("group"),
      status: isDeploymentStatus(status) ? status : undefined,
      space_id: requestedSpaceId ?? auth.actor.spaceId,
    });
    assertCatalogConditionReasons(deployments, "public deployments list");
    return c.json({ deployments });
  });

  app.get(TAKOSUMI_PAAS_PUBLIC_PATHS.deployment, async (c) => {
    const auth = await services.authenticate(c.req.raw);
    if (!auth.ok) return publicAuthError(c, auth);
    const requestedSpaceId = querySpaceId(c);
    const actorSpaceError = actorSpaceBoundaryError(
      c,
      auth.actor,
      requestedSpaceId,
    );
    if (actorSpaceError) return actorSpaceError;
    const deployment = await services.deployments.getDeployment({
      actor: auth.actor,
      deploymentId: c.req.param("deploymentId"),
    });
    if (
      !deployment ||
      !deploymentVisibleToActor(deployment, auth.actor, requestedSpaceId)
    ) {
      return c.json(apiError("not_found", "deployment not found"), 404);
    }
    assertCatalogConditionReasons(deployment, "public deployment get");
    return c.json({ deployment });
  });

  app.post(TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApply, async (c) => {
    const auth = await services.authenticate(c.req.raw);
    if (!auth.ok) return publicAuthError(c, auth);
    const requestedSpaceId = querySpaceId(c);
    const actorSpaceError = actorSpaceBoundaryError(
      c,
      auth.actor,
      requestedSpaceId,
    );
    if (actorSpaceError) return actorSpaceError;
    const existing = await services.deployments.getDeployment({
      actor: auth.actor,
      deploymentId: c.req.param("deploymentId"),
    });
    if (
      !existing ||
      !deploymentVisibleToActor(existing, auth.actor, requestedSpaceId)
    ) {
      return c.json(apiError("not_found", "deployment not found"), 404);
    }
    const result = await services.deployments.applyResolved({
      actor: auth.actor,
      deploymentId: c.req.param("deploymentId"),
    });
    assertCatalogConditionReasons(result, "public deployment apply by id");
    return c.json(toMutationResponse(result), 201);
  });

  app.post(TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApprove, async (c) => {
    const auth = await services.authenticate(c.req.raw);
    if (!auth.ok) return publicAuthError(c, auth);
    const request = await readJsonObject(c.req.raw);
    const requestedSpaceId = optionalString(request.space_id) ??
      optionalString(request.spaceId) ?? querySpaceId(c);
    const actorSpaceError = actorSpaceBoundaryError(
      c,
      auth.actor,
      requestedSpaceId,
    );
    if (actorSpaceError) return actorSpaceError;
    const existing = await services.deployments.getDeployment({
      actor: auth.actor,
      deploymentId: c.req.param("deploymentId"),
    });
    if (
      !existing ||
      !deploymentVisibleToActor(existing, auth.actor, requestedSpaceId)
    ) {
      return c.json(apiError("not_found", "deployment not found"), 404);
    }
    const result = await services.deployments.approveDeployment({
      actor: auth.actor,
      deploymentId: c.req.param("deploymentId"),
      policy_decision_id: optionalString(request.policy_decision_id),
    });
    assertCatalogConditionReasons(result, "public deployment approve");
    return c.json(toMutationResponse(result));
  });

  app.get(TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentObservations, async (c) => {
    const auth = await services.authenticate(c.req.raw);
    if (!auth.ok) return publicAuthError(c, auth);
    const requestedSpaceId = querySpaceId(c);
    const actorSpaceError = actorSpaceBoundaryError(
      c,
      auth.actor,
      requestedSpaceId,
    );
    if (actorSpaceError) return actorSpaceError;
    const deployment = await services.deployments.getDeployment({
      actor: auth.actor,
      deploymentId: c.req.param("deploymentId"),
    });
    if (
      !deployment ||
      !deploymentVisibleToActor(deployment, auth.actor, requestedSpaceId)
    ) {
      return c.json(apiError("not_found", "deployment not found"), 404);
    }
    const observations = await services.deployments.listObservations({
      actor: auth.actor,
      deploymentId: c.req.param("deploymentId"),
    });
    return c.json({ observations });
  });

  app.get(TAKOSUMI_PAAS_PUBLIC_PATHS.groupHead, async (c) => {
    const auth = await services.authenticate(c.req.raw);
    if (!auth.ok) return publicAuthError(c, auth);
    const requestedSpaceId = querySpaceId(c) ?? auth.actor.spaceId;
    const actorSpaceError = actorSpaceBoundaryError(
      c,
      auth.actor,
      requestedSpaceId,
    );
    if (actorSpaceError) return actorSpaceError;
    if (!requestedSpaceId) {
      return c.json(apiError("invalid_argument", "spaceId is required"), 400);
    }
    const head = await services.deployments.getGroupHead({
      actor: auth.actor,
      groupId: c.req.param("groupId"),
      space_id: requestedSpaceId,
    });
    if (!head || !groupHeadVisibleToActor(head, auth.actor, requestedSpaceId)) {
      return c.json(apiError("not_found", "group head not found"), 404);
    }
    return c.json({ head });
  });

  app.post(TAKOSUMI_PAAS_PUBLIC_PATHS.groupRollback, async (c) => {
    const auth = await services.authenticate(c.req.raw);
    if (!auth.ok) return publicAuthError(c, auth);
    const request = await readJsonObject(c.req.raw).catch(() =>
      ({}) as Record<string, unknown>
    );
    const requestedSpaceId = optionalString(request.space_id) ??
      optionalString(request.spaceId) ?? querySpaceId(c) ?? auth.actor.spaceId;
    const actorSpaceError = actorSpaceBoundaryError(
      c,
      auth.actor,
      requestedSpaceId,
    );
    if (actorSpaceError) return actorSpaceError;
    if (!requestedSpaceId) {
      return c.json(apiError("invalid_argument", "spaceId is required"), 400);
    }
    const result = await services.deployments.rollbackGroup({
      actor: auth.actor,
      groupId: c.req.param("groupId"),
      target_id: optionalString(request.target_id),
      space_id: requestedSpaceId,
    });
    assertCatalogConditionReasons(result, "public group rollback");
    return c.json(toMutationResponse(result), 201);
  });
}

function publicAuthError(
  c: Context,
  auth: Extract<PublicAuthResult, { ok: false }>,
): Response {
  const status = auth.status ?? 401;
  return c.json(
    apiError(
      status === 403 ? "permission_denied" : "unauthenticated",
      auth.error,
    ),
    status,
  );
}

function querySpaceId(c: Context): string | undefined {
  return c.req.query("spaceId") ?? c.req.query("space_id") ??
    c.req.query("space");
}

function actorSpaceBoundaryError(
  c: Context,
  actor: ActorContext,
  requestedSpaceId: string | undefined,
): Response | undefined {
  if (
    actor.spaceId && requestedSpaceId && actor.spaceId !== requestedSpaceId
  ) {
    return c.json(
      apiError("permission_denied", "actor cannot access requested space"),
      403,
    );
  }
  return undefined;
}

function deploymentVisibleToActor(
  deployment: Deployment,
  actor: ActorContext,
  requestedSpaceId: string | undefined,
): boolean {
  if (actor.spaceId && deployment.space_id !== actor.spaceId) return false;
  if (requestedSpaceId && deployment.space_id !== requestedSpaceId) {
    return false;
  }
  return true;
}

function groupHeadVisibleToActor(
  head: GroupHead,
  actor: ActorContext,
  requestedSpaceId: string,
): boolean {
  if (actor.spaceId && head.space_id !== actor.spaceId) return false;
  return head.space_id === requestedSpaceId;
}

export interface PublicCapabilitiesReferenceEndpoint {
  readonly method: string;
  readonly path: string;
  readonly summary: string;
}

export interface PublicCapabilitiesReference {
  readonly service: "takosumi";
  readonly audience: "public-api";
  readonly endpoints: readonly PublicCapabilitiesReferenceEndpoint[];
}

export function createPublicCapabilitiesReference(): PublicCapabilitiesReference {
  return {
    service: "takosumi",
    audience: "public-api",
    endpoints: [
      {
        method: "GET",
        path: TAKOSUMI_PAAS_PUBLIC_PATHS.capabilities,
        summary: "Returns public API route capabilities.",
      },
      {
        method: "GET",
        path: TAKOSUMI_PAAS_PUBLIC_PATHS.spaces,
        summary: "Lists spaces visible to the authenticated actor.",
      },
      {
        method: "POST",
        path: TAKOSUMI_PAAS_PUBLIC_PATHS.spaces,
        summary: "Creates a space for the authenticated actor.",
      },
      {
        method: "GET",
        path: TAKOSUMI_PAAS_PUBLIC_PATHS.groups,
        summary: "Lists groups for a space visible to the authenticated actor.",
      },
      {
        method: "POST",
        path: TAKOSUMI_PAAS_PUBLIC_PATHS.groups,
        summary: "Creates a group in a space.",
      },
      {
        method: "POST",
        path: TAKOSUMI_PAAS_PUBLIC_PATHS.deployments,
        summary:
          "Creates a Deployment with mode=preview|resolve|apply|rollback.",
      },
      {
        method: "GET",
        path: TAKOSUMI_PAAS_PUBLIC_PATHS.deployments,
        summary: "Lists Deployments for a group / status filter.",
      },
      {
        method: "GET",
        path: TAKOSUMI_PAAS_PUBLIC_PATHS.deployment,
        summary: "Returns a Deployment by id.",
      },
      {
        method: "POST",
        path: TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApply,
        summary: "Applies a resolved Deployment.",
      },
      {
        method: "POST",
        path: TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApprove,
        summary: "Attaches an approval to a Deployment.",
      },
      {
        method: "GET",
        path: TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentObservations,
        summary: "Streams provider observations for a Deployment.",
      },
      {
        method: "GET",
        path: TAKOSUMI_PAAS_PUBLIC_PATHS.groupHead,
        summary: "Returns the GroupHead pointer for a group.",
      },
      {
        method: "POST",
        path: TAKOSUMI_PAAS_PUBLIC_PATHS.groupRollback,
        summary: "Rolls a GroupHead back to its previous Deployment.",
      },
    ],
  } as const;
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

function readDeploymentMode(
  value: unknown,
): { ok: true; value: DeploymentMode } | { ok: false; error: string } {
  if (
    value === "preview" || value === "resolve" || value === "apply" ||
    value === "rollback"
  ) {
    return { ok: true, value };
  }
  return {
    ok: false,
    error: "mode must be one of preview|resolve|apply|rollback",
  };
}

function readPublicDeploySource(
  value: unknown,
):
  | { ok: true; value?: PublicDeploySourceInput }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (!isJsonObject(value)) {
    return { ok: false, error: "source must be an object" };
  }
  if (value.kind !== "git") {
    return { ok: false, error: "source.kind must be git" };
  }
  const repositoryId = nonEmptyString(value.repository_id);
  if (!repositoryId) {
    return { ok: false, error: "source.repository_id is required" };
  }
  const ref = nonEmptyString(value.ref);
  if (!ref) return { ok: false, error: "source.ref is required" };
  const source: PublicDeployGitSourceInput = {
    kind: "git",
    repository_id: repositoryId,
    ref,
    path: optionalString(value.path),
    manifest_path: optionalString(value.manifest_path),
  };
  return { ok: true, value: source };
}

const DEPLOYMENT_STATUSES: ReadonlySet<DeploymentStatus> = new Set([
  "preview",
  "resolved",
  "applying",
  "applied",
  "failed",
  "rolled-back",
]);

function isDeploymentStatus(value: unknown): value is DeploymentStatus {
  return typeof value === "string" &&
    DEPLOYMENT_STATUSES.has(value as DeploymentStatus);
}

function toMutationResponse(
  envelope: DeploymentEnvelope,
): DeploymentMutationResponse {
  return {
    deployment_id: envelope.deployment.id,
    status: envelope.deployment.status,
    conditions: envelope.deployment.conditions,
    expansion_summary: envelope.expansion_summary,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalJsonObject(value: unknown): JsonObject | undefined {
  if (!isJsonObject(value)) return undefined;
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return true;
}
