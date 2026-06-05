import type { DeployControlProxyOptions } from "./deploy-control-proxy.ts";

/**
 * Account-plane proxy for the deploy-control Connections surface
 * (`/v1/connections`). Connections register provider credentials; the
 * deploy-control plane owns the secret blob and the Vault broker that mints
 * credential bundles for runs. The account plane only forwards the
 * session-authenticated, space-ownership-checked request to deploy-control over
 * the same in-process seam the PlanRun / ApplyRun proxy uses.
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
 * dispatches into the embedded deploy-control router where the kernel lane
 * registers the `/v1/connections` routes. The single-worker host always injects
 * a `fetch` seam alongside `operations`, so this path is available in-process.
 */

const CONNECTIONS_PATH = "/v1/connections";

export interface ConnectionsProxyResult {
  readonly status: number;
  readonly contentType: string;
  readonly payload: unknown;
}

/** POST /v1/connections — create a Connection (body carries write-only values). */
export async function forwardCreateConnection(input: {
  deployControl: DeployControlProxyOptions;
  body: Record<string, unknown>;
}): Promise<ConnectionsProxyResult> {
  return await forwardConnectionsJson({
    deployControl: input.deployControl,
    method: "POST",
    path: CONNECTIONS_PATH,
    body: input.body,
  });
}

/** GET /v1/connections?spaceId=... — list Connections for a space. */
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

/** POST /v1/connections/{id}/test — verify a Connection's stored credential. */
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

/** GET /v1/connections/{id} — read a single Connection (no secret values). */
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

/** DELETE /v1/connections/{id} — revoke + delete the secret blob. */
export async function forwardDeleteConnection(input: {
  deployControl: DeployControlProxyOptions;
  connectionId: string;
}): Promise<ConnectionsProxyResult> {
  const path = `${CONNECTIONS_PATH}/${encodeURIComponent(input.connectionId)}`;
  return await forwardConnectionsJson({
    deployControl: input.deployControl,
    method: "DELETE",
    path,
  });
}

export function responseFromConnectionsResult(
  result: ConnectionsProxyResult,
): Response {
  // 204 (DELETE) must not carry a body.
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
  method: "GET" | "POST" | "DELETE";
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
