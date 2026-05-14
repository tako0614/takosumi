import {
  createKernelContainerRequest,
  isKernelControlPlanePath,
  TAKOSUMI_KERNEL_CONTAINER_INSTANCE,
} from "./routes.ts";

export interface CloudflareWorkerEnv {
  readonly TAKOS_D1: D1Database;
  readonly TAKOS_ARTIFACTS: R2Bucket;
  readonly TAKOS_QUEUE: Queue<unknown>;
  readonly TAKOS_COORDINATION: DurableObjectNamespace;
  readonly TAKOS_WORKLOAD_CONTAINER: DurableObjectNamespace;
  readonly TAKOS_KERNEL_CONTAINER?: DurableObjectNamespace;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
}

interface R2Bucket {
  head(key: string): Promise<unknown>;
}

interface Queue<T> {
  send(message: T): Promise<void>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface CloudflareWorkerHandler {
  fetch(request: Request, env: CloudflareWorkerEnv): Promise<Response>;
}

export type CloudflareContainerResolver = (
  namespace: DurableObjectNamespace,
  instanceName: string,
) => DurableObjectStub;

export interface CreateCloudflareWorkerOptions {
  readonly getContainer: CloudflareContainerResolver;
  readonly kernelContainerInstance?: string;
}

export function createCloudflareWorker(
  options: CreateCloudflareWorkerOptions,
): CloudflareWorkerHandler {
  const kernelContainerInstance = options.kernelContainerInstance ??
    TAKOSUMI_KERNEL_CONTAINER_INSTANCE;
  return {
    async fetch(
      request: Request,
      env: CloudflareWorkerEnv,
    ): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, provider: "cloudflare" });
      }
      if (url.pathname.startsWith("/coordination/")) {
        const id = env.TAKOS_COORDINATION.idFromName("takos-control-plane");
        const targetPath = `/${url.pathname.slice("/coordination/".length)}`;
        return env.TAKOS_COORDINATION.get(id).fetch(
          new Request(new URL(targetPath, request.url), request),
        );
      }
      if (url.pathname === "/queue/test" && request.method === "POST") {
        await env.TAKOS_QUEUE.send(await request.json());
        return Response.json({ queued: true });
      }
      if (url.pathname === "/storage/healthz") {
        await env.TAKOS_D1.prepare("select 1").first();
        await env.TAKOS_ARTIFACTS.head("healthz");
        return Response.json({ ok: true, storage: "cloudflare" });
      }
      if (isKernelControlPlanePath(url.pathname)) {
        const namespace = env.TAKOS_KERNEL_CONTAINER ??
          env.TAKOS_WORKLOAD_CONTAINER;
        return options.getContainer(namespace, kernelContainerInstance).fetch(
          createKernelContainerRequest(request),
        );
      }
      if (url.pathname.startsWith("/runtime/")) {
        const instanceName = url.searchParams.get("instance") ?? "default";
        return options.getContainer(
          env.TAKOS_WORKLOAD_CONTAINER,
          instanceName,
        ).fetch(request);
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  };
}
