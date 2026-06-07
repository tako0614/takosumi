/**
 * §30 Connection routes: the thin validated connection-creation subroutes
 * (git HTTPS-token / git SSH-key / Cloudflare token / AWS assume-role) plus the
 * Connection list / test / revoke handlers. Owns its handlers and its slice of
 * the {@link DEPLOY_CONTROL_PUBLIC_ENDPOINTS} descriptor inventory.
 */

import type { Context } from "hono";
import type {
  ConnectionKind,
  ConnectionScopeHints,
  CreateConnectionRequest,
} from "takosumi-contract/deploy-control-api";
import {
  OpenTofuControllerError,
} from "../domains/deploy-control/mod.ts";
import {
  authorizeDeployControl,
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  enforceBodyLimit,
  ensureConnectionPermission,
  ensureSpacePermission,
  nonEmptyString,
  readJsonBody,
  runHandler,
  CONNECTION_ID_PATTERN,
  DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_CONNECTION_REVOKE_ROUTE,
  TAKOSUMI_CONNECTION_TEST_ROUTE,
  TAKOSUMI_CONNECTIONS_AWS_ASSUME_ROLE_ROUTE,
  TAKOSUMI_CONNECTIONS_CLOUDFLARE_TOKEN_ROUTE,
  TAKOSUMI_CONNECTIONS_ROUTE,
  TAKOSUMI_CONNECTIONS_SOURCE_HTTPS_TOKEN_ROUTE,
  TAKOSUMI_CONNECTIONS_SOURCE_SSH_KEY_ROUTE,
} from "./deploy_control_route_paths.ts";

/**
 * §30 connection-creation subroute body. The subroute fixes the
 * `provider` / `kind` / `authMethod`; the body carries only the Space binding,
 * display name, optional scope, optional non-secret scope hints, and the
 * write-only credential `values`.
 */
interface ConnectionSubrouteBody {
  readonly spaceId?: string;
  readonly displayName?: string;
  readonly scope?: "operator" | "space";
  readonly scopeHints?: ConnectionScopeHints;
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Builds a git-source Connection create request (§30 source subroutes). The
 * `source_git_ssh_key` kind REQUIRES `scopeHints.knownHostsEntry` so the runner
 * can pin the host key with `StrictHostKeyChecking=yes` (spec §7 / invariant on
 * SSH host-key pinning); omitting it is a typed invalid_argument.
 */
function buildSourceConnectionRequest(
  body: ConnectionSubrouteBody,
  kind: Extract<
    ConnectionKind,
    "source_git_https_token" | "source_git_ssh_key"
  >,
): CreateConnectionRequest {
  if (
    kind === "source_git_ssh_key" &&
    !nonEmptyString(body.scopeHints?.knownHostsEntry)
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "scopeHints.knownHostsEntry is required for a source_git_ssh_key connection",
    );
  }
  return {
    ...(body.spaceId ? { spaceId: body.spaceId } : {}),
    provider: kind,
    kind,
    authMethod: "static_secret",
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.scope ? { scope: body.scope } : {}),
    ...(body.scopeHints ? { scopeHints: body.scopeHints } : {}),
    values: body.values,
  };
}

/** Builds a Cloudflare API-token Connection create request (§30 subroute). */
function buildCloudflareConnectionRequest(
  body: ConnectionSubrouteBody,
): CreateConnectionRequest {
  return {
    ...(body.spaceId ? { spaceId: body.spaceId } : {}),
    provider: "cloudflare",
    kind: "provider",
    authMethod: "static_secret",
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.scope ? { scope: body.scope } : {}),
    ...(body.scopeHints ? { scopeHints: body.scopeHints } : {}),
    values: body.values,
  };
}

/**
 * Builds an AWS assume-role-capable provider Connection (§30 subroute). The
 * Vault mints AWS provider env vars from sealed `values`; when static source
 * keys are present, it exchanges them for short-lived STS AssumeRole
 * credentials at runner-dispatch time. The role ARN / external id / region are
 * non-secret scope hints used by the vault, policy, and UI. `values` must still
 * satisfy the canonical AWS env rules (`AWS_ACCESS_KEY_ID` +
 * `AWS_SECRET_ACCESS_KEY`, or web-identity envs).
 */
function buildAwsAssumeRoleConnectionRequest(
  body: ConnectionSubrouteBody,
): CreateConnectionRequest {
  const hints = body.scopeHints;
  if (!nonEmptyString(hints?.awsRoleArn)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "scopeHints.awsRoleArn is required for an aws assume-role connection",
    );
  }
  const inputValues = body.values ?? {};
  const values = {
    ...inputValues,
    ...(inputValues.AWS_ROLE_ARN === undefined
      ? { AWS_ROLE_ARN: hints.awsRoleArn }
      : {}),
    ...(nonEmptyString(hints.awsRegion) &&
        inputValues.AWS_REGION === undefined &&
        inputValues.AWS_DEFAULT_REGION === undefined
      ? { AWS_REGION: hints.awsRegion }
      : {}),
  };
  return {
    ...(body.spaceId ? { spaceId: body.spaceId } : {}),
    provider: "aws",
    kind: "provider",
    authMethod: "static_secret",
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.scope ? { scope: body.scope } : {}),
    scopeHints: hints,
    values,
  };
}

export const DEPLOY_CONTROL_CONNECTION_ENDPOINTS:
  readonly DeployControlEndpoint[] = [
    {
      method: "POST",
      path: TAKOSUMI_CONNECTIONS_SOURCE_HTTPS_TOKEN_ROUTE,
      summary:
        "Registers a git source HTTPS-token Connection (token write-only; optional username).",
      auth: "deploy-control-token",
      operationId: "createSourceHttpsTokenConnection",
      openapi: {
        requestSchema: "CreateConnectionRequest",
        okStatus: "201",
        okSchema: "ConnectionResponse",
      },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CONNECTIONS_SOURCE_SSH_KEY_ROUTE,
      summary:
        "Registers a git source SSH-key Connection (private key write-only; knownHosts required for StrictHostKeyChecking=yes).",
      auth: "deploy-control-token",
      operationId: "createSourceSshKeyConnection",
      openapi: {
        requestSchema: "CreateConnectionRequest",
        okStatus: "201",
        okSchema: "ConnectionResponse",
      },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CONNECTIONS_CLOUDFLARE_TOKEN_ROUTE,
      summary:
        "Registers a Cloudflare API-token Connection (token write-only; optional account/zone scope).",
      auth: "deploy-control-token",
      operationId: "createCloudflareTokenConnection",
      openapi: {
        requestSchema: "CreateConnectionRequest",
        okStatus: "201",
        okSchema: "ConnectionResponse",
      },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CONNECTIONS_AWS_ASSUME_ROLE_ROUTE,
      summary:
        "Registers an AWS assume-role-capable Connection (role hints plus write-only AWS env values).",
      auth: "deploy-control-token",
      operationId: "createAwsAssumeRoleConnection",
      openapi: {
        requestSchema: "CreateConnectionRequest",
        okStatus: "201",
        okSchema: "ConnectionResponse",
      },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_CONNECTIONS_ROUTE,
      summary:
        "Lists Connections for a Space, or operator-scoped Connections when spaceId is omitted (never includes secret values).",
      auth: "deploy-control-token",
      operationId: "listConnections",
      openapi: { query: ["spaceId"], okSchema: "ListConnectionsResponse" },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CONNECTION_TEST_ROUTE,
      summary: "Verifies a Connection's stored credentials with the provider.",
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
      summary: "Revokes a Connection and deletes its sealed secret blob.",
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

  /**
   * Shared §30 connection-creation handler: validates the subroute body,
   * resolves the connection-permission, creates the Connection through the
   * controller, emits Space activity (space-scoped only), and returns 201. The
   * credential `values` are forwarded write-only and never logged or echoed.
   */
  const createConnectionFromSubroute = (
    build: (body: ConnectionSubrouteBody) => CreateConnectionRequest,
  ) =>
  async (c: Context): Promise<Response> => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
    if (limit) return limit;
    return await runHandler(c, async () => {
      const body = await readJsonBody<ConnectionSubrouteBody>(
        c,
        "connectionCreate",
      );
      const request = build(body);
      ensureConnectionPermission(auth.principal, request.spaceId);
      const response = await controller.createConnection(request);
      // Activity (§27 / §34): a Connection was registered. Emit ONLY for a
      // space-scoped Connection (operator-scope defaults are instance-wide, not
      // Space activity). Names / ids only — credential values never enter the
      // audit trail.
      const connection = response.connection;
      if (dependencies.activityService && connection.spaceId) {
        await dependencies.activityService.record({
          spaceId: connection.spaceId,
          actorId: auth.principal.actor,
          action: "connection.created",
          targetType: "connection",
          targetId: connection.id,
          metadata: {
            provider: connection.provider,
            kind: connection.kind ?? "provider",
            scope: connection.scope,
          },
        });
      }
      return c.json(response, 201);
    });
  };

  app.post(
    TAKOSUMI_CONNECTIONS_SOURCE_HTTPS_TOKEN_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) =>
      buildSourceConnectionRequest(body, "source_git_https_token")
    ),
  );

  app.post(
    TAKOSUMI_CONNECTIONS_SOURCE_SSH_KEY_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) =>
      buildSourceConnectionRequest(body, "source_git_ssh_key")
    ),
  );

  app.post(
    TAKOSUMI_CONNECTIONS_CLOUDFLARE_TOKEN_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) =>
      buildCloudflareConnectionRequest(body)
    ),
  );

  app.post(
    TAKOSUMI_CONNECTIONS_AWS_ASSUME_ROLE_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) =>
      buildAwsAssumeRoleConnectionRequest(body)
    ),
  );

  app.get(TAKOSUMI_CONNECTIONS_ROUTE, async (c) => {
    const auth = await authorizeDeployControl(c, dependencies);
    if (!auth.ok) return auth.response;
    const spaceId = c.req.query("spaceId") ?? "";
    // §30: with no spaceId, list operator-scoped Connections (instance-wide).
    // Only the unrestricted bearer (spaceIds: "*") may; a scoped principal is
    // rejected by ensureConnectionPermission(undefined).
    if (spaceId.trim().length === 0) {
      return await runHandler(c, async () => {
        ensureConnectionPermission(auth.principal, undefined);
        return c.json(await controller.listOperatorConnections(), 200);
      });
    }
    return await runHandler(c, async () => {
      ensureSpacePermission(auth.principal, spaceId);
      return c.json(await controller.listConnections(spaceId), 200);
    });
  });

  app.post(
    TAKOSUMI_CONNECTION_TEST_ROUTE,
    defineRoute({
      ctx,
      param: { param: "connectionId", pattern: CONNECTION_ID_PATTERN },
      handler: async ({ c, principal, id }) => {
        const connection = await controller.getConnection(id);
        ensureConnectionPermission(principal, connection.spaceId);
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
        ensureConnectionPermission(principal, connection.spaceId);
        // Maps to the vault revoke path (the former DELETE handler logic).
        await controller.deleteConnection(id);
        return c.body(null, 204);
      },
    }),
  );
}
