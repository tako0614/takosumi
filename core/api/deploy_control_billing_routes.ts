/**
 * §28 billing public routes.
 *
 * These handlers expose the control-plane billing ledger already used by
 * plan/apply: settings + credit balance, usage events, manual credit top-up, and
 * billing settings change. Stripe checkout/subscription orchestration remains an
 * operator/account-plane integration layered behind these records.
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
  TAKOSUMI_SPACE_BILLING_ROUTE,
  TAKOSUMI_SPACE_CREDIT_RESERVATIONS_ROUTE,
  TAKOSUMI_SPACE_CREDITS_TOP_UP_ROUTE,
  TAKOSUMI_SPACE_SUBSCRIPTION_CHANGE_ROUTE,
  TAKOSUMI_SPACE_USAGE_ROUTE,
} from "./deploy_control_route_paths.ts";

const SPACE_ID_PARAM = { param: "spaceId", pattern: SPACE_ID_PATTERN } as const;

export const DEPLOY_CONTROL_BILLING_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_SPACE_BILLING_ROUTE,
      summary: "Reads Space billing settings and credit balance.",
      auth: "deploy-control-token",
      operationId: "getSpaceBilling",
      openapi: { pathParams: ["spaceId"], okSchema: "SpaceBillingResponse" },
      notImplementedMessage: "billing not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_SPACE_USAGE_ROUTE,
      summary: "Lists Space usage events.",
      auth: "deploy-control-token",
      operationId: "listSpaceUsage",
      openapi: { pathParams: ["spaceId"], okSchema: "SpaceUsageResponse" },
      notImplementedMessage: "billing not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_SPACE_CREDIT_RESERVATIONS_ROUTE,
      summary: "Lists Space credit reservations.",
      auth: "deploy-control-token",
      operationId: "listSpaceCreditReservations",
      openapi: {
        pathParams: ["spaceId"],
        okSchema: "SpaceCreditReservationsResponse",
      },
      notImplementedMessage: "billing not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_SPACE_CREDITS_TOP_UP_ROUTE,
      summary: "Adds manual credits to a Space balance.",
      auth: "deploy-control-token",
      operationId: "topUpSpaceCredits",
      openapi: {
        pathParams: ["spaceId"],
        requestSchema: "CreditsTopUpRequest",
        okSchema: "CreditBalanceResponse",
      },
      notImplementedMessage: "billing not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_SPACE_SUBSCRIPTION_CHANGE_ROUTE,
      summary: "Changes Space billing settings.",
      auth: "deploy-control-token",
      operationId: "changeSpaceSubscription",
      openapi: {
        pathParams: ["spaceId"],
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
    TAKOSUMI_SPACE_BILLING_ROUTE,
    defineRoute({
      ctx,
      param: SPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        return c.json(await controller.getSpaceBilling(id), 200);
      },
    }),
  );

  app.get(
    TAKOSUMI_SPACE_USAGE_ROUTE,
    defineRoute({
      ctx,
      param: SPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        const page = parsePageParams(c);
        if (page.kind === "invalid") return page.response;
        return c.json(await controller.listSpaceUsage(id, page.value), 200);
      },
    }),
  );

  app.get(
    TAKOSUMI_SPACE_CREDIT_RESERVATIONS_ROUTE,
    defineRoute({
      ctx,
      param: SPACE_ID_PARAM,
      handler: async ({ c, principal, id }) => {
        ensureSpacePermission(principal, id);
        return c.json(await controller.listSpaceCreditReservations(id), 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_SPACE_CREDITS_TOP_UP_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      param: SPACE_ID_PARAM,
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
    TAKOSUMI_SPACE_SUBSCRIPTION_CHANGE_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      param: SPACE_ID_PARAM,
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
