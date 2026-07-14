/**
 * §27 / §34 Activity audit-trail route plus the §33 / §26 control-backup routes
 * (mounted consecutively in the original). Owns its handlers and its slice of
 * the {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS} descriptor inventory.
 */

import type { Context } from "hono";
import { ACTIVITY_MAX_LIMIT } from "takosumi-contract/activity";
import {
  authorizeDeployControl,
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureWorkspacePermission,
  ensureValidParam,
  errorEnvelope,
  notImplemented,
  parsePageParams,
  runHandler,
  WORKSPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_CAPSULE_BACKUPS_ROUTE,
  TAKOSUMI_WORKSPACE_ACTIVITY_ROUTE,
  TAKOSUMI_WORKSPACE_BACKUP_RESTORES_ROUTE,
  TAKOSUMI_WORKSPACE_BACKUPS_ROUTE,
} from "./deploy_control_route_paths.ts";

const WORKSPACE_ID_PARAM = {
  param: "workspaceId",
  pattern: WORKSPACE_ID_PATTERN,
} as const;
const CAPSULE_ID_PARAM = { id: "capsuleId" } as const;

export const DEPLOY_CONTROL_ACTIVITY_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACE_ACTIVITY_ROUTE,
      summary:
        "Lists a Workspace's recent Activity audit trail (newest first; ?limit= 1..500).",
      auth: "deploy-control-token",
      operationId: "listWorkspaceActivity",
      openapi: { pathParams: ["workspaceId"], okSchema: "ListActivityResponse" },
      notImplementedMessage: "activity not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACE_BACKUPS_ROUTE,
      summary:
    "Creates a sealed zstd control backup of a Workspace ledger in host artifact storage (no secret material).",
      auth: "deploy-control-token",
      operationId: "createWorkspaceBackup",
      openapi: {
        pathParams: ["workspaceId"],
        okStatus: "201",
        okSchema: "CreateBackupResponse",
      },
      notImplementedMessage: "backups not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CAPSULE_BACKUPS_ROUTE,
      summary:
        "Creates a sealed control backup for the Capsule's Workspace after resolving the Capsule.",
      auth: "deploy-control-token",
      operationId: "createCapsuleBackup",
      openapi: {
        pathParams: ["capsuleId"],
        okStatus: "201",
        okSchema: "CreateBackupResponse",
      },
      notImplementedMessage: "backups not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACE_BACKUPS_ROUTE,
      summary: "Lists a Workspace's control backups (newest first).",
      auth: "deploy-control-token",
      operationId: "listWorkspaceBackups",
      openapi: { pathParams: ["workspaceId"], okSchema: "ListBackupsResponse" },
      notImplementedMessage: "backups not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACE_BACKUP_RESTORES_ROUTE,
      summary:
        "Creates a destructive restore Run from a Backup; the Run waits for approval before dispatch.",
      auth: "deploy-control-token",
      operationId: "createBackupRestore",
      openapi: {
        pathParams: ["workspaceId", "backupId"],
        requestSchema: "CreateRestoreRequest",
        okStatus: "201",
        okSchema: "CreateRestoreResponse",
      },
      notImplementedMessage: "deploy control not wired",
    },
  ];

/**
 * Parses + validates the `?limit=` query for the Activity listing: an integer in
 * `1..ACTIVITY_MAX_LIMIT`, or absent (returns `undefined`, letting the service
 * apply its default). Anything else is a 400.
 */
function parseActivityLimit(
  raw: string | undefined,
):
  | { readonly kind: "ok"; readonly value: number | undefined }
  | { readonly kind: "invalid" } {
  if (raw === undefined || raw === "") return { kind: "ok", value: undefined };
  if (!/^\d+$/.test(raw)) return { kind: "invalid" };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > ACTIVITY_MAX_LIMIT) {
    return { kind: "invalid" };
  }
  return { kind: "ok", value };
}

export function mountDeployControlActivityRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies } = ctx;

  app.get(TAKOSUMI_WORKSPACE_ACTIVITY_ROUTE, async (c: Context) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const activityService = dependencies.activityService;
    if (!activityService) {
      return c.json(notImplemented(c, "activity not wired"), 501);
    }
    const idCheck = ensureValidParam(c, "workspaceId", WORKSPACE_ID_PATTERN);
    if (idCheck.kind === "invalid") return idCheck.response;
    const limit = parseActivityLimit(c.req.query("limit"));
    if (limit.kind === "invalid") {
      return c.json(
        errorEnvelope(
          c,
          "invalid_argument",
          `limit must be an integer in 1..${ACTIVITY_MAX_LIMIT}`,
        ),
        400,
      );
    }
    return await runHandler(c, async () => {
      ensureWorkspacePermission(auth.principal, idCheck.value);
      const events = await activityService.list(idCheck.value, limit.value);
      return c.json({ events }, 200);
    });
  });

  app.post(
    TAKOSUMI_WORKSPACE_BACKUPS_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.backupsService ? undefined : "backups not wired",
      param: WORKSPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureWorkspacePermission(principal, id);
        const backup = await dependencies.backupsService!.createBackup({
          workspaceId: id,
        });
        return c.json({ backup }, 201);
      },
    }),
  );

  app.post(
    TAKOSUMI_CAPSULE_BACKUPS_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.backupsService && deps.controller
          ? undefined
          : "backups not wired",
      param: CAPSULE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const response = await dependencies.controller!.getCapsule(id);
        ensureWorkspacePermission(principal, response.capsule.workspaceId);
        const backup = await dependencies.backupsService!.createBackup({
          workspaceId: response.capsule.workspaceId,
          capsuleId: response.capsule.id,
          environment: response.capsule.environment,
        });
        return c.json({ backup }, 201);
      },
    }),
  );

  app.get(
    TAKOSUMI_WORKSPACE_BACKUPS_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.backupsService ? undefined : "backups not wired",
      param: WORKSPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureWorkspacePermission(principal, id);
        const page = parsePageParams(c);
        if (page.kind === "invalid") return page.response;
        return c.json(
          await dependencies.backupsService!.listBackups(id, page.value),
          200,
        );
      },
    }),
  );

  app.post(
    TAKOSUMI_WORKSPACE_BACKUP_RESTORES_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.controller ? undefined : "deploy control not wired",
      param: WORKSPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureWorkspacePermission(principal, id);
        const backupId = c.req.param("backupId");
        if (!backupId || backupId.trim().length === 0) {
          return c.json(
            errorEnvelope(c, "invalid_argument", "backupId is required"),
            400,
          );
        }
        const raw = await c.req.json().catch(() => ({}));
        const body =
          typeof raw === "object" && raw !== null && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
        const stateGeneration = body.stateGeneration;
        if (!Number.isInteger(stateGeneration) || Number(stateGeneration) < 0) {
          return c.json(
            errorEnvelope(
              c,
              "invalid_argument",
              "stateGeneration must be a non-negative integer",
            ),
            400,
          );
        }
        const run = await dependencies.controller!.createRestoreRun(
          id,
          backupId,
          {
            stateGeneration: Number(stateGeneration),
            ...(typeof body.capsuleId === "string"
              ? { capsuleId: body.capsuleId }
              : {}),
            ...(typeof body.environment === "string"
              ? { environment: body.environment }
              : {}),
            ...(typeof body.expectedBackupDigest === "string"
              ? { expectedBackupDigest: body.expectedBackupDigest }
              : {}),
            ...(body.restoreServiceData === true
              ? { restoreServiceData: true }
              : {}),
          },
          { actor: principal.actor },
        );
        return c.json({ run }, 201);
      },
    }),
  );
}
