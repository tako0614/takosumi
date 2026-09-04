import {
  type CreatedTakosumiService,
  type TakosumiOperations,
} from "../../core/bootstrap.ts";
import {
  assertRunnerProfileCatalog,
  createDefaultRunnerProfiles,
  executionEvidenceAuthoritiesEqual,
  resolveEnabledRunnerProfiles,
} from "../../core/domains/deploy-control/mod.ts";
import type { RunnerProfile } from "@takosumi/internal/deploy-control-api";
import type { CloudflareWorkerEnv, RunnerHostComposition } from "./bindings.ts";
import type { OpenTofuRunnerExecutorRegistry } from "../../core/domains/deploy-control/mod.ts";
import type { InterfaceOAuth2ResourceAuthorizer } from "../../core/domains/interfaces/mod.ts";
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
  return createWorkerServiceApp(
    env,
    "takosumi-api",
    deployControlServiceOptions(env),
  );
}

export function deployControlServiceOptions(env: CloudflareWorkerEnv): {
  readonly runnerProfiles: readonly RunnerProfile[];
  readonly runnerExecutors?: OpenTofuRunnerExecutorRegistry;
  readonly executionEvidenceAuthority?: RunnerHostComposition["executionEvidenceAuthority"];
  readonly defaultRunnerProfileId?: string;
  readonly interfaceOAuth2ResourceAuthorizer?: InterfaceOAuth2ResourceAuthorizer;
  readonly mountInternalLedgerRoutes?: boolean;
} {
  const profileConfiguration = validateRunnerProfileConfiguration(env);
  const hostComposition = profileConfiguration.hostComposition;
  const envExecutionEvidenceAuthority = executionEvidenceAuthorityFromEnv(env);
  const hostExecutionEvidenceAuthority =
    hostComposition?.executionEvidenceAuthority;
  if (
    envExecutionEvidenceAuthority &&
    hostExecutionEvidenceAuthority &&
    JSON.stringify(envExecutionEvidenceAuthority) !==
      JSON.stringify(hostExecutionEvidenceAuthority)
  ) {
    throw new TypeError(
      "runner host composition execution evidence authority conflicts with release pins",
    );
  }
  const effectiveExecutionEvidenceAuthority =
    hostExecutionEvidenceAuthority ?? envExecutionEvidenceAuthority;
  if (effectiveExecutionEvidenceAuthority) {
    const configuredProfiles =
      hostComposition?.profiles ?? profileConfiguration.runnerProfiles;
    for (const profile of configuredProfiles) {
      const profileAuthority = profile.executionEvidenceAuthority;
      if (
        profileAuthority &&
        !executionEvidenceAuthoritiesEqual(
          profileAuthority,
          effectiveExecutionEvidenceAuthority,
        )
      ) {
        throw new TypeError(
          `runner profile ${profile.id} execution evidence authority conflicts with release pins`,
        );
      }
    }
  }
  const interfaceOAuth2ResourceAuthorizer =
    interfaceOAuth2ResourceAuthorizerFromEnv(env);
  return {
    runnerProfiles: profileConfiguration.runnerProfiles,
    ...(interfaceOAuth2ResourceAuthorizer
      ? { interfaceOAuth2ResourceAuthorizer }
      : {}),
    ...(env.LOCAL_SUBSTRATE_TEST_BED === "1" ||
    env.TAKOSUMI_EXPOSE_INTERNAL_EDGE === "1"
      ? { mountInternalLedgerRoutes: true }
      : {}),
    ...(hostComposition?.executors
      ? { runnerExecutors: hostComposition.executors }
      : {}),
    ...(effectiveExecutionEvidenceAuthority
      ? {
          executionEvidenceAuthority: effectiveExecutionEvidenceAuthority,
        }
      : {}),
    ...(profileConfiguration.defaultRunnerProfileId
      ? { defaultRunnerProfileId: profileConfiguration.defaultRunnerProfileId }
      : {}),
  };
}

/**
 * Validate every production runner-profile input without constructing the
 * controller. Hosted entrypoints call this before composing their environment
 * so an invalid profile setting cannot reach a Durable Object or a store seed.
 */
export function validateRunnerProfileConfiguration(
  env: CloudflareWorkerEnv,
): {
  readonly hostComposition?: RunnerHostComposition;
  readonly runnerProfiles: readonly RunnerProfile[];
  readonly defaultRunnerProfileId?: string;
} {
  const hostComposition = runnerHostCompositionFromEnv(env);
  const runnerProfiles = resolveEnabledRunnerProfilesFromEnv(env, hostComposition);
  const configuredDefaultRunnerProfileId =
    env.TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID;
  if (
    configuredDefaultRunnerProfileId !== undefined &&
    typeof configuredDefaultRunnerProfileId !== "string"
  ) {
    throw new TypeError(
      "TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID must be a string",
    );
  }
  const defaultRunnerProfileId = configuredDefaultRunnerProfileId?.trim();
  if (
    defaultRunnerProfileId &&
    !runnerProfiles.some((profile) => profile.id === defaultRunnerProfileId)
  ) {
    throw new Error(`unknown default runner profile id ${defaultRunnerProfileId}`);
  }
  return {
    ...(hostComposition ? { hostComposition } : {}),
    runnerProfiles,
    ...(defaultRunnerProfileId ? { defaultRunnerProfileId } : {}),
  };
}

const EXECUTION_EVIDENCE_AUTHORITY_ENV_NAMES = [
  "TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST",
  "TAKOSUMI_RUNNER_ARTIFACT_DIGEST",
  "TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST",
] as const;

type ExecutionEvidenceAuthority = NonNullable<
  RunnerHostComposition["executionEvidenceAuthority"]
>;

/**
 * Resolve the host's immutable mutation identities from raw Worker vars.
 * Durable Object classes are constructed by the platform with the original
 * env object, not the fetch wrapper, so this parser is the shared raw-env
 * boundary for both the request and RunOwner service compositions.
 *
 * The release tool is the only producer of these vars. We deliberately accept
 * no labels, Worker Version UUIDs, defaults, or partial sets: an absent set
 * leaves read-only/plan work available while apply/destroy fail closed in Core.
 */
export function executionEvidenceAuthorityFromEnv(
  env: Pick<
    CloudflareWorkerEnv,
    | "TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST"
    | "TAKOSUMI_RUNNER_ARTIFACT_DIGEST"
    | "TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST"
  >,
): ExecutionEvidenceAuthority | undefined {
  const values = EXECUTION_EVIDENCE_AUTHORITY_ENV_NAMES.map((name) => {
    const value = env[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value !== value.trim()) {
      throw new TypeError(`${name} must be an exact sha256 digest`);
    }
    return value;
  });
  return executionEvidenceAuthorityFromValues(
    values,
    EXECUTION_EVIDENCE_AUTHORITY_ENV_NAMES,
  );
}

/**
 * Validate an authority supplied by a trusted host-code composition. Keeping
 * this beside the raw-env parser prevents fetch, scheduled, and RunOwner
 * construction from accepting subtly different identity shapes.
 */
export function executionEvidenceAuthorityFromComposition(
  value: unknown,
): ExecutionEvidenceAuthority | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(
      "runner host composition execution evidence authority must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  const fields = ["controllerArtifact", "runnerArtifact", "executorArtifact"] as const;
  if (
    Reflect.ownKeys(record).some(
      (key) =>
        typeof key !== "string" ||
        !fields.includes(key as (typeof fields)[number]),
    )
  ) {
    throw new TypeError(
      "runner host composition execution evidence authority is not closed",
    );
  }
  const values = fields.map((field) => {
    const artifact = record[field];
    if (
      typeof artifact !== "object" ||
      artifact === null ||
      Array.isArray(artifact)
    ) {
      throw new TypeError(
        `runner host composition ${field} authority is invalid`,
      );
    }
    const artifactRecord = artifact as Record<string, unknown>;
    if (
      Reflect.ownKeys(artifactRecord).some(
        (key) => key !== "digest" && key !== "immutable",
      ) ||
      artifactRecord.immutable !== true
    ) {
      throw new TypeError(
        `runner host composition ${field} authority is invalid`,
      );
    }
    return artifactRecord.digest;
  });
  return executionEvidenceAuthorityFromValues(
    values,
    fields.map((field) => `runner host composition ${field}`),
  );
}

function executionEvidenceAuthorityFromValues(
  values: readonly unknown[],
  labels: readonly string[],
): ExecutionEvidenceAuthority | undefined {
  if (values.every((value) => value === undefined)) return undefined;
  const missing = labels.filter((_, index) => values[index] === undefined);
  if (missing.length > 0) {
    throw new TypeError(
      `execution evidence authority is incomplete; missing ${missing.join(", ")}`,
    );
  }
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
      throw new TypeError(`${labels[index]} must be an exact sha256 digest`);
    }
  }
  return Object.freeze({
    controllerArtifact: Object.freeze({
      digest: values[0]! as `sha256:${string}`,
      immutable: true,
    }),
    runnerArtifact: Object.freeze({
      digest: values[1]! as `sha256:${string}`,
      immutable: true,
    }),
    executorArtifact: Object.freeze({
      digest: values[2]! as `sha256:${string}`,
      immutable: true,
    }),
  });
}

function interfaceOAuth2ResourceAuthorizerFromEnv(
  env: CloudflareWorkerEnv,
): InterfaceOAuth2ResourceAuthorizer | undefined {
  const value = env.TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER;
  if (value === undefined) return undefined;
  if (typeof value !== "function") {
    throw new TypeError(
      "TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER must be a host-code function",
    );
  }
  return value;
}

export function createRunOwnerDeployControlService(
  env: CloudflareWorkerEnv,
): Promise<CreatedTakosumiService> {
  // Source sync can create an auto-update Plan, and a completed auto-update
  // Plan can create an Apply. Those are distinct ledger Runs and must be
  // scheduled through their own RunOwner objects. The standard worker-service
  // enqueuer wiring does that; no-op enqueuers strand follow-up Runs as queued.
  return createWorkerServiceApp(
    env,
    "takosumi-api",
    deployControlServiceOptions(env),
  );
}

/**
 * The operator-curated execution surface. The built-in seed is one
 * provider-neutral OpenTofu profile; additional configured profiles represent
 * execution capabilities such as private-network or host-agent access, never a
 * list of supported providers.
 */
function resolveEnabledRunnerProfilesFromEnv(
  env: CloudflareWorkerEnv,
  hostComposition: RunnerHostComposition | undefined,
): readonly RunnerProfile[] {
  const profiles = [
    ...createDefaultRunnerProfiles(),
    ...(hostComposition?.profiles ?? []),
  ];
  assertUniqueRunnerProfileIds(profiles);
  return resolveEnabledRunnerProfiles(
    profiles,
    env.TAKOSUMI_ENABLED_RUNNER_PROFILES,
  );
}

const RUNNER_HOST_COMPOSITION_KEYS = new Set([
  "profiles",
  "executors",
  "executionEvidenceAuthority",
]);

export function runnerHostCompositionFromEnv(
  env: CloudflareWorkerEnv,
): RunnerHostComposition | undefined {
  const value = env.TAKOSUMI_RUNNER_HOST_COMPOSITION;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(
      "TAKOSUMI_RUNNER_HOST_COMPOSITION must be a host-code runtime object",
    );
  }
  const record = value as unknown as Record<string, unknown>;
  const unknownKeys = Reflect.ownKeys(record).filter(
    (key) => typeof key !== "string" || !RUNNER_HOST_COMPOSITION_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new TypeError(
      `TAKOSUMI_RUNNER_HOST_COMPOSITION has unknown key ${unknownKeys
        .map((key) => String(key))
        .join(", ")}`,
    );
  }
  const profiles = record.profiles;
  if (!Array.isArray(profiles)) {
    throw new TypeError(
      "TAKOSUMI_RUNNER_HOST_COMPOSITION.profiles must be an array",
    );
  }
  assertRunnerProfileCatalog(profiles, {
    rejectUnknownKeys: true,
    requireCreatedAt: true,
  });
  const executors = record.executors;
  if (executors !== undefined) {
    if (!(executors instanceof Map)) {
      throw new TypeError(
        "TAKOSUMI_RUNNER_HOST_COMPOSITION.executors must be an executor registry",
      );
    }
    const executorIds = new Set<string>();
    for (const executorId of executors.keys()) {
      if (typeof executorId !== "string" || executorId.trim().length === 0) {
        throw new TypeError(
          "TAKOSUMI_RUNNER_HOST_COMPOSITION.executors contains an empty executorId",
        );
      }
      if (executorIds.has(executorId)) {
        throw new Error(
          `TAKOSUMI_RUNNER_HOST_COMPOSITION.executors contains duplicate executorId ${executorId}`,
        );
      }
      executorIds.add(executorId);
    }
  }
  const executionEvidenceAuthority = executionEvidenceAuthorityFromComposition(
    record.executionEvidenceAuthority,
  );
  return {
    profiles,
    ...(executors !== undefined
      ? { executors: executors as RunnerHostComposition["executors"] }
      : {}),
    ...(executionEvidenceAuthority ? { executionEvidenceAuthority } : {}),
  };
}

function assertUniqueRunnerProfileIds(
  profiles: readonly RunnerProfile[],
): void {
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (!profile.id?.trim()) {
      throw new Error("runner host composition contains an empty profile id");
    }
    if (ids.has(profile.id)) {
      throw new Error(
        `runner host composition contains duplicate profile ${profile.id}`,
      );
    }
    ids.add(profile.id);
  }
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

/**
 * @internal
 *
 * Resolve one service attempt per environment and evict only rejected
 * attempts. The identity check prevents a late rejection from an older
 * generation from deleting a newer retry. Pending attempts are deliberately
 * retained: request-level deadlines belong to the Accounts caller and must
 * not abort or replace this shared initializer. A genuinely never-resolving
 * initializer therefore remains a pending cache entry. The code does not
 * abort or evict it, but cannot guarantee that the runtime will keep the
 * isolate alive; future cooperative cancellation/generation fencing is
 * required for self-recovery beyond this containment boundary.
 */
export function cachedServiceAttempt<TEnvironment extends object, TValue>(
  cache: WeakMap<TEnvironment, Promise<TValue>>,
  env: TEnvironment,
  create: () => Promise<TValue>,
): Promise<TValue> {
  const cached = cache.get(env);
  if (cached) return cached;

  const attempt = Promise.resolve().then(create);
  cache.set(env, attempt);
  void attempt.catch(() => {
    if (cache.get(env) === attempt) cache.delete(env);
  });
  return attempt;
}

export function cachedDeployControlService(
  env: CloudflareWorkerEnv,
): Promise<CreatedTakosumiService> {
  return cachedServiceAttempt(inProcessDeployControlServices, env, () =>
    createDeployControlService(env),
  );
}

const runOwnerDeployControlServices = new WeakMap<
  CloudflareWorkerEnv,
  Promise<CreatedTakosumiService>
>();

export function cachedRunOwnerDeployControlService(
  env: CloudflareWorkerEnv,
): Promise<CreatedTakosumiService> {
  return cachedServiceAttempt(runOwnerDeployControlServices, env, () =>
    createRunOwnerDeployControlService(env),
  );
}
