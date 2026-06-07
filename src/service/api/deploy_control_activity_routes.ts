/**
 * §27 / §34 Activity audit-trail route plus the §33 / §26 control-backup routes
 * (mounted consecutively in the original). Owns its handlers and its slice of
 * the {@link DEPLOY_CONTROL_PUBLIC_ENDPOINTS} descriptor inventory.
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
  runHandler,
  SPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_SPACE_ACTIVITY_ROUTE,
  TAKOSUMI_SPACE_BACKUPS_ROUTE,
} from "./deploy_control_route_paths.ts";

const SPACE_ID_PARAM = { param: "spaceId", pattern: SPACE_ID_PATTERN } as const;

export const DEPLOY_CONTROL_ACTIVITY_ENDPOINTS:
  readonly DeployControlEndpoint[] = [
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
        "Creates a sealed control backup of a Space's ledger (gzip+sealed to R2_BACKUPS; no secret material).",
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
      method: "GET",
      path: TAKOSUMI_SPACE_BACKUPS_ROUTE,
      summary: "Lists a Space's control backups (newest first).",
      auth: "deploy-control-token",
      operationId: "listSpaceBackups",
      openapi: { pathParams: ["spaceId"], okSchema: "ListBackupsResponse" },
      notImplementedMessage: "backups not wired",
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

  app.get(
    TAKOSUMI_SPACE_BACKUPS_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.backupsService ? undefined : "backups not wired",
      param: SPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const backups = await dependencies.backupsService!.listBackups(id);
        return c.json({ backups }, 200);
      },
    }),
  );
}
