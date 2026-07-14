/**
 * Provider ProviderConnection routes. Core exposes one explicit create route and one
 * opaque provider-helper route; vendor packages contribute helper ids at the
 * composition boundary instead of adding vendor-named Core routes.
 */

import type { Context } from "hono";
import type {
  ProviderConnection,
  ConnectionSetupRequest,
  CreateConnectionRequest,
} from "@takosumi/internal/deploy-control-api";
import { OpenTofuControllerError } from "../domains/deploy-control/mod.ts";
import {
  authorizeDeployControl,
  type ConnectionOAuthCallbackInput,
  type ConnectionOAuthHelper,
  type ConnectionOAuthStartBody,
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  enforceBodyLimit,
  ensureConnectionPermission,
  ensureWorkspacePermission,
  nonEmptyString,
  parsePageParams,
  readJsonBody,
  runHandler,
  CONNECTION_ID_PATTERN,
  DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_CONNECTION_REVOKE_ROUTE,
  TAKOSUMI_CONNECTION_ROUTE,
  TAKOSUMI_CONNECTION_TEST_ROUTE,
  TAKOSUMI_CONNECTION_OAUTH_CALLBACK_ROUTE,
  TAKOSUMI_CONNECTION_OAUTH_START_ROUTE,
  TAKOSUMI_CONNECTION_SETUP_ROUTE,
  TAKOSUMI_CONNECTIONS_ROUTE,
} from "./deploy_control_route_paths.ts";

export const DEPLOY_CONTROL_CONNECTION_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_CONNECTION_SETUP_ROUTE,
      summary:
        "Runs an explicitly selected provider-owned setup helper and registers the resulting Provider ProviderConnection.",
      auth: "deploy-control-token",
      operationId: "createConnectionFromSetup",
      openapi: {
        pathParams: ["setupId"],
        requestSchema: "ConnectionSetupRequest",
        okStatus: "201",
        okSchema: "ConnectionResponse",
      },
      notImplementedMessage: "connection setup helpers not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CONNECTION_OAUTH_START_ROUTE,
      summary:
        "Starts an explicitly selected provider-owned OAuth helper flow.",
      auth: "deploy-control-token",
      operationId: "startConnectionOAuthHelper",
      openapi: {
        pathParams: ["helperId"],
        requestSchema: "ConnectionOAuthStartRequest",
        okSchema: "ConnectionOAuthStartResponse",
      },
      notImplementedMessage: "connection OAuth helpers not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CONNECTIONS_ROUTE,
      summary:
        "Registers a Provider ProviderConnection from an explicit provider source and Credential Recipe.",
      auth: "deploy-control-token",
      operationId: "createConnection",
      openapi: {
        requestSchema: "CreateConnectionRequest",
        okStatus: "201",
        okSchema: "ConnectionResponse",
      },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_CONNECTION_OAUTH_CALLBACK_ROUTE,
      summary:
        "Completes an explicitly selected provider-owned OAuth helper flow.",
      auth: "deploy-control-token",
      operationId: "completeConnectionOAuthHelper",
      openapi: {
        pathParams: ["helperId"],
        okStatus: "201",
        okSchema: "ConnectionResponse",
      },
      notImplementedMessage: "connection OAuth helpers not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_CONNECTIONS_ROUTE,
      summary:
        "Lists Connections for a Workspace, or operator-scoped Connections when workspaceId is omitted (never includes secret values).",
      auth: "deploy-control-token",
      operationId: "listConnections",
      openapi: { query: ["workspaceId"], okSchema: "ListConnectionsResponse" },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_CONNECTION_ROUTE,
      summary: "Reads one ProviderConnection without exposing credential values.",
      auth: "deploy-control-token",
      operationId: "getConnection",
      openapi: {
        pathParams: ["connectionId"],
        okSchema: "ConnectionResponse",
      },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CONNECTION_TEST_ROUTE,
      summary: "Verifies a ProviderConnection's stored credentials with the provider.",
      auth: "deploy-control-token",
      operationId: "testConnection",
      openapi: {
        pathParams: ["connectionId"],
        okSchema: "TestConnectionResponse",
      },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CONNECTION_REVOKE_ROUTE,
      summary: "Revokes a ProviderConnection and deletes its sealed secret blob.",
      auth: "deploy-control-token",
      operationId: "revokeConnection",
      openapi: {
        pathParams: ["connectionId"],
        okStatus: "204",
        okSchema: "EmptyResponse",
      },
      notImplementedMessage: "connections not wired",
    },
  ];

export function mountDeployControlConnectionRoutes(
  ctx: DeployControlRouteContext,
): void {
  const { app, dependencies, controller, deployControlBodyLimit } = ctx;

  app.post(
    TAKOSUMI_CONNECTION_SETUP_ROUTE,
    deployControlBodyLimit,
    async (c): Promise<Response> => {
      const auth = await authorizeDeployControl(c, dependencies);
      if (!auth.ok) return auth.response;
      const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
      if (limit) return limit;
      return await runHandler(c, async () => {
        const setupId = opaqueHelperId(c.req.param("setupId"), "setup");
        const build = dependencies.buildConnectionSetupRequest;
        if (!build) {
          throw new OpenTofuControllerError(
            "not_implemented",
            "connection setup helpers are not wired",
          );
        }
        const body = await readJsonBody<ConnectionSetupRequest>(
          c,
          "connectionSetup",
        );
        let request: CreateConnectionRequest;
        try {
          request = build(setupId, body);
        } catch (error) {
          if (error instanceof OpenTofuControllerError) throw error;
          throw new OpenTofuControllerError(
            "invalid_argument",
            error instanceof Error
              ? error.message
              : `connection setup ${setupId} rejected the request`,
          );
        }
        ensureConnectionPermission(
          auth.principal,
          request.workspaceId,
          request.scope,
        );
        const response = await controller.createConnection(request);
        await recordConnectionCreatedActivity(
          ctx,
          auth.principal.actor,
          response.connection,
        );
        return c.json(response, 201);
      });
    },
  );

  const requireOAuthHelper = (helperId: string): ConnectionOAuthHelper => {
    const helper = dependencies.connectionOAuthHelpers?.[helperId];
    if (!helper) {
      throw new OpenTofuControllerError(
        "not_implemented",
        `OAuth connection helper ${helperId} is not installed`,
      );
    }
    return helper;
  };

  const startOAuthHelper = async (c: Context): Promise<Response> => {
      const auth = await authorizeDeployControl(c, dependencies);
      if (!auth.ok) return auth.response;
      const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
      if (limit) return limit;
      return await runHandler(c, async () => {
        const helperId = opaqueHelperId(c.req.param("helperId"), "OAuth helper");
        const helper = requireOAuthHelper(helperId);
        const body = await readJsonBody<ConnectionOAuthStartBody>(
          c,
          "connectionOAuthStart",
        );
        ensureConnectionPermission(
          auth.principal,
          body.workspaceId,
          body.scope,
        );
        return c.json(
          await helper.start({
            helperId,
            request: c.req.raw,
            principal: auth.principal,
            body,
          }),
          200,
        );
      });
    };

  const completeOAuthHelper = async (c: Context): Promise<Response> => {
      const auth = await authorizeDeployControl(c, dependencies);
      if (!auth.ok) return auth.response;
      return await runHandler(c, async () => {
        const helperId = opaqueHelperId(c.req.param("helperId"), "OAuth helper");
        const helper = requireOAuthHelper(helperId);
        const callback = oauthCallbackInput(helperId, c, auth.principal);
        const completion = await helper.complete(callback);
        const request = normalizeOAuthConnectionRequest(completion.request);
        ensureConnectionPermission(
          auth.principal,
          request.workspaceId,
          request.scope,
        );
        const response = await controller.createConnection(request);
        await recordConnectionCreatedActivity(
          ctx,
          auth.principal.actor,
          response.connection,
        );
        return c.json(response, 201);
      });
    };

  app.post(
    TAKOSUMI_CONNECTION_OAUTH_START_ROUTE,
    deployControlBodyLimit,
    startOAuthHelper,
  );
  app.get(
    TAKOSUMI_CONNECTION_OAUTH_CALLBACK_ROUTE,
    completeOAuthHelper,
  );

  app.post(
    TAKOSUMI_CONNECTIONS_ROUTE,
    deployControlBodyLimit,
    async (c): Promise<Response> => {
      const auth = await authorizeDeployControl(c, dependencies);
      if (!auth.ok) return auth.response;
      const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
      if (limit) return limit;
      return await runHandler(c, async () => {
        const request = await readJsonBody<CreateConnectionRequest>(
          c,
          "connectionCreate",
        );
        ensureConnectionPermission(
          auth.principal,
          request.workspaceId,
          request.scope,
        );
        const response = await controller.createConnection(request);
        await recordConnectionCreatedActivity(
          ctx,
          auth.principal.actor,
          response.connection,
        );
        return c.json(response, 201);
      });
    },
  );

  app.get(TAKOSUMI_CONNECTIONS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const workspaceId = c.req.query("workspaceId") ?? "";
    // §30: with no workspaceId, list operator-scoped Connections (instance-wide).
    // Only the unrestricted bearer (workspaceIds: "*") may; a scoped principal is
    // rejected by ensureConnectionPermission(undefined).
    if (workspaceId.trim().length === 0) {
      return await runHandler(c, async () => {
        ensureConnectionPermission(auth.principal, undefined);
        return c.json(await controller.listOperatorConnections(), 200);
      });
    }
    const page = parsePageParams(c);
    if (page.kind === "invalid") return page.response;
    return await runHandler(c, async () => {
      ensureWorkspacePermission(auth.principal, workspaceId);
      return c.json(await controller.listConnections(workspaceId, page.value), 200);
    });
  });

  app.get(
    TAKOSUMI_CONNECTION_ROUTE,
    defineRoute({
      ctx,
      param: { param: "connectionId", pattern: CONNECTION_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        const connection = await controller.getConnection(id);
        ensureConnectionPermission(principal, connection.workspaceId);
        return c.json({ connection }, 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_CONNECTION_TEST_ROUTE,
    defineRoute({
      ctx,
      param: { param: "connectionId", pattern: CONNECTION_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        const connection = await controller.getConnection(id);
        ensureConnectionPermission(principal, connection.workspaceId);
        return c.json(await controller.testConnection(id), 200);
      },
    }),
  );

  app.post(
    TAKOSUMI_CONNECTION_REVOKE_ROUTE,
    defineRoute({
      ctx,
      param: { param: "connectionId", pattern: CONNECTION_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        const connection = await controller.getConnection(id);
        ensureConnectionPermission(principal, connection.workspaceId);
        // Maps to the vault revoke path (the former DELETE handler logic).
        await controller.deleteConnection(id);
        // Activity (§27 / §34): mirror connection.created for Workspace-scoped
        // revocation. Emit only non-secret context captured before the sealed
        // secret blob is deleted.
        if (dependencies.activityService && connection.workspaceId) {
          await dependencies.activityService.record({
            workspaceId: connection.workspaceId,
            actorId: principal.actor,
            action: "connection.revoked",
            targetType: "connection",
            targetId: connection.id,
            metadata: {
              provider: connection.provider,
              ...(connection.credentialRecipe
                ? {
                    recipeId: connection.credentialRecipe.id,
                    recipeAuthMode: connection.credentialRecipe.authMode,
                  }
                : {}),
              ...(connection.kind ? { kind: connection.kind } : {}),
              scope: connection.scope,
            },
          });
        }
        return c.body(null, 204);
      },
    }),
  );
}

async function recordConnectionCreatedActivity(
  ctx: DeployControlRouteContext,
  actorId: string,
  connection: ProviderConnection,
): Promise<void> {
  const activityService = ctx.dependencies.activityService;
  if (!activityService || !connection.workspaceId) return;
  await activityService.record({
    workspaceId: connection.workspaceId,
    actorId,
    action: "connection.created",
    targetType: "connection",
    targetId: connection.id,
    metadata: {
      provider: connection.provider,
      ...(connection.credentialRecipe
        ? {
            recipeId: connection.credentialRecipe.id,
            recipeAuthMode: connection.credentialRecipe.authMode,
          }
        : {}),
      ...(connection.kind ? { kind: connection.kind } : {}),
      scope: connection.scope,
    },
  });
}

function normalizeOAuthConnectionRequest(
  request: CreateConnectionRequest,
): CreateConnectionRequest {
  if (!nonEmptyString(request.provider) || request.provider.split("/").length < 3) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "OAuth helper must return an explicit fully-qualified provider source",
    );
  }
  if (
    !request.credentialRecipe ||
    !nonEmptyString(request.credentialRecipe.id) ||
    !nonEmptyString(request.credentialRecipe.authMode) ||
    !nonEmptyString(request.credentialRecipe.secretPartition)
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "OAuth helper must return an explicit credential recipe and secret partition",
    );
  }
  // OAuth is a provider setup flow selecting a recipe mode, never a Source Git
  // transport. Reject a helper that crosses those authorities instead of
  // silently rewriting its request.
  if (request.kind !== undefined) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "OAuth helper must not return a Source Git connection kind",
    );
  }
  return {
    ...request,
    materialization: request.materialization ?? "oauth",
  };
}

function opaqueHelperId(value: string | undefined, label: string): string {
  if (
    !value ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} id must be an opaque URL-safe token`,
    );
  }
  return value;
}

function oauthCallbackInput(
  helperId: string,
  c: Context,
  principal: Parameters<ConnectionOAuthHelper["complete"]>[0]["principal"],
): ConnectionOAuthCallbackInput {
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!nonEmptyString(code)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "OAuth callback requires query parameter code",
    );
  }
  if (!nonEmptyString(state)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "OAuth callback requires query parameter state",
    );
  }
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = value;
  }
  return {
    helperId,
    request: c.req.raw,
    principal,
    code,
    state,
    query,
  };
}
