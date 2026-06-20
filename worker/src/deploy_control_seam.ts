import {
  type CreatedTakosumiService,
  type TakosumiOperations,
} from "../../core/bootstrap.ts";
import {
  createDefaultRunnerProfiles,
  resolveEnabledRunnerProfiles,
} from "../../core/domains/deploy-control/mod.ts";
import type { RunnerProfile } from "@takosumi/internal/deploy-control-api";
import type { CloudflareWorkerEnv } from "./bindings.ts";
import { createWorkerServiceApp } from "./worker_service.ts";

/**
 * Builds the deploy-control Takosumi service (the `takosumi-api` role) directly,
 * bypassing the worker fetch dispatcher. The unified Takos worker injects the
 * returned service's `app.fetch` as the in-process deploy-control transport for
 * the accounts handler's deploy-control seam — so the deploy-control plane
 * runs in-process and owns no public route.
 */
export function createDeployControlService(
  env: CloudflareWorkerEnv,
): Promise<CreatedTakosumiService> {
  return createWorkerServiceApp(env, "takosumi-api", {
    runnerProfiles: resolveEnabledRunnerProfilesFromEnv(env),
  });
}

/**
 * The operator-curated provider surface. `createDefaultRunnerProfiles` seeds
 * every reference profile (most as disabled candidates); the operator opts in via
 * `TAKOSUMI_ENABLED_RUNNER_PROFILES` (CSV). Only listed profiles are seeded into
 * the controller, each enabled, so `/v1/runner-profiles` and policy evaluation
 * never expose an unlisted provider. Unset/empty -> `["cloudflare-default"]`.
 */
function resolveEnabledRunnerProfilesFromEnv(
  env: CloudflareWorkerEnv,
): readonly RunnerProfile[] {
  const gatewayAccessOpen = env.TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS === "open";
  const hardeningEnforced =
    env.TAKOSUMI_PRODUCTION_HARDENING_GATE === "enforce";
  return resolveEnabledRunnerProfiles(
    createDefaultRunnerProfiles(),
    env.TAKOSUMI_ENABLED_RUNNER_PROFILES,
    {
      requireGatewayEgressEvidence: gatewayAccessOpen && hardeningEnforced,
      egressEnforcementEvidenceRef:
        env.TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF,
      egressEnforcementEvidenceDigest:
        env.TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST,
    },
  );
}

/**
 * In-process deploy-control seam shared by every single-worker host (the unified
 * Takos worker, the operator platform worker, and the node-postgres composer).
 *
 * It owns the one per-env service cache and the Request normalization that each
 * host used to re-derive. `operations` is the default transport the accounts
 * deploy-control facade calls (the wired OpenTofu controller, with no Bearer
 * handshake and no JSON round-trip); `fetch` dispatches the same per-env cached
 * service's `app.fetch` and is kept only as a transport fallback.
 */
export function createInProcessDeployControlSeam(env: CloudflareWorkerEnv): {
  readonly fetch: typeof fetch;
  readonly operations: () => Promise<TakosumiOperations>;
} {
  const service = () => cachedDeployControlService(env);
  const inProcessFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const created = await service();
    const request =
      input instanceof Request && init === undefined
        ? input
        : new Request(input as RequestInfo | URL, init);
    return await created.app.fetch(request);
  };
  return {
    fetch: inProcessFetch as typeof fetch,
    operations: async () => (await service()).operations,
  };
}

const inProcessDeployControlServices = new WeakMap<
  CloudflareWorkerEnv,
  Promise<CreatedTakosumiService>
>();

export function cachedDeployControlService(
  env: CloudflareWorkerEnv,
): Promise<CreatedTakosumiService> {
  let service = inProcessDeployControlServices.get(env);
  if (!service) {
    service = createDeployControlService(env);
    inProcessDeployControlServices.set(env, service);
  }
  return service;
}
