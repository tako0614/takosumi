import type { Hono as HonoApp } from "hono";
import {
  TAKOS_AGENT_CONTROL_INTERNAL_ENDPOINTS,
  TAKOS_AGENT_CONTROL_INTERNAL_PREFIX,
  type TakosActorContext,
  TakosInternalClient,
} from "takosumi-contract";
import { apiError } from "./errors.ts";
import { type InternalAuthResult, readInternalAuth } from "./internal_auth.ts";

export const TAKOS_AGENT_CONTROL_INVOKE_CAPABILITY = "agent-control.invoke";
export const TAKOS_APP_AGENT_CONTROL_BACKEND_CAPABILITY =
  "app.agent-control.backend";
export const TAKOS_AGENT_CONTROL_BACKEND_PREFIX =
  "/api/internal/v1/agent-control-backend";

export interface AgentControlBackendPort {
  forward(input: {
    readonly endpoint: string;
    readonly body: string;
    readonly contentType?: string;
    readonly actor: TakosActorContext;
  }): Promise<Response>;
}

export interface RegisterAgentControlRoutesOptions {
  readonly getInternalServiceSecret?: () => string | undefined;
  readonly getAppInternalBaseUrl?: () => string | undefined;
  readonly backend?: AgentControlBackendPort;
}

const agentControlEndpoints = new Set<string>(
  TAKOS_AGENT_CONTROL_INTERNAL_ENDPOINTS,
);

export function registerAgentControlRoutes(
  app: HonoApp,
  options: RegisterAgentControlRoutesOptions = {},
): void {
  const getInternalServiceSecret = options.getInternalServiceSecret ??
    (() => Deno.env.get("TAKOS_INTERNAL_SERVICE_SECRET"));

  app.post(`${TAKOS_AGENT_CONTROL_INTERNAL_PREFIX}/:endpoint`, async (c) => {
    return await handleAgentControl(c.req.raw, c.req.param("endpoint"), {
      ...options,
      getInternalServiceSecret,
    });
  });
}

async function handleAgentControl(
  request: Request,
  endpoint: string,
  options:
    & Required<
      Pick<RegisterAgentControlRoutesOptions, "getInternalServiceSecret">
    >
    & RegisterAgentControlRoutesOptions,
): Promise<Response> {
  if (!agentControlEndpoints.has(endpoint)) {
    return Response.json(apiError("not_found", "Unknown agent control RPC"), {
      status: 404,
    });
  }

  const auth = await readInternalAuth(request, {
    secret: options.getInternalServiceSecret(),
  });
  if (!auth.ok) return internalAuthError(auth);
  if (!authorizeAgentControlCaller(auth)) {
    return Response.json(
      apiError("permission_denied", "agent control caller is not authorized"),
      { status: 403 },
    );
  }

  const body = await request.text();
  const backend = options.backend ?? defaultBackend(options);
  if (!backend) {
    return Response.json(
      apiError("unavailable", "agent control backend is not configured"),
      { status: 503 },
    );
  }

  const response = await backend.forward({
    endpoint,
    body,
    contentType: request.headers.get("content-type") ?? undefined,
    actor: auth.actor,
  });
  return proxyResponse(response);
}

function authorizeAgentControlCaller(auth: InternalAuthResult): boolean {
  if (!auth.ok) return false;
  if (auth.caller && !["takos-app", "takos-agent"].includes(auth.caller)) {
    return false;
  }
  return auth.capabilities?.includes(TAKOS_AGENT_CONTROL_INVOKE_CAPABILITY) ??
    false;
}

function defaultBackend(
  options: RegisterAgentControlRoutesOptions,
): AgentControlBackendPort | undefined {
  const secret = options.getInternalServiceSecret?.();
  const baseUrl = options.getAppInternalBaseUrl?.() ??
    Deno.env.get("TAKOS_APP_INTERNAL_URL");
  if (!secret || !baseUrl) return undefined;
  const client = new TakosInternalClient({
    caller: "takosumi",
    audience: "takos-app",
    baseUrl,
    secret,
  });
  return {
    forward(input) {
      const path = `${TAKOS_AGENT_CONTROL_BACKEND_PREFIX}/${input.endpoint}`;
      return client.request({
        method: "POST",
        path,
        body: input.body,
        actor: input.actor,
        capabilities: [TAKOS_APP_AGENT_CONTROL_BACKEND_CAPABILITY],
        headers: input.contentType
          ? { "content-type": input.contentType }
          : undefined,
      });
    },
  };
}

function internalAuthError(auth: Extract<InternalAuthResult, { ok: false }>) {
  return Response.json(
    apiError("unauthorized", auth.error),
    { status: auth.status },
  );
}

function proxyResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
