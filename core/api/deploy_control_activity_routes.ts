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
  ensureSpacePermission,
  ensureValidParam,
  errorEnvelope,
  notImplemented,
  parsePageParams,
  runHandler,
  SPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_INSTALLATION_BACKUPS_ROUTE,
  TAKOSUMI_SPACE_ACTIVITY_ROUTE,
  TAKOSUMI_SPACE_BACKUP_RESTORES_ROUTE,
  TAKOSUMI_SPACE_BACKUPS_ROUTE,
} from "./deploy_control_route_paths.ts";

const SPACE_ID_PARAM = { param: "spaceId", pattern: SPACE_ID_PATTERN } as const;
const INSTALLATION_ID_PARAM = { id: "installationId" } as const;

export const DEPLOY_CONTROL_ACTIVITY_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_SPACE_ACTIVITY_ROUTE,
      summary:
        "Lists a Space's recent Activity audit trail (newest first; ?limit= 1..500).",
      auth: "deploy-control-token",
      operationId: "listSpaceActivity",
      openapi: { pathParams: ["spaceId"], okSchema: "ListActivityResponse" },
      notImplementedMessage: "activity not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_SPACE_BACKUPS_ROUTE,
      summary:
        "Creates a sealed zstd control backup of a Space's ledger in R2_BACKUPS (no secret material).",
      auth: "deploy-control-token",
      operationId: "createSpaceBackup",
      openapi: {
        pathParams: ["spaceId"],
        okStatus: "201",
        okSchema: "CreateBackupResponse",
      },
      notImplementedMessage: "backups not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_INSTALLATION_BACKUPS_ROUTE,
      summary:
        "Creates a sealed control backup for the Installation's Space after resolving the Installation.",
      auth: "deploy-control-token",
      operationId: "createInstallationBackup",
      openapi: {
        pathParams: ["installationId"],
        okStatus: "201",
        okSchema: "CreateBackupResponse",
      },
      notImplementedMessage: "backups not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_SPACE_BACKUPS_ROUTE,
      summary: "Lists a Space's control backups (newest first).",
      auth: "deploy-control-token",
      operationId: "listSpaceBackups",
      openapi: { pathParams: ["spaceId"], okSchema: "ListBackupsResponse" },
      notImplementedMessage: "backups not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_SPACE_BACKUP_RESTORES_ROUTE,
      summary:
        "Creates a destructive restore Run from a Backup; the Run waits for approval before dispatch.",
      auth: "deploy-control-token",
      operationId: "createBackupRestore",
      openapi: {
        pathParams: ["spaceId", "backupId"],
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

  app.get(TAKOSUMI_SPACE_ACTIVITY_ROUTE, async (c: Context) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const activityService = dependencies.activityService;
    if (!activityService) {
      return c.json(notImplemented(c, "activity not wired"), 501);
    }
    const idCheck = ensureValidParam(c, "spaceId", SPACE_ID_PATTERN);
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
      ensureSpacePermission(auth.principal, idCheck.value);
      const events = await activityService.list(idCheck.value, limit.value);
      return c.json({ events }, 200);
    });
  });

  app.post(
    TAKOSUMI_SPACE_BACKUPS_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.backupsService ? undefined : "backups not wired",
      param: SPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const backup = await dependencies.backupsService!.createBackup({
          spaceId: id,
        });
        return c.json({ backup }, 201);
      },
    }),
  );

  app.post(
    TAKOSUMI_INSTALLATION_BACKUPS_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.backupsService && deps.controller
          ? undefined
          : "backups not wired",
      param: INSTALLATION_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        const response = await dependencies.controller!.getInstallation(id);
        ensureSpacePermission(principal, response.installation.spaceId);
        const backup = await dependencies.backupsService!.createBackup({
          spaceId: response.installation.spaceId,
          installationId: response.installation.id,
          environment: response.installation.environment,
        });
        return c.json({ backup }, 201);
      },
    }),
  );

  app.get(
    TAKOSUMI_SPACE_BACKUPS_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.backupsService ? undefined : "backups not wired",
      param: SPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
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
    TAKOSUMI_SPACE_BACKUP_RESTORES_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.controller ? undefined : "deploy control not wired",
      param: SPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
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
            ...(typeof body.installationId === "string"
              ? { installationId: body.installationId }
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
