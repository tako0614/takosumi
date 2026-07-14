/**
 * Provider-neutral OSS showback routes.
 *
 * Takosumi OSS exposes only disabled/showback settings and recorded usage.
 * Commercial balances, reservations, top-ups, plans, subscriptions, payment
 * providers, and invoices belong to host extensions and are not mounted here.
 */

import type { BillingSettings } from "takosumi-contract/billing";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureWorkspacePermission,
  parsePageParams,
  readJsonBody,
  WORKSPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_WORKSPACE_BILLING_ROUTE,
  TAKOSUMI_WORKSPACE_USAGE_ROUTE,
} from "./deploy_control_route_paths.ts";

const WORKSPACE_ID_PARAM = {
  param: "workspaceId",
  pattern: WORKSPACE_ID_PATTERN,
} as const;

export const DEPLOY_CONTROL_BILLING_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACE_BILLING_ROUTE,
      summary: "Reads the Workspace's disabled/showback setting.",
      auth: "deploy-control-token",
      operationId: "getWorkspaceBilling",
      openapi: {
        pathParams: ["workspaceId"],
        okSchema: "WorkspaceBillingResponse",
      },
      notImplementedMessage: "showback settings not wired",
    },
    {
      method: "PATCH",
      path: TAKOSUMI_WORKSPACE_BILLING_ROUTE,
      summary: "Updates the Workspace's disabled/showback setting.",
      auth: "deploy-control-token",
      operationId: "updateWorkspaceBillingSettings",
      openapi: {
        pathParams: ["workspaceId"],
        requestSchema: "BillingSettingsUpdateRequest",
        okSchema: "WorkspaceBillingResponse",
      },
      notImplementedMessage: "showback settings not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACE_USAGE_ROUTE,
      summary: "Lists recorded showback usage for a Workspace.",
      auth: "deploy-control-token",
      operationId: "listWorkspaceUsage",
      openapi: {
        pathParams: ["workspaceId"],
        okSchema: "WorkspaceUsageResponse",
      },
      notImplementedMessage: "showback usage not wired",
    },
  ];

export function mountDeployControlBillingRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, deployControlBodyLimit, controller } = ctx;

  app.get(
    TAKOSUMI_WORKSPACE_BILLING_ROUTE,
    defineRoute({
      ctx,
      param: WORKSPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureWorkspacePermission(principal, id);
        return c.json(await controller.getWorkspaceBilling(id), 200);
      },
    }),
  );

  app.patch(
    TAKOSUMI_WORKSPACE_BILLING_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      param: WORKSPACE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        ensureWorkspacePermission(principal, id);
        const body = await readJsonBody<{
          readonly billingSettings: BillingSettings;
        }>(c, "billingSettingsUpdate");
        return c.json(
          await controller.updateWorkspaceBillingSettings(id, body),
          200,
        );
      },
    }),
  );

  app.get(
    TAKOSUMI_WORKSPACE_USAGE_ROUTE,
    defineRoute({
      ctx,
      param: WORKSPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureWorkspacePermission(principal, id);
        const page = parsePageParams(c);
        if (page.kind === "invalid") return page.response;
        return c.json(await controller.listWorkspaceUsage(id, page.value), 200);
      },
    }),
  );
}
