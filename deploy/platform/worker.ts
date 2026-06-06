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
  createDeployControlQueueConsumer,
  createInProcessDeployControlSeam,
  type QueueBatch,
  TakosCoordinationObject,
  TakosumiOpenTofuRunner,
} from "../cloudflare/src/handler.ts";

export { TakosCoordinationObject, TakosumiOpenTofuRunner };

// In-process deploy-control seam, one cached service per env, shared with the
// unified Takos worker. The accounts deploy-control proxy calls the typed
// `operations` facade directly (no Bearer handshake, no JSON round-trip); the
// HTTP `fetch` dispatch into the embedded service's Hono app is kept as a
// transport fallback. The synthetic base host is never dialed.
const seams = new WeakMap<
  CloudflareWorkerEnv,
  ReturnType<typeof createInProcessDeployControlSeam>
>();

function deployControlSeam(env: CloudflareWorkerEnv) {
  let seam = seams.get(env);
  if (!seam) {
    seam = createInProcessDeployControlSeam(env as unknown as DeployControlEnv);
    seams.set(env, seam);
  }
  return seam;
}

const accountsWorker = createCloudflareWorker({
  deployControlFetch: (env) => deployControlSeam(env).fetch,
  deployControlOperations: (env) => deployControlSeam(env).operations(),
});

// The platform worker owns the public fetch surface (accounts handler) AND runs
// the OpenTofu run-queue consumer in-process. The consumer reaches the same
// in-process deploy-control controller the fetch seam uses, so a run dispatched
// by the create path is executed here against the same store.
const runQueueConsumer = createDeployControlQueueConsumer();

export default {
  fetch(request: Request, env: CloudflareWorkerEnv): Promise<Response> {
    return accountsWorker.fetch(request, env);
  },
  queue(batch: QueueBatch, env: CloudflareWorkerEnv): Promise<void> {
    return runQueueConsumer(batch, env as unknown as DeployControlEnv);
  },
};
