/**
 * §30 Connection routes: the thin validated connection-creation subroutes
 * (git HTTPS-token / git SSH-key / Cloudflare token / AWS assume-role) plus the
 * Connection list / test / revoke handlers. Owns its handlers and its slice of
 * the {@link DEPLOY_CONTROL_INTERNAL_ENDPOINTS} descriptor inventory.
 */

import type { Context } from "hono";
import type {
  Connection,
  ConnectionCredentialDriver,
  ConnectionKind,
  ConnectionScopeHints,
  CreateConnectionFile,
  CreateConnectionRequest,
} from "@takosumi/internal/deploy-control-api";
import { providerForConnectionKind } from "@takosumi/providers";
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
  ensureSpacePermission,
  nonEmptyString,
  parsePageParams,
  readJsonBody,
  runHandler,
  CONNECTION_ID_PATTERN,
  DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES,
} from "./deploy_control_shared.ts";
import {
  TAKOSUMI_CONNECTION_REVOKE_ROUTE,
  TAKOSUMI_CONNECTION_TEST_ROUTE,
  TAKOSUMI_CONNECTIONS_AWS_ASSUME_ROLE_ROUTE,
  TAKOSUMI_CONNECTIONS_CLOUDFLARE_OAUTH_CALLBACK_ROUTE,
  TAKOSUMI_CONNECTIONS_CLOUDFLARE_OAUTH_START_ROUTE,
  TAKOSUMI_CONNECTIONS_CLOUDFLARE_TOKEN_ROUTE,
  TAKOSUMI_CONNECTIONS_GCP_IMPERSONATION_ROUTE,
  TAKOSUMI_CONNECTIONS_GCP_OAUTH_CALLBACK_ROUTE,
  TAKOSUMI_CONNECTIONS_GCP_OAUTH_START_ROUTE,
  TAKOSUMI_CONNECTIONS_GCP_SERVICE_ACCOUNT_JSON_ROUTE,
  TAKOSUMI_CONNECTIONS_GENERIC_ENV_PROVIDER_ROUTE,
  TAKOSUMI_CONNECTIONS_ROUTE,
  TAKOSUMI_CONNECTIONS_SOURCE_HTTPS_TOKEN_ROUTE,
  TAKOSUMI_CONNECTIONS_SOURCE_SSH_KEY_ROUTE,
} from "./deploy_control_route_paths.ts";

/**
 * §30 connection-creation subroute body. The subroute fixes the
 * `provider` / `kind` / `authMethod`; the body carries only the Space binding,
 * display name, optional scope, optional non-secret scope hints, and the
 * write-only credential `values` / generic-env credential `files`.
 */
interface ConnectionSubrouteBody {
  readonly provider?: string;
  readonly spaceId?: string;
  readonly displayName?: string;
  readonly scope?: "operator" | "space";
  readonly scopeHints?: ConnectionScopeHints;
  readonly expiresAt?: string;
  readonly values: Readonly<Record<string, string>>;
  readonly files?: readonly CreateConnectionFile[];
}

interface GcpImpersonationConnectionBody {
  readonly spaceId?: string;
  readonly displayName?: string;
  readonly scope?: "operator" | "space";
  readonly scopeHints?: ConnectionScopeHints;
  readonly expiresAt?: string;
  readonly values: Readonly<Record<string, string>>;
}

function buildGenericEnvProviderConnectionRequest(
  body: ConnectionSubrouteBody,
): CreateConnectionRequest {
  if (!nonEmptyString(body.provider)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "provider is required for a generic-env Provider Connection",
    );
  }
  if (!nonEmptyString(body.spaceId)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "spaceId is required for a generic-env Provider Connection",
    );
  }
  if (body.scope !== undefined && body.scope !== "space") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "generic-env Provider Connections are Space-scoped; scope must be space",
    );
  }
  return {
    spaceId: body.spaceId,
    provider: body.provider,
    kind: "generic_env_provider",
    credentialDriver: "generic_env",
    authMethod: "static_secret",
    ...(body.displayName ? { displayName: body.displayName } : {}),
    scope: "space",
    ...(body.scopeHints ? { scopeHints: body.scopeHints } : {}),
    ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
    values: body.values,
    ...(body.files ? { files: body.files } : {}),
  };
}

function providerCredentialFields(
  body: ConnectionSubrouteBody | GcpImpersonationConnectionBody,
  driver: ConnectionCredentialDriver,
): {
  readonly credentialDriver: ConnectionCredentialDriver;
} {
  void body;
  return {
    credentialDriver: driver,
  };
}

function rejectCredentialFilesForFixedProvider(
  body: ConnectionSubrouteBody,
  routeName: string,
): void {
  if (body.files && body.files.length > 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `credential files are only accepted by the generic-env provider route; ${routeName} uses fixed credential values`,
    );
  }
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
  rejectCredentialFilesForFixedProvider(body, kind);
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
    ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
    values: body.values,
  };
}

/**
 * Resolves the `{ provider, kind }` identity a provider-runtime subroute fixes
 * from the @takosumi/providers registry (single source of truth): the
 * Connection kind's driver provider supplies the wire `provider` id, so the
 * subroute never re-declares the provider string. The registry is statically
 * complete for the provider-backed kinds these subroutes use.
 */
function providerIdentityForKind(kind: ConnectionKind): {
  readonly provider: string;
  readonly kind: ConnectionKind;
} {
  const provider = providerForConnectionKind(kind);
  if (!provider) {
    throw new OpenTofuControllerError(
      "not_implemented",
      `no provider runtime registered for connection kind ${kind}`,
    );
  }
  return { provider: provider.id, kind };
}

/** Builds a Cloudflare API-token Connection create request (§30 subroute). */
function buildCloudflareConnectionRequest(
  body: ConnectionSubrouteBody,
): CreateConnectionRequest {
  rejectCredentialFilesForFixedProvider(body, "cloudflare/token");
  return {
    ...(body.spaceId ? { spaceId: body.spaceId } : {}),
    ...providerIdentityForKind("cloudflare_api_token"),
    ...providerCredentialFields(body, "cloudflare_api_token"),
    authMethod: "static_secret",
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.scope ? { scope: body.scope } : {}),
    ...(body.scopeHints ? { scopeHints: body.scopeHints } : {}),
    ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
    values: body.values,
  };
}

/**
 * Builds an AWS assume-role-capable Provider Connection (§30 subroute). The
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
  rejectCredentialFilesForFixedProvider(body, "aws/assume-role");
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
    ...providerIdentityForKind("aws_assume_role"),
    ...providerCredentialFields(body, "aws_assume_role"),
    authMethod: "static_secret",
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.scope ? { scope: body.scope } : {}),
    scopeHints: hints,
    ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
    values,
  };
}

function buildGcpImpersonationConnectionRequest(
  body: GcpImpersonationConnectionBody,
): CreateConnectionRequest {
  const hints = body.scopeHints;
  if (!nonEmptyString(hints?.gcpServiceAccountEmail)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "scopeHints.gcpServiceAccountEmail is required for a gcp impersonation connection",
    );
  }
  if (!nonEmptyString(hints?.gcpProjectId)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "scopeHints.gcpProjectId is required for a gcp impersonation connection",
    );
  }
  return {
    ...(body.spaceId ? { spaceId: body.spaceId } : {}),
    provider: "google",
    kind: "gcp_service_account_impersonation",
    ...providerCredentialFields(body, "gcp_service_account_impersonation"),
    authMethod: "static_secret",
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.scope ? { scope: body.scope } : {}),
    scopeHints: hints,
    ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
    values: body.values,
  };
}

function buildGcpServiceAccountJsonConnectionRequest(
  body: ConnectionSubrouteBody,
): CreateConnectionRequest {
  rejectCredentialFilesForFixedProvider(body, "gcp/service-account-json");
  return {
    ...(body.spaceId ? { spaceId: body.spaceId } : {}),
    provider: "google",
    kind: "gcp_service_account_json",
    ...providerCredentialFields(body, "gcp_service_account_json"),
    authMethod: "static_secret",
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.scope ? { scope: body.scope } : {}),
    ...(body.scopeHints ? { scopeHints: body.scopeHints } : {}),
    ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
    values: body.values,
  };
}

export const DEPLOY_CONTROL_CONNECTION_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_CONNECTIONS_SOURCE_HTTPS_TOKEN_ROUTE,
      summary:
        "Registers a git source HTTPS-token Connection (token write-only; optional username).",
      auth: "deploy-control-token",
      operationId: "createSourceHttpsTokenConnection",
      openapi: {
        requestSchema: "CreateConnectionSubrouteRequest",
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
        requestSchema: "CreateConnectionSubrouteRequest",
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
        requestSchema: "CreateConnectionSubrouteRequest",
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
        requestSchema: "CreateConnectionSubrouteRequest",
        okStatus: "201",
        okSchema: "ConnectionResponse",
      },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CONNECTIONS_GENERIC_ENV_PROVIDER_ROUTE,
      summary:
        "Registers a secret-backed Provider Connection through the generic-env provider route (values/files write-only).",
      auth: "deploy-control-token",
      operationId: "createGenericEnvProviderConnection",
      openapi: {
        requestSchema: "CreateConnectionSubrouteRequest",
        okStatus: "201",
        okSchema: "ConnectionResponse",
      },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CONNECTIONS_CLOUDFLARE_OAUTH_START_ROUTE,
      summary:
        "Starts a Cloudflare OAuth helper flow that creates a write-only OAuth Provider Connection.",
      auth: "deploy-control-token",
      operationId: "startCloudflareOAuthConnection",
      openapi: {
        requestSchema: "ConnectionOAuthStartRequest",
        okSchema: "ConnectionOAuthStartResponse",
      },
      notImplementedMessage: "cloudflare oauth connection driver not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_CONNECTIONS_CLOUDFLARE_OAUTH_CALLBACK_ROUTE,
      summary:
        "Completes a Cloudflare OAuth helper flow and registers the resulting write-only Connection.",
      auth: "deploy-control-token",
      operationId: "completeCloudflareOAuthConnection",
      openapi: { okStatus: "201", okSchema: "ConnectionResponse" },
      notImplementedMessage: "cloudflare oauth connection driver not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CONNECTIONS_GCP_OAUTH_START_ROUTE,
      summary:
        "Reserved Google Cloud OAuth helper flow. Returns 501 until a live helper driver is wired.",
      auth: "deploy-control-token",
      operationId: "startGcpOAuthConnection",
      openapi: {
        requestSchema: "ConnectionOAuthStartRequest",
        okSchema: "ConnectionOAuthStartResponse",
      },
      notImplementedMessage: "gcp oauth connection driver not wired",
    },
    {
      method: "GET",
      path: TAKOSUMI_CONNECTIONS_GCP_OAUTH_CALLBACK_ROUTE,
      summary:
        "Reserved Google Cloud OAuth callback. Returns 501 until a live helper driver is wired.",
      auth: "deploy-control-token",
      operationId: "completeGcpOAuthConnection",
      openapi: { okStatus: "201", okSchema: "ConnectionResponse" },
      notImplementedMessage: "gcp oauth connection driver not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CONNECTIONS_GCP_IMPERSONATION_ROUTE,
      summary:
        "Registers a reserved Google Cloud impersonation Connection; it remains pending until GCP verify/mint drivers are wired.",
      auth: "deploy-control-token",
      operationId: "createGcpImpersonationConnection",
      openapi: {
        requestSchema: "GcpImpersonationConnectionRequest",
        okStatus: "201",
        okSchema: "ConnectionResponse",
      },
      notImplementedMessage: "connections not wired",
    },
    {
      method: "POST",
      path: TAKOSUMI_CONNECTIONS_GCP_SERVICE_ACCOUNT_JSON_ROUTE,
      summary:
        "Registers a Google Cloud service-account JSON Provider Connection (JSON write-only; project filled from GOOGLE_CLOUD_PROJECT or credentials.project_id).",
      auth: "deploy-control-token",
      operationId: "createGcpServiceAccountJsonConnection",
      openapi: {
        requestSchema: "CreateConnectionSubrouteRequest",
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
  const createConnectionFromSubroute =
    (build: (body: ConnectionSubrouteBody) => CreateConnectionRequest) =>
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
        ensureConnectionPermission(
          auth.principal,
          request.spaceId,
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
    TAKOSUMI_CONNECTIONS_SOURCE_HTTPS_TOKEN_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) =>
      buildSourceConnectionRequest(body, "source_git_https_token"),
    ),
  );

  app.post(
    TAKOSUMI_CONNECTIONS_SOURCE_SSH_KEY_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) =>
      buildSourceConnectionRequest(body, "source_git_ssh_key"),
    ),
  );

  app.post(
    TAKOSUMI_CONNECTIONS_CLOUDFLARE_TOKEN_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) =>
      buildCloudflareConnectionRequest(body),
    ),
  );

  app.post(
    TAKOSUMI_CONNECTIONS_AWS_ASSUME_ROLE_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) =>
      buildAwsAssumeRoleConnectionRequest(body),
    ),
  );

  app.post(
    TAKOSUMI_CONNECTIONS_GENERIC_ENV_PROVIDER_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) =>
      buildGenericEnvProviderConnectionRequest(body),
    ),
  );

  const requireOAuthHelper = (
    provider: "cloudflare" | "gcp",
  ): ConnectionOAuthHelper => {
    const helper = dependencies.connectionOAuthHelpers?.[provider];
    if (!helper) {
      throw new OpenTofuControllerError(
        "not_implemented",
        `${provider === "cloudflare" ? "cloudflare" : "gcp"} oauth connection driver not wired`,
      );
    }
    return helper;
  };

  const startOAuthHelper =
    (provider: "cloudflare" | "gcp") =>
    async (c: Context): Promise<Response> => {
      const auth = await authorizeDeployControl(c, dependencies);
      if (!auth.ok) return auth.response;
      const limit = enforceBodyLimit(c, DEPLOY_CONTROL_JSON_BODY_LIMIT_BYTES);
      if (limit) return limit;
      return await runHandler(c, async () => {
        const helper = requireOAuthHelper(provider);
        const body = await readJsonBody<ConnectionOAuthStartBody>(
          c,
          "connectionOAuthStart",
        );
        ensureConnectionPermission(auth.principal, body.spaceId, body.scope);
        return c.json(
          await helper.start({
            provider,
            request: c.req.raw,
            principal: auth.principal,
            body,
          }),
          200,
        );
      });
    };

  const completeOAuthHelper =
    (provider: "cloudflare" | "gcp") =>
    async (c: Context): Promise<Response> => {
      const auth = await authorizeDeployControl(c, dependencies);
      if (!auth.ok) return auth.response;
      return await runHandler(c, async () => {
        const helper = requireOAuthHelper(provider);
        const callback = oauthCallbackInput(provider, c, auth.principal);
        const completion = await helper.complete(callback);
        const request = normalizeOAuthConnectionRequest(
          provider,
          completion.request,
        );
        ensureConnectionPermission(
          auth.principal,
          request.spaceId,
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
    TAKOSUMI_CONNECTIONS_CLOUDFLARE_OAUTH_START_ROUTE,
    deployControlBodyLimit,
    startOAuthHelper("cloudflare"),
  );
  app.get(
    TAKOSUMI_CONNECTIONS_CLOUDFLARE_OAUTH_CALLBACK_ROUTE,
    completeOAuthHelper("cloudflare"),
  );
  app.post(
    TAKOSUMI_CONNECTIONS_GCP_OAUTH_START_ROUTE,
    deployControlBodyLimit,
    startOAuthHelper("gcp"),
  );
  app.get(
    TAKOSUMI_CONNECTIONS_GCP_OAUTH_CALLBACK_ROUTE,
    completeOAuthHelper("gcp"),
  );
  app.post(
    TAKOSUMI_CONNECTIONS_GCP_IMPERSONATION_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) =>
      buildGcpImpersonationConnectionRequest(body),
    ),
  );
  app.post(
    TAKOSUMI_CONNECTIONS_GCP_SERVICE_ACCOUNT_JSON_ROUTE,
    deployControlBodyLimit,
    createConnectionFromSubroute((body) =>
      buildGcpServiceAccountJsonConnectionRequest(body),
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
    const page = parsePageParams(c);
    if (page.kind === "invalid") return page.response;
    return await runHandler(c, async () => {
      ensureSpacePermission(auth.principal, spaceId);
      return c.json(await controller.listConnections(spaceId, page.value), 200);
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
        // Activity (§27 / §34): mirror connection.created for space-scoped
        // revocation. Emit only non-secret context captured before the sealed
        // secret blob is deleted.
        if (dependencies.activityService && connection.spaceId) {
          await dependencies.activityService.record({
            spaceId: connection.spaceId,
            actorId: principal.actor,
            action: "connection.revoked",
            targetType: "connection",
            targetId: connection.id,
            metadata: {
              provider: connection.provider,
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
  connection: Connection,
): Promise<void> {
  const activityService = ctx.dependencies.activityService;
  if (!activityService || !connection.spaceId) return;
  await activityService.record({
    spaceId: connection.spaceId,
    actorId,
    action: "connection.created",
    targetType: "connection",
    targetId: connection.id,
    metadata: {
      provider: connection.provider,
      ...(connection.kind ? { kind: connection.kind } : {}),
      scope: connection.scope,
    },
  });
}

function normalizeOAuthConnectionRequest(
  helperProvider: "cloudflare" | "gcp",
  request: CreateConnectionRequest,
): CreateConnectionRequest {
  const normalized =
    helperProvider === "gcp" && request.provider === "gcp"
      ? { ...request, provider: "google" }
      : request;
  return {
    ...normalized,
    credentialDriver:
      normalized.credentialDriver ??
      (helperProvider === "gcp" ? "gcp_oauth_bootstrap" : "cloudflare_oauth"),
  };
}

function oauthCallbackInput(
  provider: "cloudflare" | "gcp",
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
    provider,
    request: c.req.raw,
    principal,
    code,
    state,
    query,
  };
}
