// THE operator-deployed Takosumi platform worker (app.takosumi.com).
//
// This single worker hosts the accounts plane (bare-origin OIDC issuer +
// dashboard SPA) and the OpenTofu-native deploy-control plane in one process.
// The accounts handler owns every public route and serves the dashboard SPA from
// its built-in ASSETS fallback (non-API GET/HEAD). The deploy-control plane has
// NO public route: it is reached only through the in-process `deployControlFetch`
// seam injected below, exactly as the unified Takos worker reaches it. The two
// Durable Object classes (coordination leases/alarms + the OpenTofu Container
// runner) are re-exported so the wrangler bindings/migrations can name them.

import {
  type CloudflareWorkerEnv,
  createCloudflareWorker,
} from "../accounts-cloudflare/src/handler.ts";
import {
  type CloudflareWorkerEnv as DeployControlEnv,
  createDeployControlService,
  TakosCoordinationObject,
  TakosumiOpenTofuRunner,
} from "../cloudflare/src/handler.ts";

export { TakosCoordinationObject, TakosumiOpenTofuRunner };

// Lazy-cached deploy-control service, one per env (mirrors takos mount.ts).
const services = new WeakMap<
  CloudflareWorkerEnv,
  ReturnType<typeof createDeployControlService>
>();

function deployControlService(env: CloudflareWorkerEnv) {
  let service = services.get(env);
  if (!service) {
    service = createDeployControlService(env as unknown as DeployControlEnv);
    services.set(env, service);
  }
  return service;
}

// In-process deploy-control transport. The accounts deploy-control proxy calls
// this as `fetch(new URL(path, syntheticBase), init)`; we normalize that into a
// Request and dispatch straight into the embedded service's Hono app. The
// synthetic base host is never dialed.
function deployControlFetch(env: CloudflareWorkerEnv): typeof fetch {
  const inProcessFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const service = await deployControlService(env);
    const request = input instanceof Request && init === undefined
      ? input
      : new Request(input as RequestInfo | URL, init);
    return await service.app.fetch(request);
  };
  return inProcessFetch as typeof fetch;
}

export default createCloudflareWorker({ deployControlFetch });
