import { constantTimeEqualsString } from "../../core/shared/constant_time.ts";
import { INTERNAL_V1_PREFIX } from "takosumi-contract/api-surface";
import type { CloudflareWorkerEnv, QueueBatch } from "./bindings.ts";
import {
  createServiceWorkerRequest,
  isServiceControlPlanePath,
} from "./routes.ts";
import { createWorkerServiceApp } from "./worker_service.ts";
import { consumeOpenTofuRunBatch } from "./run_queue_consumer.ts";

export type { CloudflareWorkerEnv, QueueBatch } from "./bindings.ts";

// Re-export the deploy-control seam + service factory so a host worker (e.g. the
// unified Takos worker or the operator platform worker) can pull every
// deploy-control export — the in-process service factory, the cached seam, and
// the DO classes the wrangler bindings reference — from this one entry point.
export {
  createDeployControlService,
  createInProcessDeployControlSeam,
} from "./deploy_control_seam.ts";

// Durable Object classes that back the embedded deploy-control plane. Re-exported
// from the single handler module so a host worker (e.g. the unified Takos worker)
// can pull every deploy-control export — the in-process service factory and the
// DO classes the wrangler bindings reference — from one entry point.
export { CoordinationObject } from "./durable/CoordinationObject.ts";
export { OpenTofuRunnerObject } from "./durable/OpenTofuRunnerObject.ts";

export interface CloudflareWorkerHandler {
  fetch(request: Request, env: CloudflareWorkerEnv): Promise<Response>;
  queue(batch: QueueBatch, env: CloudflareWorkerEnv): Promise<void>;
}

export interface CreatedCloudflareWorkerApp {
  readonly app: {
    fetch(request: Request): Promise<Response> | Response;
  };
}

export interface CreateCloudflareWorkerOptions {
  readonly createServiceApp?: (
    env: CloudflareWorkerEnv,
  ) => Promise<CreatedCloudflareWorkerApp>;
  readonly createRuntimeAgentApp?: (
    env: CloudflareWorkerEnv,
  ) => Promise<CreatedCloudflareWorkerApp>;
}

export function createCloudflareWorker(
  options: CreateCloudflareWorkerOptions = {},
): CloudflareWorkerHandler {
  let serviceApp: Promise<CreatedCloudflareWorkerApp> | undefined;
  let runtimeAgentApp: Promise<CreatedCloudflareWorkerApp> | undefined;

  return {
    async fetch(request: Request, env: CloudflareWorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, provider: "cloudflare-worker" });
      }
      if (url.pathname.startsWith("/coordination/")) {
        const denied = denyUnauthorizedCoordination(request, env);
        if (denied) return denied;
        const id = env.COORDINATION.idFromName("takos-control-plane");
        const targetPath = `/${url.pathname.slice("/coordination/".length)}`;
        return env.COORDINATION.get(id).fetch(
          new Request(new URL(targetPath, request.url), request),
        );
      }
      if (isRuntimeAgentPath(url.pathname)) {
        runtimeAgentApp ??= options.createRuntimeAgentApp
          ? options.createRuntimeAgentApp(env)
          : createWorkerServiceApp(env, "takosumi-runtime-agent");
        const created = await runtimeAgentApp;
        return created.app.fetch(createServiceWorkerRequest(request));
      }
      if (isServiceControlPlanePath(url.pathname)) {
        serviceApp ??= options.createServiceApp
          ? options.createServiceApp(env)
          : createWorkerServiceApp(env, "takosumi-api");
        const created = await serviceApp;
        return created.app.fetch(createServiceWorkerRequest(request));
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
    async queue(batch: QueueBatch, env: CloudflareWorkerEnv): Promise<void> {
      await consumeOpenTofuRunBatch(batch, env);
    },
  };
}

/**
 * The deploy-control queue consumer, factored out so a composing host worker
 * (the operator's Takosumi platform worker) can mount it as its `queue()`
 * handler. The platform worker owns the public fetch surface via the accounts
 * handler but must run the OpenTofu run-queue consumer in-process; this is the
 * single entry point it wires up.
 */
export function createDeployControlQueueConsumer(): (
  batch: QueueBatch,
  env: CloudflareWorkerEnv,
) => Promise<void> {
  return (batch, env) => consumeOpenTofuRunBatch(batch, env);
}

/**
 * The `/coordination/*` route forwards straight to a single shared
 * {@link CoordinationObject} Durable Object (lease/alarm storage for the
 * control plane). It is an internal control-plane surface, so it must not be
 * edge-reachable without authentication. We gate it on the same operator secret
 * as the Deploy Control API (`TAKOSUMI_DEPLOY_CONTROL_TOKEN`):
 *
 * - token unset  -> the control-plane surface is not exposed -> 404 (mirrors the
 *   Deploy Control "routes disabled" behavior, so an unconfigured host never
 *   accepts unauthenticated writes into the coordination DO).
 * - token set    -> require `Authorization: Bearer <token>`, constant-time
 *   compared; 401 on missing/invalid bearer.
 *
 * Returns a Response when the request must be rejected, or undefined when it is
 * authorized and may proceed to the Durable Object.
 */
function denyUnauthorizedCoordination(
  request: Request,
  env: CloudflareWorkerEnv,
): Response | undefined {
  const configuredToken = typeof env.TAKOSUMI_DEPLOY_CONTROL_TOKEN === "string"
    ? env.TAKOSUMI_DEPLOY_CONTROL_TOKEN
    : undefined;
  if (!configuredToken) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  const bearer = header.startsWith(prefix)
    ? header.slice(prefix.length)
    : undefined;
  if (!bearer || !constantTimeEqualsString(bearer, configuredToken)) {
    return Response.json(
      { error: "invalid coordination bearer" },
      { status: 401 },
    );
  }
  return undefined;
}

function isRuntimeAgentPath(pathname: string): boolean {
  const prefix = `${INTERNAL_V1_PREFIX}/runtime/agents`;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
