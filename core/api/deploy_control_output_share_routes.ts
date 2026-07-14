/**
 * §18 cross-Workspace OutputShare routes: create / list / approve / revoke. A
 * producer Capsule's Workspace authorizes a consumer Workspace to consume named
 * outputs; create + revoke are gated on the granting Workspace, approve on the
 * receiving Workspace, and list returns grants in either direction. Owns its
 * handlers and its slice of the
 * {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS}
 * descriptor inventory.
 */

import type {
  CreateOutputShareRequest,
} from "../domains/output-shares/mod.ts";
import {
  OpenTofuControllerError,
} from "../domains/deploy-control/mod.ts";
import {
  authorizeDeployControl,
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureWorkspacePermission,
  errorEnvelope,
  notImplemented,
  parsePageParams,
  readJsonBody,
  runHandler,
  OUTPUT_SHARE_ID_PATTERN,
  WORKSPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_OUTPUT_SHARE_APPROVE_ROUTE,
  TAKOSUMI_OUTPUT_SHARE_REVOKE_ROUTE,
  TAKOSUMI_OUTPUT_SHARES_ROUTE,
} from "./deploy_control_route_paths.ts";

export const DEPLOY_CONTROL_OUTPUT_SHARE_ENDPOINTS:
  readonly DeployControlEndpoint[] = [
    {
      method: "POST",
      path: TAKOSUMI_OUTPUT_SHARES_ROUTE,
      summary:
        "Creates a pending cross-Workspace OutputShare (permission-gated on the granting Workspace).",
      auth: "deploy-control-token",
      operationId: "createOutputShare",
      openapi: {
        requestSchema: "CreateOutputShareRequest",
        okStatus: "201",
        okSchema: "OutputShareResponse",
      },
      notImplementedMessage: "output shares service is not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_OUTPUT_SHARES_ROUTE,
      summary:
        "Lists the OutputShares a Workspace granted or received (?workspaceId=).",
      auth: "deploy-control-token",
      operationId: "listOutputShares",
      openapi: { okSchema: "ListOutputSharesResponse" },
      notImplementedMessage: "output shares service is not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_OUTPUT_SHARE_APPROVE_ROUTE,
      summary:
        "Approves a pending cross-Workspace OutputShare (permission-gated via its receiving Workspace).",
      auth: "deploy-control-token",
      operationId: "approveOutputShare",
      openapi: { pathParams: ["shareId"], okSchema: "OutputShareResponse" },
      notImplementedMessage: "output shares service is not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_OUTPUT_SHARE_REVOKE_ROUTE,
      summary:
        "Revokes a cross-Workspace OutputShare (permission-gated via its granting Workspace).",
      auth: "deploy-control-token",
      operationId: "revokeOutputShare",
      openapi: { pathParams: ["shareId"], okSchema: "OutputShareResponse" },
      notImplementedMessage: "output shares service is not wired",
    },
  ];

export function mountDeployControlOutputShareRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, deployControlBodyLimit } = ctx;
  const outputSharesService = dependencies.outputSharesService;
  const requireOutputShares = (
    deps: typeof dependencies,
  ): string | undefined =>
    deps.outputSharesService ? undefined : "output shares not wired";

  app.post(
    TAKOSUMI_OUTPUT_SHARES_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requireOutputShares,
      enforceBody: true,
      handler: async ({ c, principal }) => {
        const body = await readJsonBody<CreateOutputShareRequest>(
          c,
          "outputShareCreate",
        );
        ensureWorkspacePermission(principal, body.fromWorkspaceId);
        const share = await outputSharesService!.createShare(body);
        return c.json({ share }, 201);
      },
    }),
  );

  app.get(TAKOSUMI_OUTPUT_SHARES_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    if (!outputSharesService) {
      return c.json(notImplemented(c, "output shares not wired"), 501);
    }
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
      return c.json(
        errorEnvelope(
          c,
          "invalid_argument",
          "workspaceId query parameter is required and must be a valid Workspace id",
        ),
        400,
      );
    }
    const page = parsePageParams(c);
    if (page.kind === "invalid") return page.response;
    return await runHandler(c, async () => {
      ensureWorkspacePermission(auth.principal, workspaceId);
      const { items, nextCursor } =
        await outputSharesService.listForWorkspacePage(workspaceId, page.value);
      return c.json(
        {
          shares: items,
          ...(nextCursor !== undefined ? { nextCursor } : {}),
        },
        200,
      );
    });
  });

  app.post(
    TAKOSUMI_OUTPUT_SHARE_APPROVE_ROUTE,
    defineRoute({
      ctx,
      requireService: requireOutputShares,
      param: { param: "shareId", pattern: OUTPUT_SHARE_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        const existing = await outputSharesService!.getShare(id);
        if (!existing) {
          throw new OpenTofuControllerError(
            "not_found",
            `output share ${id} not found`,
          );
        }
        ensureWorkspacePermission(principal, existing.toWorkspaceId);
        const share = await outputSharesService!.approveShare(id);
        return c.json({ share }, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_OUTPUT_SHARE_REVOKE_ROUTE,
    defineRoute({
      ctx,
      requireService: requireOutputShares,
      param: { param: "shareId", pattern: OUTPUT_SHARE_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        // Resolve the share first so revoke is gated via the granting Workspace.
        const existing = await outputSharesService!.getShare(id);
        if (!existing) {
          throw new OpenTofuControllerError(
            "not_found",
            `output share ${id} not found`,
          );
        }
        ensureWorkspacePermission(principal, existing.fromWorkspaceId);
        const share = await outputSharesService!.revokeShare(id);
        return c.json({ share }, 200);
      },
    }),
  );
}
