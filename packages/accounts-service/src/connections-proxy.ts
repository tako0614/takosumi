import type { DeployControlProxyOptions } from "./deploy-control-proxy.ts";

/**
 * Account-plane proxy for the deploy-control Connections surface
 * (`/api/connections/...`, spec §30). Connections register provider
 * credentials; the deploy-control plane owns the secret blob and the Vault
 * broker that mints credential bundles for runs. The account plane only
 * forwards the session-authenticated, space-ownership-checked request to
 * deploy-control over the same in-process seam the PlanRun / ApplyRun proxy
 * uses.
 *
 * Connection creation is split into kind-specific §30 subroutes
 * (`/api/connections/source/https-token`, `/source/ssh-key`,
 * `/cloudflare/token`, `/aws/assume-role`); this proxy selects the subroute
 * from the create body's `kind` / `provider` (the body still carries the
 * write-only credential `values`). Connection revoke maps to the §30
 * `POST /api/connections/{id}/revoke` subroute (the former DELETE handler).
 *
 * SECRETS: the create body carries write-only `values` (credential material).
 * This module is a pure forwarder — it never logs, echoes, or serializes the
 * request/response body anywhere but the forwarded transport. Do not add
 * logging here. The deploy-control surface never echoes `values` back (the
 * public {@link Connection} type has no secret fields), so forwarding the
 * upstream response verbatim is safe.
 *
 * Unlike the PlanRun / ApplyRun proxy (which adapts to the typed
 * `DeployControlOperations` facade), the Connections routes are forwarded over
 * the {@link DeployControlProxyOptions.fetch} transport: that transport
 * dispatches into the embedded deploy-control router where the control plane
 * registers the `/api/connections/...` routes. The single-worker host always
 * injects a `fetch` seam alongside `operations`, so this path is available
 * in-process.
 */

const CONNECTIONS_PATH = "/api/connections";

/**
 * Selects the §30 connection-creation subroute from the create body. Mirrors
 * the deploy-control subroutes; defaults to the Cloudflare provider-token
 * subroute when the body is a plain provider credential.
 */
function connectionCreateSubroute(body: Record<string, unknown>): string {
  const kind = typeof body.kind === "string" ? body.kind : undefined;
  if (kind === "source_git_https_token") {
    return `${CONNECTIONS_PATH}/source/https-token`;
  }
  if (kind === "source_git_ssh_key") {
    return `${CONNECTIONS_PATH}/source/ssh-key`;
  }
  const provider = typeof body.provider === "string" ? body.provider : undefined;
  if (provider === "aws") return `${CONNECTIONS_PATH}/aws/assume-role`;
  // Default provider credential: Cloudflare API token.
  return `${CONNECTIONS_PATH}/cloudflare/token`;
}

export interface ConnectionsProxyResult {
  readonly status: number;
  readonly contentType: string;
  readonly payload: unknown;
}

/**
 * POST a §30 connection-creation subroute (body carries write-only values). The
 * subroute is selected from the body's `kind` / `provider`.
 */
export async function forwardCreateConnection(input: {
  deployControl: DeployControlProxyOptions;
  body: Record<string, unknown>;
}): Promise<ConnectionsProxyResult> {
  return await forwardConnectionsJson({
    deployControl: input.deployControl,
    method: "POST",
    path: connectionCreateSubroute(input.body),
    body: input.body,
  });
}

/** GET /api/connections?spaceId=... — list Connections for a space. */
export async function forwardListConnections(input: {
  deployControl: DeployControlProxyOptions;
  spaceId: string;
}): Promise<ConnectionsProxyResult> {
  const path = `${CONNECTIONS_PATH}?spaceId=${encodeURIComponent(input.spaceId)}`;
  return await forwardConnectionsJson({
    deployControl: input.deployControl,
    method: "GET",
    path,
  });
}

/** POST /api/connections/{id}/test — verify a Connection's stored credential. */
export async function forwardTestConnection(input: {
  deployControl: DeployControlProxyOptions;
  connectionId: string;
}): Promise<ConnectionsProxyResult> {
  const path = `${CONNECTIONS_PATH}/${
    encodeURIComponent(input.connectionId)
  }/test`;
  return await forwardConnectionsJson({
    deployControl: input.deployControl,
    method: "POST",
    path,
    body: {},
  });
}

/**
 * GET /api/connections/{id} — read a single Connection (no secret values). The
 * §30 surface exposes per-id reads via the operator/space listing rather than a
 * dedicated GET; the account plane resolves a single Connection's `spaceId` for
 * its ownership check by listing the connection's Space and matching the id.
 * Kept as a read helper consumed by {@link forwardTestConnection} /
 * {@link forwardRevokeConnection} callers.
 */
export async function forwardGetConnection(input: {
  deployControl: DeployControlProxyOptions;
  connectionId: string;
}): Promise<ConnectionsProxyResult> {
  const path = `${CONNECTIONS_PATH}/${encodeURIComponent(input.connectionId)}`;
  return await forwardConnectionsJson({
    deployControl: input.deployControl,
    method: "GET",
    path,
  });
}

/** POST /api/connections/{id}/revoke — revoke + delete the secret blob. */
export async function forwardRevokeConnection(input: {
  deployControl: DeployControlProxyOptions;
  connectionId: string;
}): Promise<ConnectionsProxyResult> {
  const path = `${CONNECTIONS_PATH}/${
    encodeURIComponent(input.connectionId)
  }/revoke`;
  return await forwardConnectionsJson({
    deployControl: input.deployControl,
    method: "POST",
    path,
    body: {},
  });
}

export function responseFromConnectionsResult(
  result: ConnectionsProxyResult,
): Response {
  // 204 (revoke) must not carry a body.
  if (result.status === 204) {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify(result.payload), {
    status: result.status,
    headers: { "content-type": result.contentType },
  });
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * Forward a connections request over the deploy-control `fetch` transport. The
 * bearer (the shared deploy-control token) authenticates the embedded service;
 * the synthetic base host is never dialed. No body is logged.
 */
async function forwardConnectionsJson(input: {
  deployControl: DeployControlProxyOptions;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}): Promise<ConnectionsProxyResult> {
  const transport = input.deployControl.fetch ?? fetch;
  const response = await transport(
    new URL(input.path, input.deployControl.url),
    {
      method: input.method,
      headers: {
        accept: "application/json",
        ...(input.method === "POST"
          ? { "content-type": "application/json" }
          : {}),
        ...(input.deployControl.token
          ? { authorization: `Bearer ${input.deployControl.token}` }
          : {}),
      },
      ...(input.method === "POST"
        ? { body: JSON.stringify(input.body ?? {}) }
        : {}),
    },
  );
  const contentType = response.headers.get("content-type") ?? JSON_CONTENT_TYPE;
  if (response.status === 204) {
    return { status: 204, contentType, payload: undefined };
  }
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    payload = text;
  }
  return { status: response.status, contentType, payload };
}
