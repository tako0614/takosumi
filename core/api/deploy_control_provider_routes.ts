/**
 * §29 Provider routes: read-only ProviderConnection recipe endpoints.
 */

import {
  defineRoute,
  ensureConnectionPermission,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  PROVIDER_ENV_ID_PATTERN,
  PROVIDER_ID_PATTERN,
  readJsonBody,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_PROVIDER_ENV_ROUTE,
  TAKOSUMI_PROVIDER_ENVS_ROUTE,
  TAKOSUMI_PROVIDER_ROUTE,
  TAKOSUMI_PROVIDERS_ROUTE,
} from "./deploy_control_route_paths.ts";
import type {
  ProviderEnv,
  PublicProviderEnv,
  PutProviderEnvRequest,
} from "takosumi-contract/provider-envs";

export const DEPLOY_CONTROL_PROVIDER_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "GET",
      path: TAKOSUMI_PROVIDERS_ROUTE,
      summary:
        "Lists provider connection recipes with helper flows and policy metadata.",
      auth: "deploy-control-token",
      operationId: "listProviders",
      openapi: { okSchema: "ListProviderCatalogEntriesResponse" },
      notImplementedMessage: "providers not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_PROVIDER_ROUTE,
      summary: "Reads a provider connection recipe.",
      auth: "deploy-control-token",
      operationId: "getProvider",
      openapi: {
        pathParams: ["providerId"],
        okSchema: "ProviderCatalogEntryResponse",
      },
      notImplementedMessage: "providers not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_PROVIDER_ENVS_ROUTE,
      summary:
        "Lists internal provider resolver records visible to a Workspace.",
      auth: "deploy-control-token",
      operationId: "listProviderEnvs",
      discoverable: false,
      openapi: { okSchema: "ListProviderEnvsResponse" },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "PUT",
      path: TAKOSUMI_PROVIDER_ENV_ROUTE,
      summary: "Creates or replaces an internal provider resolver record.",
      auth: "deploy-control-token",
      operationId: "putProviderEnv",
      discoverable: false,
      openapi: {
        pathParams: ["providerEnvId"],
        requestSchema: "PutProviderEnvRequest",
        okSchema: "ProviderEnvResponse",
      },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_PROVIDER_ENV_ROUTE,
      summary: "Reads an internal provider resolver record.",
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
  const { app, controller, dependencies, deployControlBodyLimit } = ctx;

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
            providerEnvs: (
              await dependencies.connectionsService!.listProviderEnvs(spaceId)
            ).map(publicProviderEnv),
          },
          200,
        );
      },
    }),
  );

  app.put(
    TAKOSUMI_PROVIDER_ENV_ROUTE,
    deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: (deps) =>
        deps.connectionsService ? undefined : "connections not wired",
      param: { param: "providerEnvId", pattern: PROVIDER_ENV_ID_PATTERN },
      enforceBody: true,
      handler: async ({ c, principal, id }) => {
        const body = await readJsonBody<PutProviderEnvRequest>(
          c,
          "providerEnvPut",
        );
        ensureConnectionPermission(principal, body.spaceId);
        if (body.secretRef && body.spaceId) {
          const backingConnection = await controller.getConnection(
            body.secretRef,
          );
          if (backingConnection.scope === "operator") {
            ensureConnectionPermission(principal, undefined, "operator");
          }
        }
        return c.json(
          {
            providerEnv: publicProviderEnv(
              await dependencies.connectionsService!.putProviderEnv(id, body),
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
          await dependencies.connectionsService!.getProviderEnv(id);
        ensureConnectionPermission(principal, providerEnv.spaceId);
        return c.json({ providerEnv: publicProviderEnv(providerEnv) }, 200);
      },
    }),
  );
}

function publicProviderEnv(providerEnv: ProviderEnv): PublicProviderEnv {
  const { secretRef: _secretRef, ...publicEnv } = providerEnv;
  void _secretRef;
  return publicEnv;
}
