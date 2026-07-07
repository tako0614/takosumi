/**
 * §28 billing public routes.
 *
 * These handlers expose the control-plane billing ledger already used by
 * plan/apply: settings, owner-account USD balance, usage events, manual USD
 * top-up, and billing settings change. Workspace route ids remain the
 * permission/source boundary. Stripe checkout/subscription orchestration remains
 * an operator/account-plane integration layered behind these records.
 */

import type { BillingSettings } from "takosumi-contract/billing";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureSpacePermission,
  parsePageParams,
  readJsonBody,
  SPACE_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_WORKSPACE_BILLING_ROUTE,
  TAKOSUMI_WORKSPACE_CREDIT_RESERVATIONS_ROUTE,
  TAKOSUMI_WORKSPACE_CREDITS_TOP_UP_ROUTE,
  TAKOSUMI_WORKSPACE_SUBSCRIPTION_CHANGE_ROUTE,
  TAKOSUMI_WORKSPACE_USAGE_ROUTE,
} from "./deploy_control_route_paths.ts";

const WORKSPACE_ID_PARAM = {
  param: "workspaceId",
  pattern: SPACE_ID_PATTERN,
} as const;

export const DEPLOY_CONTROL_BILLING_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACE_BILLING_ROUTE,
      summary: "Reads billing settings and owner-account USD balance.",
      auth: "deploy-control-token",
      operationId: "getWorkspaceBilling",
      openapi: {
        pathParams: ["workspaceId"],
        okSchema: "SpaceBillingResponse",
      },
      notImplementedMessage: "billing not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACE_USAGE_ROUTE,
      summary: "Lists owner-account usage events for a Workspace route.",
      auth: "deploy-control-token",
      operationId: "listWorkspaceUsage",
      openapi: { pathParams: ["workspaceId"], okSchema: "SpaceUsageResponse" },
      notImplementedMessage: "billing not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_WORKSPACE_CREDIT_RESERVATIONS_ROUTE,
      summary: "Lists owner-account credit reservations for a Workspace route.",
      auth: "deploy-control-token",
      operationId: "listWorkspaceCreditReservations",
      openapi: {
        pathParams: ["workspaceId"],
        okSchema: "SpaceCreditReservationsResponse",
      },
      notImplementedMessage: "billing not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACE_CREDITS_TOP_UP_ROUTE,
      summary: "Adds manual credits to the owning account balance.",
      auth: "deploy-control-token",
      operationId: "topUpWorkspaceCredits",
      openapi: {
        pathParams: ["workspaceId"],
        requestSchema: "CreditsTopUpRequest",
        okSchema: "CreditBalanceResponse",
      },
      notImplementedMessage: "billing not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_WORKSPACE_SUBSCRIPTION_CHANGE_ROUTE,
      summary: "Changes billing settings for this Workspace source boundary.",
      auth: "deploy-control-token",
      operationId: "changeWorkspaceSubscription",
      openapi: {
        pathParams: ["workspaceId"],
        requestSchema: "SubscriptionChangeRequest",
        okSchema: "SpaceBillingResponse",
      },
      notImplementedMessage: "billing not wired",
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
        ensureSpacePermission(principal, id);
        return c.json(await controller.getSpaceBilling(id), 200);
      },
    }),
  );

  app.get(
    TAKOSUMI_WORKSPACE_USAGE_ROUTE,
    defineRoute({
      ctx,
      param: WORKSPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const page = parsePageParams(c);
        if (page.kind === "invalid") return page.response;
        return c.json(await controller.listSpaceUsage(id, page.value), 200);
      },
    }),
  );

  app.get(
    TAKOSUMI_WORKSPACE_CREDIT_RESERVATIONS_ROUTE,
    defineRoute({
      ctx,
      param: WORKSPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        return c.json(await controller.listSpaceCreditReservations(id), 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_WORKSPACE_CREDITS_TOP_UP_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      param: WORKSPACE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const body = await readJsonBody<{
          readonly usdMicros?: number;
          readonly credits?: number;
        }>(c, "creditsTopUp");
        return c.json(await controller.topUpSpaceCredits(id, body), 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_WORKSPACE_SUBSCRIPTION_CHANGE_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      param: WORKSPACE_ID_PARAM,
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const body = await readJsonBody<{
          readonly billingSettings: BillingSettings;
        }>(c, "subscriptionChange");
        return c.json(
          await controller.changeSpaceSubscription(id, {
            billingSettings: body.billingSettings,
          }),
          200,
        );
      },
    }),
  );
}
