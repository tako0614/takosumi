/**
 * Runtime-agent HTTP server.
 *
 * Implements the lifecycle protocol from `@takos/takosumi-contract` and
 * dispatches to per-provider connectors. Operators run this on the host that
 * has the cloud credentials (`AWS_ACCESS_KEY_ID`, etc.) or the OS access
 * (docker daemon, systemd) for self-hosted resources.
 */

// @ts-types="npm:hono@^4.12.4"
import { Hono } from "hono";
import {
  LIFECYCLE_APPLY_PATH,
  LIFECYCLE_DESCRIBE_PATH,
  LIFECYCLE_DESTROY_PATH,
  LIFECYCLE_HEALTH_PATH,
  type LifecycleApplyRequest,
  type LifecycleDescribeRequest,
  type LifecycleDestroyRequest,
  type LifecycleErrorBody,
} from "takosumi-contract";
import type { ConnectorRegistry } from "./connectors/mod.ts";
import {
  ConnectorNotFoundError,
  LifecycleDispatcher,
} from "./lifecycle_dispatcher.ts";

export interface RuntimeAgentServerOptions {
  readonly registry: ConnectorRegistry;
  /** Bearer token operators share with the kernel. If unset, the agent
   *  refuses all lifecycle requests. */
  readonly token: string;
}

export function createRuntimeAgentApp(options: RuntimeAgentServerOptions) {
  const dispatcher = new LifecycleDispatcher(options.registry);
  const expectedAuth = `Bearer ${options.token}`;
  const app = new Hono();

  app.get(LIFECYCLE_HEALTH_PATH, (c) => {
    return c.json({
      status: "ok",
      connectors: options.registry.size(),
    });
  });

  // Authenticated registry inspection: which (shape, provider) tuples
  // were wired at boot, given the operator-supplied credentials? Operators
  // should hit this after starting the agent to verify their env vars
  // produced the expected connector set BEFORE running an apply that fails
  // with `connector_not_found`.
  app.get("/v1/connectors", (c) => {
    const auth = c.req.header("authorization");
    if (!auth || auth !== expectedAuth) {
      return c.json(errorBody("unauthorized"), 401);
    }
    const connectors = options.registry.list().map((connector) => ({
      shape: connector.shape,
      provider: connector.provider,
    }));
    return c.json({ connectors }, 200);
  });

  app.use("/v1/lifecycle/*", async (c, next) => {
    const auth = c.req.header("authorization");
    if (!auth || auth !== expectedAuth) {
      return c.json(errorBody("unauthorized"), 401);
    }
    return await next();
  });

  app.post(LIFECYCLE_APPLY_PATH, async (c) => {
    const body = (await c.req.json()) as LifecycleApplyRequest;
    if (!validApply(body)) return c.json(errorBody("bad_request"), 400);
    try {
      const result = await dispatcher.apply(body);
      return c.json(result, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post(LIFECYCLE_DESTROY_PATH, async (c) => {
    const body = (await c.req.json()) as LifecycleDestroyRequest;
    if (!validDestroy(body)) return c.json(errorBody("bad_request"), 400);
    try {
      const result = await dispatcher.destroy(body);
      return c.json(result, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post(LIFECYCLE_DESCRIBE_PATH, async (c) => {
    const body = (await c.req.json()) as LifecycleDescribeRequest;
    if (!validDescribe(body)) return c.json(errorBody("bad_request"), 400);
    try {
      const result = await dispatcher.describe(body);
      return c.json(result, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}

function validApply(body: unknown): body is LifecycleApplyRequest {
  if (!body || typeof body !== "object") return false;
  const r = body as LifecycleApplyRequest;
  return typeof r.shape === "string" &&
    typeof r.provider === "string" &&
    typeof r.resourceName === "string" &&
    "spec" in r;
}

function validDestroy(body: unknown): body is LifecycleDestroyRequest {
  if (!body || typeof body !== "object") return false;
  const r = body as LifecycleDestroyRequest;
  return typeof r.shape === "string" &&
    typeof r.provider === "string" &&
    typeof r.handle === "string";
}

function validDescribe(body: unknown): body is LifecycleDescribeRequest {
  if (!body || typeof body !== "object") return false;
  const r = body as LifecycleDescribeRequest;
  return typeof r.shape === "string" &&
    typeof r.provider === "string" &&
    typeof r.handle === "string";
}

function errorBody(error: string, code?: string): LifecycleErrorBody {
  return code ? { error, code } : { error };
}

// deno-lint-ignore no-explicit-any
function errorResponse(c: any, err: unknown) {
  if (err instanceof ConnectorNotFoundError) {
    return c.json(
      {
        error: err.message,
        code: "connector_not_found",
        details: { shape: err.shape, provider: err.provider },
      } satisfies LifecycleErrorBody,
      404,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message, code: "connector_failed" }, 500);
}

export interface ServeOptions {
  readonly port?: number;
  readonly hostname?: string;
  readonly registry: ConnectorRegistry;
  readonly token: string;
}

export interface ServeHandle {
  readonly url: string;
  readonly port: number;
  shutdown(): Promise<void>;
}

export function serveRuntimeAgent(options: ServeOptions): ServeHandle {
  const app = createRuntimeAgentApp({
    registry: options.registry,
    token: options.token,
  });
  const requestedPort = options.port ?? 8789;
  const hostname = options.hostname ?? "127.0.0.1";
  const server = Deno.serve(
    { port: requestedPort, hostname, onListen: () => {} },
    app.fetch,
  );
  const addr = server.addr as Deno.NetAddr;
  const boundPort = addr.port;
  return {
    url: `http://${hostname}:${boundPort}`,
    port: boundPort,
    shutdown: () => server.shutdown(),
  };
}

export { ConnectorRegistry } from "./connectors/mod.ts";
export {
  ConnectorNotFoundError,
  LifecycleDispatcher,
} from "./lifecycle_dispatcher.ts";
export type { Connector } from "./connectors/mod.ts";
