import { INTERNAL_V1_PREFIX } from "takosumi-contract/api-surface";
import type { CloudflareWorkerEnv, QueueBatch } from "./bindings.ts";
import {
  createServiceWorkerRequest,
  isInternalControlPlanePath,
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
export { OpenTofuRunOwnerObject } from "./durable/OpenTofuRunOwnerObject.ts";

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
      if (isCoordinationEdgePath(url.pathname)) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const internalPath = isInternalControlPlanePath(url.pathname);
      if (internalPath && !internalEdgeIngressEnabled(env)) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (isRuntimeAgentPath(url.pathname)) {
        runtimeAgentApp ??= options.createRuntimeAgentApp
          ? options.createRuntimeAgentApp(env)
          : createWorkerServiceApp(env, "takosumi-runtime-agent");
        const created = await runtimeAgentApp;
        return created.app.fetch(createServiceWorkerRequest(request));
      }
      if (isServiceControlPlanePath(url.pathname) || internalPath) {
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

function isRuntimeAgentPath(pathname: string): boolean {
  const prefix = `${INTERNAL_V1_PREFIX}/runtime/agents`;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isCoordinationEdgePath(pathname: string): boolean {
  const prefix = `${INTERNAL_V1_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return false;
  const rest = pathname.slice(prefix.length).replace(/^\/+/, "");
  const [segment] = rest.split("/");
  return segment === "coordination";
}

function internalEdgeIngressEnabled(env: CloudflareWorkerEnv): boolean {
  return (
    env.LOCAL_SUBSTRATE_TEST_BED === "1" ||
    env.TAKOSUMI_EXPOSE_INTERNAL_EDGE === "1"
  );
}
