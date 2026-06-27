/**
 * §29 Provider routes: read-only Provider listing + Provider Connection reads.
 *
 * `GET /providers` is computed read-only from the provider registry + built-in
 * Credential Recipes (there is no stored Provider Catalog). The
 * `/provider-envs` read paths list/get the unified Provider Connection rows the
 * runner/vault resolve (the former `ProviderEnv` resolver projection folded onto
 * the Connection row).
 */

import {
  defineRoute,
  ensureConnectionPermission,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  PROVIDER_ENV_ID_PATTERN,
  PROVIDER_ID_PATTERN,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_PROVIDER_ENV_ROUTE,
  TAKOSUMI_PROVIDER_ENVS_ROUTE,
  TAKOSUMI_PROVIDER_ROUTE,
  TAKOSUMI_PROVIDERS_ROUTE,
} from "./deploy_control_route_paths.ts";

export const DEPLOY_CONTROL_PROVIDER_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_PROVIDERS_ROUTE,
      summary:
        "Lists providers with recommended env names, recipes, and policy metadata (computed read-only).",
      auth: "deploy-control-token",
      operationId: "listProviders",
      openapi: { okSchema: "ListProvidersResponse" },
      notImplementedMessage: "providers not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_PROVIDER_ROUTE,
      summary: "Reads a single provider listing (computed read-only).",
      auth: "deploy-control-token",
      operationId: "getProvider",
      openapi: {
        pathParams: ["providerId"],
        okSchema: "ProviderListingResponse",
      },
      notImplementedMessage: "providers not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_PROVIDER_ENVS_ROUTE,
      summary: "Lists the Provider Connections visible to a Workspace.",
      auth: "deploy-control-token",
      operationId: "listProviderEnvs",
      discoverable: false,
      openapi: { okSchema: "ListProviderEnvsResponse" },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_PROVIDER_ENV_ROUTE,
      summary: "Reads a single Provider Connection.",
      auth: "deploy-control-token",
      operationId: "getProviderEnv",
      discoverable: false,
      openapi: {
        pathParams: ["providerEnvId"],
        okSchema: "ProviderEnvResponse",
      },
      notImplementedMessage: "connections not wired",
    },
  ];

export function mountDeployControlProviderRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, controller, dependencies } = ctx;

  app.get(
    TAKOSUMI_PROVIDERS_ROUTE,
    defineRoute({
      ctx,
      handler: async ({ c }) =>
        c.json(await controller.listProviderCatalogEntries(), 200),
    }),
  );

  app.get(
    TAKOSUMI_PROVIDER_ROUTE,
    defineRoute({
      ctx,
      param: { param: "providerId", pattern: PROVIDER_ID_PATTERN },
      handler: async ({ c, id }) =>
        c.json(await controller.getProviderCatalogEntry(id), 200),
    }),
  );

  app.get(
    TAKOSUMI_PROVIDER_ENVS_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.connectionsService ? undefined : "connections not wired",
      handler: async ({ c, principal }) => {
        const spaceId = c.req.query("spaceId");
        ensureConnectionPermission(principal, spaceId);
        return c.json(
          {
            providerEnvs:
              await dependencies.connectionsService!.listProviderConnections(
                spaceId,
              ),
          },
          200,
        );
      },
    }),
  );

  app.get(
    TAKOSUMI_PROVIDER_ENV_ROUTE,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.connectionsService ? undefined : "connections not wired",
      param: { param: "providerEnvId", pattern: PROVIDER_ENV_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        const providerEnv =
          await dependencies.connectionsService!.getProviderConnection(id);
        ensureConnectionPermission(principal, providerEnv.spaceId);
        return c.json({ providerEnv }, 200);
      },
    }),
  );
}
