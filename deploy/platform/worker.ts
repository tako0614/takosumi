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
  async fetch(request: Request, env: CloudflareWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    // Source webhook surface (Core Specification §6). This is a NEW top-level
    // prefix the accounts handler does not own; handle it here via the
    // deploy-control service seam BEFORE delegating to the accounts handler.
    if (url.pathname.startsWith("/hooks/sources/")) {
      return await handleSourceWebhook(request, url, env);
    }
    return accountsWorker.fetch(request, env);
  },
  queue(batch: QueueBatch, env: CloudflareWorkerEnv): Promise<void> {
    return runQueueConsumer(batch, env as unknown as DeployControlEnv);
  },
  // Scheduled source polling (Core Specification §6). Every cron tick, scan the
  // active sources whose autoSync flag is set and enqueue a deduped source_sync.
  scheduled(_event: unknown, env: CloudflareWorkerEnv): Promise<void> {
    return runScheduledSourcePoll(env as unknown as DeployControlEnv);
  },
};

const SOURCE_ID_PATTERN = /^src_[0-9a-zA-Z]{8,64}$/;

/**
 * Subset of the deploy-control operations facade the source webhook / scheduler
 * need. Kept narrow so the seam-level handlers are unit-testable with a stub.
 */
export interface SourceWebhookOperations {
  verifySourceHookSecret(
    sourceId: string,
    presentedSecret: string,
  ): Promise<boolean>;
  createSourceSync(
    sourceId: string,
    options?: { readonly dedupe?: boolean },
  ): Promise<{ readonly run: { readonly id: string } }>;
}

export interface SourcePollOperations extends SourceWebhookOperations {
  readonly controller: {
    listAutoSyncSources(limit: number): Promise<readonly { readonly id: string }[]>;
  };
}

async function handleSourceWebhook(
  request: Request,
  url: URL,
  env: CloudflareWorkerEnv,
): Promise<Response> {
  const operations = await deployControlSeam(
    env as unknown as DeployControlEnv,
  ).operations();
  return await handleSourceWebhookRequest(request, url, operations);
}

/**
 * Per-source webhook seam (`POST /hooks/sources/:sourceId`). The bearer is the
 * per-source hook secret (compared against the stored hash by the source
 * service). The payload body is IGNORED (untrusted); a valid bearer triggers a
 * deduped source_sync for the source's default ref.
 */
export async function handleSourceWebhookRequest(
  request: Request,
  url: URL,
  operations: SourceWebhookOperations,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const sourceId = decodeURIComponent(
    url.pathname.slice("/hooks/sources/".length),
  );
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const bearer = bearerFromAuthorization(
    request.headers.get("authorization") ?? "",
  );
  if (!bearer) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  let valid = false;
  try {
    valid = await operations.verifySourceHookSecret(sourceId, bearer);
  } catch {
    valid = false;
  }
  if (!valid) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  // Payload is untrusted and ignored; effect is a deduped re-resolution.
  const { run } = await operations.createSourceSync(sourceId, { dedupe: true });
  return Response.json({ accepted: true, runId: run.id }, { status: 202 });
}

function bearerFromAuthorization(header: string): string | undefined {
  const prefix = "Bearer ";
  return header.startsWith(prefix) ? header.slice(prefix.length) : undefined;
}

// Capped batch so a single cron tick never enqueues an unbounded number of runs.
const SCHEDULED_SOURCE_POLL_BATCH = 50;

async function runScheduledSourcePoll(env: DeployControlEnv): Promise<void> {
  const operations = await deployControlSeam(env).operations();
  await pollAutoSyncSources(operations, SCHEDULED_SOURCE_POLL_BATCH);
}

/**
 * Scheduled source polling seam. Scans active sources whose autoSync flag is set
 * and enqueues a deduped source_sync for each (the consumer ls-remotes and only
 * writes a new snapshot when the ref moved). Best-effort and capped.
 */
export async function pollAutoSyncSources(
  operations: SourcePollOperations,
  batch: number,
): Promise<void> {
  const sources = await operations.controller.listAutoSyncSources(batch);
  for (const source of sources) {
    try {
      await operations.createSourceSync(source.id, { dedupe: true });
    } catch {
      // Best-effort: one bad source must not abort the whole poll.
    }
  }
}
