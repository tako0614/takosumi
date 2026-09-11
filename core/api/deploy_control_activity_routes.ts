/**
 * §27 / §34 Activity audit-trail route plus the §33 / §26 control-backup routes
 * (mounted consecutively in the original). Owns its handlers and its slice of
 * the {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS} descriptor inventory.
 */

import type { Context } from "hono";
import type { CreateBackupRequest } from "../domains/backups/mod.ts";
import { ACTIVITY_MAX_LIMIT } from "takosumi-contract/activity";
import {
  authorizeDeployControl,
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureWorkspacePermission,
  ensureValidId,
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
  TAKOSUMI_WORKSPACE_BACKUPS_ROUTE,
} from "./deploy_control_route_paths.ts";

const WORKSPACE_ID_PARAM = {
  param: "workspaceId",
  pattern: WORKSPACE_ID_PATTERN,
} as const;
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
        "Creates a sealed, partial control-ledger export in host artifact storage (no secret material; not restorable).",
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
        "Creates a sealed, partial control export for the Capsule's Workspace after resolving the Capsule.",
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
      summary: "Lists a Workspace's partial control exports (newest first).",
      auth: "deploy-control-token",
      operationId: "listWorkspaceBackups",
      openapi: { pathParams: ["workspaceId"], okSchema: "ListBackupsResponse" },
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

  // Capture the original private epoch before asynchronous authorization, but
  // disclose capture errors only after authentication and Workspace access.
  const createBackupRoute = (scope: "workspace" | "capsule") =>
    async (c: Context): Promise<Response> => {
      const service = dependencies.backupsService;
      const wired = service && (scope === "workspace" || dependencies.controller);
      const idCheck = scope === "workspace"
        ? ensureValidParam(c, "workspaceId", WORKSPACE_ID_PATTERN)
        : ensureValidId(c, "capsuleId");
      const prepared = wired && idCheck.kind !== "invalid"
        ? await (async () => {
          try {
            const capsule = scope === "capsule"
              ? (await dependencies.controller!.getCapsule(idCheck.value)).capsule
              : undefined;
            const request: CreateBackupRequest = capsule
              ? { workspaceId: capsule.workspaceId, capsuleId: capsule.id, environment: capsule.environment }
              : { workspaceId: idCheck.value };
            const authority = await service.captureManagementAuthority(request.workspaceId)
              .then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error }),
              );
            return { ok: true as const, request, authority };
          } catch (error) {
            return { ok: false as const, error };
          }
        })()
        : undefined;
      const auth = await authorizeDeployControl(c, dependencies);
      if (!auth.ok) return auth.response;
      if (!wired) return c.json(notImplemented(c, "backups not wired"), 501);
      if (idCheck.kind === "invalid") return idCheck.response;
      return await runHandler(c, async () => {
        if (!prepared) throw new Error("Backup preparation was not captured");
        if (!prepared.ok) throw prepared.error;
        ensureWorkspacePermission(auth.principal, prepared.request.workspaceId);
        if (!prepared.authority.ok) throw prepared.authority.error;
        const backup = await service.createBackup({
          ...prepared.request,
          expectedWorkspaceManagementAuthority: prepared.authority.value,
        });
        return c.json({ backup }, 201);
      });
    };

  app.post(TAKOSUMI_WORKSPACE_BACKUPS_ROUTE, createBackupRoute("workspace"));
  app.post(TAKOSUMI_CAPSULE_BACKUPS_ROUTE, createBackupRoute("capsule"));

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

}
