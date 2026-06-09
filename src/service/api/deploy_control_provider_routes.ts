/**
 * §29 Provider routes: read-only provider template endpoints.
 */

import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  PROVIDER_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_PROVIDER_ROUTE,
  TAKOSUMI_PROVIDERS_ROUTE,
} from "./deploy_control_route_paths.ts";

export const DEPLOY_CONTROL_PROVIDER_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_PROVIDERS_ROUTE,
      summary:
        "Lists provider templates with capabilities, credential sources, helper flows, and policy metadata.",
      auth: "deploy-control-token",
      operationId: "listProviders",
      openapi: { okSchema: "ListProviderTemplatesResponse" },
      notImplementedMessage: "providers not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_PROVIDER_ROUTE,
      summary: "Reads a provider template.",
      auth: "deploy-control-token",
      operationId: "getProvider",
      openapi: {
        pathParams: ["providerId"],
        okSchema: "ProviderTemplateResponse",
      },
      notImplementedMessage: "providers not wired",
    },
  ];

export function mountDeployControlProviderRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, controller } = ctx;

  app.get(
    TAKOSUMI_PROVIDERS_ROUTE,
    defineRoute({
      ctx,
      handler: async ({ c }) =>
        c.json(await controller.listProviderTemplates(), 200),
    }),
  );

  app.get(
    TAKOSUMI_PROVIDER_ROUTE,
    defineRoute({
      ctx,
      param: { param: "providerId", pattern: PROVIDER_ID_PATTERN },
      handler: async ({ c, id }) =>
        c.json(await controller.getProviderTemplate(id), 200),
    }),
  );
}
