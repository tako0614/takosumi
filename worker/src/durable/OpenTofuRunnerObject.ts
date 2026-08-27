import type {
  CloudflareWorkerEnv,
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
} from "../bindings.ts";
import { isLegacySourceArchiveRestoreRef } from "../legacy_source_archive_restore.ts";
import {
  maxStateArtifactCiphertextBytes,
  StateArtifactCrypto,
  type SealedArtifact,
} from "../state_crypto.ts";
import {
  RUNNER_MUTATION_INDETERMINATE_CODE,
  type RunnerMutationAction,
  type RunnerMutationIndeterminatePayload,
} from "../runner_protocol.ts";
import {
  isRunCredentialToken,
  runCredentialTokenSecret,
  verifyRunCredentialTokenAuthority,
  type RunCredentialTokenPayload,
} from "../../../core/shared/run_credential_tokens.ts";
import { redactString } from "takosumi-contract/redaction";

const DEFAULT_PLAN_ARTIFACT_BUCKET = "takos-artifacts";
const PLAN_ARTIFACT_CONTENT_TYPE = "application/vnd.opentofu.plan";
const STATE_ARTIFACT_CONTENT_TYPE = "application/json";
const SOURCE_ARCHIVE_CONTENT_TYPE = "application/zstd";
const DEFAULT_PLAN_JSON_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
// At-rest content type for AES-GCM ciphertext blobs (state/plan .enc objects).
const ENCRYPTED_ARTIFACT_CONTENT_TYPE = "application/octet-stream";
const RUNNER_REQUEST_HEADER_ALLOWLIST = new Set(["content-type"]);
const R2_PUT_RETRY_ATTEMPTS = 8;
const R2_PUT_RETRY_BASE_MS = 500;
const R2_PUT_RETRY_MAX_MS = 10_000;
const BOUNDED_STREAM_INITIAL_BYTES = 64 * 1024;
const RUNNER_ARTIFACT_RELAY_FAILED_CODE = "runner_artifact_relay_failed";
const RUNNER_REJECTED_CODE = "runner_rejected";
const RUNNER_RELEASE_COMMAND_FAILED_CODE = "release_command_failed";
const RUNNER_PROVIDER_EXECUTION_FAILED_CODE = "provider_execution_failed";
const RUNNER_PROVIDER_FAILURE_CODES = new Set([
  "apply_failed",
  RUNNER_PROVIDER_EXECUTION_FAILED_CODE,
]);
const RUNNER_PLAN_EXECUTION_FAILURE_CODES = new Set([
  "provider_source_invalid",
  "provider_package_unavailable",
  "provider_platform_binary_unavailable",
  "provider_protocol_mismatch",
  "provider_policy_denied",
  "runner_capability_missing",
  "provider_checksum_mismatch",
  "opentofu_init_failed",
  "source_build_failed",
  "opentofu_plan_failed",
]);
const MAX_NORMALIZED_RUNNER_FAILURE_DETAIL_CHARS = 4_096;
const UNSAFE_PROVIDER_FAILURE_DETAIL_LINE =
  /(?:\b(?:authorization|bearer|cookie|token|password|passwd|secret|credential|api[_-]?key|body)\b|\/work\/)/iu;
type RunnerFailurePhase =
  | "plan"
  | "apply"
  | "destroy"
  | "restore"
  | "source_sync"
  | "backup"
  | "release"
  | "stable_semver_tag"
  | "compatibility_check";
const RUNNER_R2_LOG_REASON = Object.freeze({
  putRetryable: "r2_put_retryable",
  currentStateCacheWriteFailed: "current_state_cache_write_failed",
});
const RUNNER_R2_LOG_ARTIFACT = Object.freeze({
  sourceArchive: "source_archive",
  stateObject: "state_object",
  rawOutputs: "raw_outputs",
  restoredStateObject: "restored_state_object",
  planArtifact: "plan_artifact",
  planJsonArtifact: "plan_json_artifact",
  stateArtifact: "state_artifact",
  statePointer: "state_pointer",
  other: "other",
});

export const RUNNER_ARTIFACT_LIMIT_DEFAULTS = Object.freeze({
  sourceArchive: 50 * 1024 * 1024,
  state: 16 * 1024 * 1024,
  plan: 24 * 1024 * 1024,
  output: 4 * 1024 * 1024,
  runnerResponse: 6 * 1024 * 1024,
  statePointer: 64 * 1024,
  failureDetail: 64 * 1024,
});

const RUNNER_ARTIFACT_LIMIT_ENV = Object.freeze({
  sourceArchive: "TAKOSUMI_RUNNER_SOURCE_ARCHIVE_MAX_BYTES",
  state: "TAKOSUMI_RUNNER_STATE_ARTIFACT_MAX_BYTES",
  plan: "TAKOSUMI_RUNNER_PLAN_ARTIFACT_MAX_BYTES",
  output: "TAKOSUMI_RUNNER_OUTPUT_ARTIFACT_MAX_BYTES",
  runnerResponse: "TAKOSUMI_RUNNER_RESPONSE_MAX_BYTES",
});

type RunnerArtifactKind =
  | "source_archive"
  | "state"
  | "plan"
  | "plan_json"
  | "output"
  | "runner_response"
  | "state_pointer"
  | "failure_detail";

interface RunnerArtifactLimits {
  readonly sourceArchive: number;
  readonly state: number;
  readonly plan: number;
  readonly output: number;
  readonly runnerResponse: number;
  readonly statePointer: number;
  readonly failureDetail: number;
}

interface PreparedRawOutputs {
  readonly key: string;
  readonly action: "apply";
  readonly sealed: SealedArtifact;
}

export class RunnerArtifactSizeLimitError extends Error {
  readonly code = "artifact_size_limit_exceeded";

  constructor(
    readonly artifact: RunnerArtifactKind,
    readonly maxBytes: number,
    readonly observedBytes: number,
  ) {
    super(
      `${artifact} artifact exceeds ${maxBytes} byte limit ` +
        `(observed at least ${observedBytes} bytes)`,
    );
    this.name = "RunnerArtifactSizeLimitError";
  }
}

/**
 * Optional dispatch payload field locating the R2_STATE object for this run.
 * Present when the controller carries Capsule context in the
 * job. When ABSENT the DO falls back to the legacy R2_ARTIFACTS
 * `opentofu-state/...` path so existing jobs/tests keep working (additive, no
 * flag-day). The `generation` is the 8-digit state generation the controller
 * owns; the DO only writes the object at the derived key and returns its digest.
 * Mirrors the contract `DispatchStateScope` ({ workspaceId, subject,
 * environment, generation, stateRef }); kept as a local interface so the DO
 * does not pull a contract import into the worker bundle. Current R2 keys use
 * canonical Workspace/Capsule/Resource vocabulary. Historical state refs used
 * by an explicit adoption request remain opaque read-only coordinates.
 */
interface StateScope {
  readonly workspaceId: string;
  readonly subjectKind: "capsule" | "resource";
  readonly subjectId: string;
  readonly environment: string;
  readonly generation: number;
  /** Opaque to Core; this R2 adapter interprets it as the physical object key. */
  readonly stateRef: string;
  /** Exact canonical state ledger row to restore before this operation. */
  readonly priorState?: StateVersionDescriptor;
}

interface StateVersionDescriptor {
  readonly generation: number;
  readonly stateRef: string;
  readonly digest?: string;
  readonly legacyDigestMissing?: true;
  readonly createdByRunId: string;
}

/**
 * One-shot state seed copied verbatim from an operator-confirmed migration
 * candidate. The DO never discovers a Capsule or StateVersion by itself.
 */
interface StateAdoption {
  readonly kind: "legacy_backing_capsule_state";
  readonly sourceWorkspaceId: string;
  readonly sourceCapsuleId: string;
  readonly sourceEnvironment: string;
  readonly sourceStateVersionId: string;
  readonly stateGeneration: number;
  readonly stateRef: string;
  readonly stateDigest: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
}

/**
 * Optional dispatch payload field locating the source archive to restore into
 * the container workspace for build/plan phases. The DO fetches it from
 * R2_SOURCE, verifies the digest, and streams it to the container restore route.
 */
interface SourceArchiveRestore {
  readonly ref: string;
  readonly digest: string;
}

/**
 * Optional dispatch payload field locating a producer Capsule's encrypted
 * state in R2_STATE for a `remote_state` dependency (spec §15). The DO fetches
 * the ciphertext at the opaque `stateRef`, decrypts + verifies the recorded plaintext
 * `digest` (same StateArtifactCrypto path as its own state restore), and streams
 * the plaintext to the container which writes it READ-ONLY to
 * `/work/deps/<name>.tfstate` before init/plan/apply. The container never sees
 * the passphrase or the ciphertext. Mirrors the contract `DispatchDepState`;
 * kept local so the DO does not pull a contract import into the worker bundle.
 */
interface DepState {
  readonly name: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly generation: number;
  readonly stateRef: string;
  readonly digest: string;
}

interface RestoreState {
  readonly stateRef: string;
  readonly digest: string;
}

export interface ContainerRequestFetcher {
  containerFetch(request: Request, port?: number): Promise<Response>;
}

interface ContainerStartWaiter {
  startAndWaitForPorts(
    ports?: number | number[],
    cancellationOptions?: {
      readonly abort?: AbortSignal;
      readonly instanceGetTimeoutMS?: number;
      readonly portReadyTimeoutMS?: number;
      readonly waitInterval?: number;
    },
    startOptions?: {
      readonly envVars?: Record<string, string>;
      readonly entrypoint?: string[];
    },
  ): Promise<void>;
}

interface ContainerStopper {
  stop(): Promise<void> | void;
}

interface ContainerDestroyer {
  destroy(): Promise<void> | void;
}

export interface ContainerHostContext {
  readonly storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean | void>;
  };
}

class LocalContainerRuntime<Env = unknown> {
  defaultPort = 8080;
  sleepAfter = "10m";
  pingEndpoint = "healthz";
  envVars: Record<string, string> = {};

  readonly ctx: ContainerHostContext;
  readonly env: Env;

  constructor(ctx: ContainerHostContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  containerFetch(_request: Request, _port?: number): Promise<Response> {
    throw new Error(
      "Cloudflare Containers runtime is unavailable in this environment",
    );
  }
}

type ContainerRuntimeModule = {
  readonly Container?: typeof LocalContainerRuntime;
};

async function loadContainerRuntime(): Promise<typeof LocalContainerRuntime> {
  try {
    // The real `@cloudflare/containers` Container has a workerd-typed
    // constructor (`ctx: DurableObject`) that does not structurally overlap the
    // local stub's host-context shape, so route the cast through `unknown` (the
    // module is only consumed through the narrow `ContainerRuntimeModule` view).
    const runtime =
      (await import("@cloudflare/containers")) as unknown as ContainerRuntimeModule;
    return runtime.Container ?? LocalContainerRuntime;
  } catch {
    return LocalContainerRuntime;
  }
}

const OpenTofuRunnerContainerBase = await loadContainerRuntime();
const containerRuntimeAvailable =
  OpenTofuRunnerContainerBase !== LocalContainerRuntime;
const CONTAINER_START_TIMEOUT_MS = 30_000;
const CONTAINER_PORT_READY_TIMEOUT_MS = 30_000;
const CONTAINER_START_POLL_INTERVAL_MS = 250;
const CONTAINER_READY_ATTEMPTS = 3;
const CONTAINER_NOT_RUNNING_PATTERN =
  /container is not running|consider calling start/i;
const DEFAULT_RUNNER_KEEPALIVE_SECONDS = 0;
const RUNNER_MIN_ACTIVITY_GRACE_SECONDS = 30;
const MAX_RUNNER_KEEPALIVE_SECONDS = 900;
const RUNNER_STARTUP_SECONDS_HEADER = "x-takosumi-runner-startup-seconds";
const RUNNER_MUTATION_INDETERMINATE_HEADER =
  "x-takosumi-runner-mutation-indeterminate";
// This is a permanent authority slot, not a schema-versioned cache key. An
// unrecognized record at this key fails closed instead of letting a future
// record-format migration accidentally grant a second provider dispatch.
const RUNNER_MUTATION_AUTHORITY_STORAGE_KEY = "runner-mutation-authority";
const RUNNER_MUTATION_DISPATCH_STORAGE_PREFIX = "runner-mutation-dispatch@v2:";
const RUNNER_RELEASE_AUTHORITY_STORAGE_KEY = "runner-release-authority";
const RUNNER_RELEASE_DISPATCH_STORAGE_PREFIX = "runner-release-dispatch@v1:";

interface RunnerMutationDispatchRecord {
  readonly kind: "takosumi.runner-mutation-dispatch@v2";
  readonly action: RunnerMutationAction;
  /** SHA-256 over immutable inputs and stable credential authority claims. */
  readonly semanticDigest: string;
  /**
   * `preparing` is provably before provider dispatch; `orphaned` means a
   * target existed before this request had durable dispatch authority.
   */
  readonly phase: "preparing" | "dispatched" | "indeterminate" | "orphaned";
  /** Once dispatched, this durable claim permanently forbids redispatch. */
  readonly redispatchBlocked: true;
}

type RunnerMutationAuthorityClaim =
  | {
      readonly kind: "preparing";
      readonly record: RunnerMutationDispatchRecord;
    }
  | {
      readonly kind: "replay";
      readonly record: RunnerMutationDispatchRecord;
    }
  | { readonly kind: "blocked" };

interface RunnerReleaseCompletedOutcome {
  readonly status: "succeeded" | "failed";
  readonly exitCode: number;
  readonly commandCount: number;
  readonly failedCommandId?: string;
  /** Bounded, redacted stderr/stdout from a terminal failed release command. */
  readonly detail?: string;
}

interface RunnerReleaseDispatchRecord {
  readonly kind: "takosumi.runner-release-dispatch@v1";
  readonly releaseRunId: string;
  readonly applyRunId: string;
  /** Exact ordered lifecycle action set covered by this one-shot authority. */
  readonly actionIds: readonly string[];
  /** SHA-256 over immutable release inputs; request values are never stored. */
  readonly semanticDigest: string;
  readonly phase: "preparing" | "dispatched" | "completed" | "indeterminate";
  readonly redispatchBlocked: true;
  readonly outcome?: RunnerReleaseCompletedOutcome;
}

type RunnerReleaseAuthorityClaim =
  | {
      readonly kind: "preparing";
      readonly record: RunnerReleaseDispatchRecord;
    }
  | {
      readonly kind: "replay";
      readonly record: RunnerReleaseDispatchRecord;
    }
  | { readonly kind: "blocked" };

export class OpenTofuRunnerObject extends OpenTofuRunnerContainerBase<CloudflareWorkerEnv> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "30s";
  pingEndpoint = "localhost/healthz";
  entrypoint = ["/app/runner/start.sh"];

  #stateCryptoInstance: StateArtifactCrypto | undefined;
  #lastStartupSeconds: number | undefined;
  readonly #activeMutationPreparations = new Set<string>();
  readonly #activeReleasePreparations = new Set<string>();
  readonly #localRunnerProxyUrl: URL | undefined;
  readonly #artifactLimits: RunnerArtifactLimits;

  constructor(ctx: ContainerHostContext, env: CloudflareWorkerEnv) {
    super(ctx, env);
    this.#localRunnerProxyUrl = localOpenTofuRunnerProxyUrl(env);
    this.#artifactLimits = runnerArtifactLimits(env);
    if (env.LOCAL_SUBSTRATE_TEST_BED === "1") {
      console.log("OpenTofu runner local proxy composition", {
        configured: Boolean(this.#localRunnerProxyUrl),
      });
    }
    const keepaliveSeconds = runnerKeepaliveSeconds(env);
    this.sleepAfter = `${runnerActivityGraceSeconds(keepaliveSeconds)}s`;
    this.envVars = {
      PORT: "8080",
      TAKOSUMI_OPENTOFU_RUNNER: "cloudflare-container",
      TAKOSUMI_RUNNER_START_SERVER: "1",
      TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR:
        optionalStringEnv(env.TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR) ??
        "/tmp/takosumi-provider-cache",
      ...optionalEnvVars({
        TAKOSUMI_SOURCE_ARCHIVE_ZSTD_LEVEL:
          env.TAKOSUMI_SOURCE_ARCHIVE_ZSTD_LEVEL,
      }),
    };
  }

  override async containerFetch(
    request: Request,
    port?: number,
  ): Promise<Response> {
    if (this.#localRunnerProxyUrl) {
      return await proxyLocalOpenTofuRunnerRequest(
        request,
        this.#localRunnerProxyUrl,
      );
    }
    return await super.containerFetch(request, port);
  }

  onError(error: unknown): unknown {
    // Container errors can include request/provider diagnostics. The mutation
    // owner records only a safe type and never emits the raw message or stack.
    console.error("OpenTofu runner container failed", {
      errorName: safeRunnerErrorName(error),
    });
    throw error;
  }

  onStart(): void {
    console.log("OpenTofu runner container started", {
      defaultPort: this.defaultPort,
      requiredPorts: this.requiredPorts,
      pingEndpoint: this.pingEndpoint,
    });
  }

  onStop(params: { readonly exitCode: number; readonly reason: string }): void {
    console.error("OpenTofu runner container stopped", {
      exitCode: params.exitCode,
    });
  }

  async onActivityExpired(): Promise<void> {
    console.log("OpenTofu runner container activity expired; shutting down");
    await this.#shutdownContainerIfSupported();
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#containerRuntimeUnavailable()) {
      return Response.json(
        {
          error: "OpenTofu runner container runtime is unavailable",
          detail:
            "Cloudflare Containers runtime is unavailable in this environment",
        },
        { status: 501 },
      );
    }
    const runDispatch = isRunDispatchRequest(request);
    let mutationIndeterminate = false;
    try {
      this.#lastStartupSeconds = undefined;
      const response = await this.#fetchWithDurablePlanArtifacts(request);
      mutationIndeterminate =
        response.headers.get(RUNNER_MUTATION_INDETERMINATE_HEADER) === "1";
      const output = runDispatch
        ? await bufferedResponse(response, this.#artifactLimits.runnerResponse)
        : response;
      return withRunnerStartupHeader(output, this.#lastStartupSeconds);
    } catch (error) {
      console.error("OpenTofu runner artifact relay failed", {
        operation: runnerRelayOperation(request),
        reason: safeRunnerFailureReason(error),
        errorName: safeRunnerErrorName(error),
      });
      if (error instanceof RunnerArtifactSizeLimitError) {
        return Response.json(
          {
            error: "OpenTofu runner artifact exceeds configured byte limit",
            errorCode: error.code,
            status: "failed",
            phase: runnerRelayOperation(request),
            artifact: error.artifact,
            maxBytes: error.maxBytes,
            observedBytes: error.observedBytes,
          },
          { status: 413 },
        );
      }
      if (error instanceof RunnerArtifactRelayInfrastructureError) {
        return Response.json(
          {
            error:
              "OpenTofu runner artifact durability acknowledgement is ambiguous",
            errorCode: error.code,
            status: "failed",
            phase: runnerRelayOperation(request),
            retryable: true,
            detail:
              "redeliver the same ApplyRun; its immutable target will be adopted if the write committed",
          },
          { status: 503 },
        );
      }
      return Response.json(
        {
          error: "OpenTofu runner artifact relay failed",
          errorCode: RUNNER_ARTIFACT_RELAY_FAILED_CODE,
          status: "failed",
          phase: runnerRelayOperation(request),
          reason: safeRunnerFailureReason(error),
          detail: "runner artifact relay failed",
        },
        { status: 500 },
      );
    } finally {
      if (runDispatch && !mutationIndeterminate) {
        await this.#shutdownContainerIfSupported();
      }
      this.#lastStartupSeconds = undefined;
    }
  }

  #containerRuntimeUnavailable(): boolean {
    const fetcher = (this as unknown as Partial<ContainerRequestFetcher>)
      .containerFetch;
    if (typeof fetcher !== "function") return true;
    if (containerRuntimeAvailable) return false;
    return fetcher === LocalContainerRuntime.prototype.containerFetch;
  }

  async #containerFetch(request: Request): Promise<Response> {
    return await (this as unknown as ContainerRequestFetcher).containerFetch(
      request,
      this.defaultPort,
    );
  }

  async #startContainerIfSupported(): Promise<void> {
    if (this.#localRunnerProxyUrl) return;
    const startAndWaitForPorts = (
      this as unknown as Partial<ContainerStartWaiter>
    ).startAndWaitForPorts;
    if (typeof startAndWaitForPorts !== "function") return;
    console.log("OpenTofu runner container start requested", {
      ports: [this.defaultPort],
      entrypoint: this.entrypoint,
      envNames: Object.keys(this.envVars).sort(),
    });
    await startAndWaitForPorts.call(
      this,
      [this.defaultPort],
      {
        instanceGetTimeoutMS: CONTAINER_START_TIMEOUT_MS,
        portReadyTimeoutMS: CONTAINER_PORT_READY_TIMEOUT_MS,
        waitInterval: CONTAINER_START_POLL_INTERVAL_MS,
      },
      {
        envVars: this.envVars,
        entrypoint: this.entrypoint,
      },
    );
  }

  async #shutdownContainerIfSupported(): Promise<void> {
    if (this.#localRunnerProxyUrl) return;
    const destroy = (this as unknown as Partial<ContainerDestroyer>).destroy;
    if (typeof destroy === "function") {
      try {
        await destroy.call(this);
        console.log("OpenTofu runner container destroy requested");
        return;
      } catch (error) {
        console.error("OpenTofu runner container destroy failed", {
          errorName: safeRunnerErrorName(error),
        });
      }
    }
    const stop = (this as unknown as Partial<ContainerStopper>).stop;
    if (typeof stop !== "function") return;
    try {
      await stop.call(this);
      console.log("OpenTofu runner container stop requested");
    } catch (error) {
      console.error("OpenTofu runner container stop failed", {
        errorName: safeRunnerErrorName(error),
      });
    }
  }

  async #ensureContainerReady(baseUrl: URL): Promise<void> {
    const startedAt = monotonicNow();
    let lastError: unknown;
    for (let attempt = 1; attempt <= CONTAINER_READY_ATTEMPTS; attempt += 1) {
      try {
        await this.#startContainerIfSupported();
        const response = await this.#containerFetch(
          new Request(containerHealthUrl(baseUrl), { method: "GET" }),
        );
        if (!response.ok) {
          const failure = await readRunnerFailureDetail(
            response,
            this.#artifactLimits.failureDetail,
          );
          throw new Error(
            `container health check failed: ${response.status}${failure ? ` (${failure})` : ""}`,
          );
        }
        this.#lastStartupSeconds ??=
          Math.max(0, monotonicNow() - startedAt) / 1000;
        return;
      } catch (error) {
        lastError = error;
        if (
          attempt >= CONTAINER_READY_ATTEMPTS ||
          !isContainerNotRunningError(error)
        ) {
          throw error;
        }
        console.warn(
          "OpenTofu runner container was not running after start; retrying",
          { attempt },
        );
        await sleep(CONTAINER_START_POLL_INTERVAL_MS * attempt);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("container readiness failed");
  }

  async #containerFetchAfterReady(
    requestFactory: () => Request,
    baseUrl: URL,
  ): Promise<Response> {
    try {
      return await this.#containerFetch(requestFactory());
    } catch (error) {
      if (!isContainerNotRunningError(error)) throw error;
      console.warn(
        "OpenTofu runner container stopped before dispatch; restarting",
      );
      await this.#ensureContainerReady(baseUrl);
      return await this.#containerFetch(requestFactory());
    }
  }

  async #claimMutationPreparation(
    runId: string,
    action: RunnerMutationAction,
    requestPayload: unknown,
  ): Promise<RunnerMutationAuthorityClaim> {
    let semanticDigest: string;
    try {
      semanticDigest = await runnerMutationSemanticDigest(
        runId,
        action,
        requestPayload,
        this.env,
      );
    } catch (error) {
      // Credential expiry/signature/context failures and malformed semantic
      // inputs are request rejection, not infrastructure retry authority. Do
      // not let their potentially secret-bearing detail reach the outer log.
      console.error("OpenTofu runner mutation authority rejected", {
        action,
        errorName: safeRunnerErrorName(error),
        redispatchBlocked: true,
      });
      return { kind: "blocked" };
    }
    // A Durable Object has one live isolate for this ID, so acquiring this
    // in-isolate owner before the first storage await closes concurrent claim
    // races. Durable storage below, not this Set, is the restart authority.
    if (this.#activeMutationPreparations.size > 0) {
      return { kind: "blocked" };
    }
    this.#activeMutationPreparations.add(semanticDigest);
    try {
      const existing = await this.ctx.storage.get<unknown>(
        RUNNER_MUTATION_AUTHORITY_STORAGE_KEY,
      );
      if (existing !== undefined) {
        const existingRecord = parseRunnerMutationDispatchRecord(existing);
        if (
          !existingRecord ||
          existingRecord.action !== action ||
          existingRecord.semanticDigest !== semanticDigest
        ) {
          this.#activeMutationPreparations.delete(semanticDigest);
          return { kind: "blocked" };
        }
        if (existingRecord.phase === "orphaned") {
          this.#activeMutationPreparations.delete(semanticDigest);
          return { kind: "blocked" };
        }
        if (existingRecord.phase !== "preparing") {
          this.#activeMutationPreparations.delete(semanticDigest);
          return { kind: "replay", record: existingRecord };
        }
        // A persisted `preparing` phase proves no provider dispatch authority
        // was granted. Resume it only after isolate recreation (the in-memory
        // owner is absent); the durable phase carries restart safety.
        return { kind: "preparing", record: existingRecord };
      }

      const record: RunnerMutationDispatchRecord = {
        kind: "takosumi.runner-mutation-dispatch@v2",
        action,
        semanticDigest,
        phase: "preparing",
        redispatchBlocked: true,
      };
      await this.#writeMutationDispatchRecord(record);
      return { kind: "preparing", record };
    } catch (error) {
      this.#activeMutationPreparations.delete(semanticDigest);
      throw error;
    }
  }

  async #blockPreparedMutationWithExistingTarget(
    preparation: RunnerMutationDispatchRecord,
  ): Promise<Response> {
    try {
      // The target predates any recorded provider dispatch for these
      // semantics. Persist a distinct terminal phase so neither target removal
      // nor a later exact replay can turn it into provider/adoption authority.
      await this.#writeMutationDispatchRecord({
        ...preparation,
        phase: "orphaned",
      });
    } finally {
      this.#activeMutationPreparations.delete(preparation.semanticDigest);
    }
    return runnerMutationIndeterminateResponse(preparation.action);
  }

  async #markMutationDispatched(
    preparation: RunnerMutationDispatchRecord,
  ): Promise<RunnerMutationDispatchRecord | undefined> {
    const current = parseRunnerMutationDispatchRecord(
      await this.ctx.storage.get<unknown>(
        RUNNER_MUTATION_AUTHORITY_STORAGE_KEY,
      ),
    );
    if (
      !current ||
      current.phase !== "preparing" ||
      current.action !== preparation.action ||
      current.semanticDigest !== preparation.semanticDigest
    ) {
      this.#activeMutationPreparations.delete(preparation.semanticDigest);
      return undefined;
    }
    const dispatched: RunnerMutationDispatchRecord = {
      ...current,
      phase: "dispatched",
    };
    await this.#writeMutationDispatchRecord(dispatched);
    this.#activeMutationPreparations.delete(preparation.semanticDigest);
    return dispatched;
  }

  async #releaseMutationPreparation(
    preparation: RunnerMutationDispatchRecord,
  ): Promise<void> {
    try {
      const current = parseRunnerMutationDispatchRecord(
        await this.ctx.storage.get<unknown>(
          RUNNER_MUTATION_AUTHORITY_STORAGE_KEY,
        ),
      );
      if (
        !current ||
        current.phase !== "preparing" ||
        current.action !== preparation.action ||
        current.semanticDigest !== preparation.semanticDigest
      ) {
        return;
      }
      // No provider dispatch was authorized, so both preparation records can
      // be removed and the exact request may safely retry. Issue both deletes
      // without an intervening await to keep the storage update atomic.
      const authorityDelete = this.ctx.storage.delete(
        RUNNER_MUTATION_AUTHORITY_STORAGE_KEY,
      );
      const evidenceDelete = this.ctx.storage.delete(
        `${RUNNER_MUTATION_DISPATCH_STORAGE_PREFIX}${preparation.semanticDigest}`,
      );
      await Promise.all([authorityDelete, evidenceDelete]);
    } finally {
      this.#activeMutationPreparations.delete(preparation.semanticDigest);
    }
  }

  async #writeMutationDispatchRecord(
    record: RunnerMutationDispatchRecord,
  ): Promise<void> {
    // Both puts are issued without an intervening await so Durable Object
    // storage coalesces them atomically. The fixed authority key fences request
    // digest drift; the digest-keyed entry is the exact durable evidence.
    const authorityWrite = this.ctx.storage.put(
      RUNNER_MUTATION_AUTHORITY_STORAGE_KEY,
      record,
    );
    const evidenceWrite = this.ctx.storage.put(
      `${RUNNER_MUTATION_DISPATCH_STORAGE_PREFIX}${record.semanticDigest}`,
      record,
    );
    await Promise.all([authorityWrite, evidenceWrite]);
  }

  async #dispatchMutationOnce(
    request: Request,
    record: RunnerMutationDispatchRecord,
  ): Promise<Response> {
    try {
      return await this.#containerFetch(request);
    } catch (error) {
      return await this.#recordMutationIndeterminate(record, error);
    }
  }

  async #recordMutationIndeterminate(
    record: RunnerMutationDispatchRecord,
    error: unknown,
  ): Promise<Response> {
    // Once containerFetch has been invoked, no transport exception proves that
    // provider execution did not happen. Never inspect or log its message: it
    // may contain materialized provider credentials.
    console.error("OpenTofu runner mutation outcome is indeterminate", {
      action: record.action,
      errorName: safeRunnerErrorName(error),
      redispatchBlocked: true,
    });
    try {
      await this.#writeMutationDispatchRecord({
        ...record,
        phase: "indeterminate",
      });
    } catch (storageError) {
      // The already-durable `dispatched` phase still blocks replay if this
      // evidence refinement is unavailable. Never log storage diagnostics.
      console.error(
        "OpenTofu runner mutation indeterminate evidence update failed",
        {
          action: record.action,
          errorName: safeRunnerErrorName(storageError),
          redispatchBlocked: true,
        },
      );
    }
    return runnerMutationIndeterminateResponse(record.action);
  }

  async #claimReleasePreparation(
    releaseRunId: string,
    requestPayload: unknown,
  ): Promise<RunnerReleaseAuthorityClaim> {
    let identity: {
      readonly applyRunId: string;
      readonly actionIds: readonly string[];
      readonly semanticDigest: string;
    };
    try {
      identity = await runnerReleaseSemanticIdentity(
        releaseRunId,
        requestPayload,
        this.env,
      );
    } catch (error) {
      console.error("OpenTofu runner release authority rejected", {
        action: "release",
        errorName: safeRunnerErrorName(error),
        redispatchBlocked: true,
      });
      return { kind: "blocked" };
    }
    if (this.#activeReleasePreparations.size > 0) {
      return { kind: "blocked" };
    }
    this.#activeReleasePreparations.add(identity.semanticDigest);
    try {
      const existing = await this.ctx.storage.get<unknown>(
        RUNNER_RELEASE_AUTHORITY_STORAGE_KEY,
      );
      if (existing !== undefined) {
        const record = parseRunnerReleaseDispatchRecord(existing);
        if (
          !record ||
          record.releaseRunId !== releaseRunId ||
          record.applyRunId !== identity.applyRunId ||
          !sameOrderedStrings(record.actionIds, identity.actionIds) ||
          record.semanticDigest !== identity.semanticDigest
        ) {
          this.#activeReleasePreparations.delete(identity.semanticDigest);
          return { kind: "blocked" };
        }
        if (record.phase !== "preparing") {
          this.#activeReleasePreparations.delete(identity.semanticDigest);
          return { kind: "replay", record };
        }
        return { kind: "preparing", record };
      }

      const record: RunnerReleaseDispatchRecord = {
        kind: "takosumi.runner-release-dispatch@v1",
        releaseRunId,
        applyRunId: identity.applyRunId,
        actionIds: identity.actionIds,
        semanticDigest: identity.semanticDigest,
        phase: "preparing",
        redispatchBlocked: true,
      };
      await this.#writeReleaseDispatchRecord(record);
      return { kind: "preparing", record };
    } catch (error) {
      this.#activeReleasePreparations.delete(identity.semanticDigest);
      throw error;
    }
  }

  async #markReleaseDispatched(
    preparation: RunnerReleaseDispatchRecord,
  ): Promise<RunnerReleaseDispatchRecord | undefined> {
    const current = parseRunnerReleaseDispatchRecord(
      await this.ctx.storage.get<unknown>(
        RUNNER_RELEASE_AUTHORITY_STORAGE_KEY,
      ),
    );
    if (
      !current ||
      current.phase !== "preparing" ||
      !sameReleaseDispatchIdentity(current, preparation)
    ) {
      this.#activeReleasePreparations.delete(preparation.semanticDigest);
      return undefined;
    }
    const dispatched: RunnerReleaseDispatchRecord = {
      ...current,
      phase: "dispatched",
    };
    await this.#writeReleaseDispatchRecord(dispatched);
    this.#activeReleasePreparations.delete(preparation.semanticDigest);
    return dispatched;
  }

  async #releaseReleasePreparation(
    preparation: RunnerReleaseDispatchRecord,
  ): Promise<void> {
    try {
      const current = parseRunnerReleaseDispatchRecord(
        await this.ctx.storage.get<unknown>(
          RUNNER_RELEASE_AUTHORITY_STORAGE_KEY,
        ),
      );
      if (
        !current ||
        current.phase !== "preparing" ||
        !sameReleaseDispatchIdentity(current, preparation)
      ) {
        return;
      }
      const authorityDelete = this.ctx.storage.delete(
        RUNNER_RELEASE_AUTHORITY_STORAGE_KEY,
      );
      const evidenceDelete = this.ctx.storage.delete(
        `${RUNNER_RELEASE_DISPATCH_STORAGE_PREFIX}${preparation.semanticDigest}`,
      );
      await Promise.all([authorityDelete, evidenceDelete]);
    } finally {
      this.#activeReleasePreparations.delete(preparation.semanticDigest);
    }
  }

  async #writeReleaseDispatchRecord(
    record: RunnerReleaseDispatchRecord,
  ): Promise<void> {
    const authorityWrite = this.ctx.storage.put(
      RUNNER_RELEASE_AUTHORITY_STORAGE_KEY,
      record,
    );
    const evidenceWrite = this.ctx.storage.put(
      `${RUNNER_RELEASE_DISPATCH_STORAGE_PREFIX}${record.semanticDigest}`,
      record,
    );
    await Promise.all([authorityWrite, evidenceWrite]);
  }

  async #dispatchReleaseOnce(
    request: Request,
    record: RunnerReleaseDispatchRecord,
  ): Promise<Response> {
    try {
      return await this.#containerFetch(request);
    } catch (error) {
      return await this.#recordReleaseIndeterminate(record, error);
    }
  }

  async #completeReleaseDispatch(
    record: RunnerReleaseDispatchRecord,
    outcome: RunnerReleaseCompletedOutcome,
  ): Promise<Response | true | undefined> {
    try {
      const current = parseRunnerReleaseDispatchRecord(
        await this.ctx.storage.get<unknown>(
          RUNNER_RELEASE_AUTHORITY_STORAGE_KEY,
        ),
      );
      if (
        !current ||
        current.phase !== "dispatched" ||
        !sameReleaseDispatchIdentity(current, record)
      ) {
        return undefined;
      }
      await this.#writeReleaseDispatchRecord({
        ...current,
        phase: "completed",
        outcome,
      });
      return true;
    } catch (error) {
      return await this.#recordReleaseIndeterminate(record, error);
    }
  }

  async #recordReleaseIndeterminate(
    record: RunnerReleaseDispatchRecord,
    error: unknown,
  ): Promise<Response> {
    console.error("OpenTofu runner release outcome is indeterminate", {
      action: "release",
      errorName: safeRunnerErrorName(error),
      redispatchBlocked: true,
    });
    try {
      const current = parseRunnerReleaseDispatchRecord(
        await this.ctx.storage.get<unknown>(
          RUNNER_RELEASE_AUTHORITY_STORAGE_KEY,
        ),
      );
      if (current && sameReleaseDispatchIdentity(current, record)) {
        if (current.phase === "completed" && current.outcome) {
          return runnerCompletedReleaseResponse(current);
        }
        if (current.phase === "dispatched") {
          await this.#writeReleaseDispatchRecord({
            ...current,
            phase: "indeterminate",
          });
        }
      }
    } catch (storageError) {
      console.error(
        "OpenTofu runner release indeterminate evidence update failed",
        {
          action: "release",
          errorName: safeRunnerErrorName(storageError),
          redispatchBlocked: true,
        },
      );
    }
    return runnerReleaseIndeterminateResponse();
  }

  async #fetchWithDurablePlanArtifacts(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/runs\/([^/]+)$/.exec(url.pathname);
    if (!match || request.method !== "POST") {
      return await this.#containerFetch(request);
    }
    const runId = decodeURIComponent(match[1]!);
    const bodyText = await request.text();
    const envelope = parseRunEnvelope(bodyText);
    // Source-sync runs (LANE M1) never touch OpenTofu state; they run, leave the
    // archive on the container, and the DO pulls + persists it to R2_SOURCE.
    if (isSourceSyncEnvelope(envelope)) {
      await this.#ensureContainerReady(url);
      return await this.#fetchWithSourceArchive(runId, request, bodyText);
    }
    if (envelope.action === "restore") {
      const stateScope = parseStateScope(envelope.request);
      const restoreState = parseRestoreState(envelope.request);
      if (!stateScope || !restoreState) {
        throw new Error("restore requires stateScope and restoreState");
      }
      return await this.#restoreStateGeneration(
        runId,
        stateScope,
        restoreState,
      );
    }
    // M2: when the dispatch carries an environment-scoped state location, route
    // state through R2_STATE (encrypted at rest, spec keys); otherwise fall back
    // to the legacy R2_ARTIFACTS state path so older jobs/tests keep working.
    const stateScope = parseStateScope(envelope.request);
    const rawOutputRef = parseRawOutputRef(envelope.request);
    const stateAdoption = parseStateAdoption(envelope.request);
    const applyRunId = parseApplyRunId(envelope.request);
    if (stateAdoption && !stateScope) {
      throw new Error("stateAdoption requires a Resource stateScope");
    }
    const sourceArchive = parseSourceArchiveRestore(envelope.request);
    const depStates = parseDepStates(envelope.request);
    const stateKeys = stateScope
      ? []
      : await stateArtifactKeys(envelope.request);
    if (isRunnerMutationAction(envelope.action) && stateScope) {
      if (envelope.action === "apply" && !rawOutputRef) {
        throw new Error("apply with stateScope requires rawOutputRef");
      }
      if (!applyRunId) {
        throw new Error(
          `${envelope.action} with stateScope requires the canonical applyRun.id`,
        );
      }
      if (rawOutputRef) {
        assertRawOutputRefForScope(stateScope, applyRunId, rawOutputRef);
      }
    }
    const dispatchRequest = () =>
      new Request(request.url, {
        method: request.method,
        headers: runnerRequestHeaders(request),
        body: bodyText,
        signal: request.signal,
      });
    let mutationPreparation: RunnerMutationDispatchRecord | undefined;
    let mutationDispatch: RunnerMutationDispatchRecord | undefined;
    let mutationRequest: Request | undefined;
    let releasePreparation: RunnerReleaseDispatchRecord | undefined;
    let releaseDispatch: RunnerReleaseDispatchRecord | undefined;
    let releaseRequest: Request | undefined;
    if (isRunnerMutationAction(envelope.action)) {
      const claim = await this.#claimMutationPreparation(
        runId,
        envelope.action,
        envelope.request,
      );
      if (claim.kind === "blocked") {
        return runnerMutationIndeterminateResponse(envelope.action);
      }
      if (claim.kind === "replay") {
        // A completed state/output target is only adoptable after the current
        // credential has been freshly verified and the exact stable semantic
        // digest matches the durable dispatch authority.
        const adopted =
          stateScope && applyRunId
            ? await this.#adoptCompletedStateMutationFromR2(
                applyRunId,
                stateScope,
                envelope.action,
                rawOutputRef,
              )
            : undefined;
        return adopted ?? runnerMutationIndeterminateResponse(envelope.action);
      }
      mutationPreparation = claim.record;
      if (stateScope && (await this.#r2State().head(stateScope.stateRef))) {
        // A target without a matching dispatched authority may be a legacy or
        // out-of-band mutation. It cannot authorize adoption or provider I/O.
        return await this.#blockPreparedMutationWithExistingTarget(
          mutationPreparation,
        );
      }
    }
    if (envelope.action === "release") {
      const claim = await this.#claimReleasePreparation(
        runId,
        envelope.request,
      );
      if (claim.kind === "blocked") {
        return runnerReleaseIndeterminateResponse();
      }
      if (claim.kind === "replay") {
        return claim.record.phase === "completed" && claim.record.outcome
          ? runnerCompletedReleaseResponse(claim.record)
          : runnerReleaseIndeterminateResponse();
      }
      releasePreparation = claim.record;
    }
    try {
      // M2: restore the snapshotted source tree into the container before any
      // build/plan phase (mirrors the plan-artifact restore protocol).
      if (sourceArchive) {
        await this.#restoreSourceArchive(runId, sourceArchive, url);
      }
      // remote_state dependencies (spec §15): fetch + decrypt each producer
      // state and stream it to the container BEFORE init/plan/apply.
      if (depStates.length > 0) {
        await this.#restoreDepStates(runId, depStates, url);
      }
      if (envelope.action === "apply" || envelope.action === "destroy") {
        await this.#restorePlanArtifact(runId, envelope.request, url);
      }
      if (stateScope) {
        await this.#restoreStateFromR2State(
          runId,
          stateScope,
          url,
          envelope.action,
          stateAdoption,
        );
      } else if (stateKeys.length > 0) {
        await this.#restoreStateArtifact(runId, stateKeys, url);
      }
      await this.#ensureContainerReady(url);
      if (mutationPreparation) {
        // Construct and preflight before advancing the durable phase. An
        // already-aborted request is a provable pre-dispatch failure.
        mutationRequest = dispatchRequest();
        if (mutationRequest.signal.aborted) {
          throw mutationRequest.signal.reason instanceof Error
            ? mutationRequest.signal.reason
            : new DOMException(
                "OpenTofu runner mutation was aborted before dispatch",
                "AbortError",
              );
        }
        mutationDispatch =
          await this.#markMutationDispatched(mutationPreparation);
        if (!mutationDispatch) {
          return runnerMutationIndeterminateResponse(
            mutationPreparation.action,
          );
        }
      }
      if (releasePreparation) {
        releaseRequest = dispatchRequest();
        if (releaseRequest.signal.aborted) {
          throw releaseRequest.signal.reason instanceof Error
            ? releaseRequest.signal.reason
            : new DOMException(
                "OpenTofu runner release was aborted before dispatch",
                "AbortError",
              );
        }
        releaseDispatch =
          await this.#markReleaseDispatched(releasePreparation);
        if (!releaseDispatch) {
          return runnerReleaseIndeterminateResponse();
        }
      }
    } catch (error) {
      if (mutationPreparation && !mutationDispatch) {
        await this.#releaseMutationPreparation(mutationPreparation);
      }
      if (releasePreparation && !releaseDispatch) {
        await this.#releaseReleasePreparation(releasePreparation);
      }
      throw error;
    }

    let unboundedRunnerResponse: Response;
    if (mutationDispatch && mutationRequest) {
      unboundedRunnerResponse = await this.#dispatchMutationOnce(
        mutationRequest,
        mutationDispatch,
      );
    } else if (releaseDispatch && releaseRequest) {
      unboundedRunnerResponse = await this.#dispatchReleaseOnce(
        releaseRequest,
        releaseDispatch,
      );
    } else {
      unboundedRunnerResponse = await this.#containerFetchAfterReady(
        dispatchRequest,
        url,
      );
    }
    // Bound every container result before any state/plan persistence. This also
    // covers legacy state paths that do not otherwise parse the JSON payload.
    let runnerResponse: Response;
    try {
      runnerResponse = await bufferedResponse(
        unboundedRunnerResponse,
        this.#artifactLimits.runnerResponse,
      );
    } catch (error) {
      if (releaseDispatch) {
        return await this.#recordReleaseIndeterminate(releaseDispatch, error);
      }
      if (
        mutationDispatch &&
        !(error instanceof RunnerArtifactSizeLimitError)
      ) {
        return await this.#recordMutationIndeterminate(mutationDispatch, error);
      }
      throw error;
    }
    if (
      releaseDispatch &&
      runnerResponse.headers.get(RUNNER_MUTATION_INDETERMINATE_HEADER) === "1"
    ) {
      return runnerResponse;
    }
    if (releaseDispatch) {
      let outcome: RunnerReleaseCompletedOutcome;
      try {
        outcome = releaseCompletedOutcome(
          await readJsonObject(
            runnerResponse.clone(),
            this.#artifactLimits.runnerResponse,
          ),
          releaseDispatch,
        );
      } catch (error) {
        return await this.#recordReleaseIndeterminate(releaseDispatch, error);
      }
      const completion = await this.#completeReleaseDispatch(
        releaseDispatch,
        outcome,
      );
      if (completion instanceof Response) return completion;
      if (completion !== true) {
        return await this.#recordReleaseIndeterminate(
          releaseDispatch,
          new Error("release completion authority changed before commit"),
        );
      }
    }
    const providerExecutionFailed =
      (envelope.action === "apply" || envelope.action === "destroy") &&
      !runnerResponse.ok &&
      runnerProviderExecutionFailed(
        await readJsonObject(
          runnerResponse.clone(),
          this.#artifactLimits.runnerResponse,
        ),
      );
    if (
      (envelope.action === "apply" || envelope.action === "destroy") &&
      (runnerResponse.ok || providerExecutionFailed)
    ) {
      if (stateScope) {
        return await this.#persistStateToR2State(
          runId,
          applyRunId!,
          stateScope,
          url,
          runnerResponse,
          envelope.action,
          rawOutputRef,
          providerExecutionFailed,
          mutationDispatch!,
        );
      }
      if (runnerResponse.ok && stateKeys.length > 0) {
        const indeterminate = await this.#persistStateArtifact(
          runId,
          stateKeys,
          url,
          mutationDispatch!,
        );
        if (indeterminate) return indeterminate;
      }
    }
    if (envelope.action !== "plan" || !runnerResponse.ok) {
      if (!runnerResponse.ok) {
        return await normalizeRunnerFailureResponse(
          runnerResponse,
          envelope.action,
          this.#artifactLimits.runnerResponse,
          releaseDispatch?.actionIds,
        );
      }
      return runnerResponse;
    }
    return await this.#persistPlanArtifact(
      runId,
      runnerResponse,
      url,
      stateScope,
    );
  }

  #stateCrypto(): StateArtifactCrypto {
    this.#stateCryptoInstance ??= StateArtifactCrypto.fromEnv(
      this.env as unknown as Record<string, string | undefined>,
    );
    return this.#stateCryptoInstance;
  }

  #r2State(): NonNullable<CloudflareWorkerEnv["R2_STATE"]> {
    const bucket = this.env.R2_STATE;
    if (!bucket) {
      throw new Error("R2_STATE binding is not configured for state objects");
    }
    return bucket;
  }

  // Source-sync relay: dispatch the run to the container, then on success pull
  // the deterministic source archive and persist it to R2_SOURCE under the
  // host-allocated archiveRef the runner echoes back. Mirrors the tfplan pull-then-persist
  // protocol but writes to the dedicated source bucket and never touches state.
  async #fetchWithSourceArchive(
    runId: string,
    request: Request,
    bodyText: string,
  ): Promise<Response> {
    const url = new URL(request.url);
    const envelope = parseRunEnvelope(bodyText);
    const requestedArchiveRef = sourceSyncArchiveRef(envelope.request);
    const reuseSnapshot = parseReusableSourceSnapshot(envelope.request);
    const runnerResponse = await this.#containerFetchAfterReady(
      () =>
        new Request(request.url, {
          method: request.method,
          headers: runnerRequestHeaders(request),
          body: bodyText,
          signal: request.signal,
        }),
      url,
    );
    if (!runnerResponse.ok) {
      return await normalizeRunnerFailureResponse(
        runnerResponse,
        envelope.action,
        this.#artifactLimits.runnerResponse,
      );
    }
    const payload = await readJsonObject(
      runnerResponse,
      this.#artifactLimits.runnerResponse,
    );
    const archive = recordField(payload, "sourceArchive");
    if (archive && stringField(archive, "kind") === "object-storage") {
      await this.#verifyReusedSourceArchive(payload, archive, reuseSnapshot);
      return jsonResponse(payload, runnerResponse.status);
    }
    if (!archive || stringField(archive, "kind") !== "runner-local") {
      return jsonResponse(payload, runnerResponse.status);
    }
    const archiveRef = requiredStringField(archive, "ref");
    assertSafeSourceArchiveKey(archiveRef);
    if (archiveRef !== requestedArchiveRef) {
      throw new Error("source archive ref does not match request");
    }
    const bucket = this.env.R2_SOURCE;
    if (!bucket) {
      throw new Error(
        "R2_SOURCE binding is not configured for source archives",
      );
    }
    const archiveResponse = await this.#containerFetch(
      new Request(sourceArchiveUrl(url, runId), { method: "GET" }),
    );
    if (!archiveResponse.ok) {
      throw new Error(
        `container source archive fetch failed: ${archiveResponse.status}`,
      );
    }
    const bytes = await readBoundedResponseBytes(
      archiveResponse,
      "source_archive",
      this.#artifactLimits.sourceArchive,
    );
    const digest = await digestBytes(bytes);
    const expectedDigest = stringField(archive, "digest");
    if (expectedDigest && expectedDigest !== digest) {
      throw new Error(`source archive digest mismatch: ${digest}`);
    }
    const stored = await putR2ObjectWithRetry(
      bucket,
      archiveRef,
      bytes,
      {
        httpMetadata: { contentType: SOURCE_ARCHIVE_CONTENT_TYPE },
        customMetadata: {
          "takosumi-run-id": runId,
          "takosumi-digest": digest,
        },
      },
      "source archive",
    );
    return jsonResponse(
      {
        ...payload,
        sourceArchive: {
          kind: "object-storage",
          ref: archiveRef,
          digest,
          contentType: SOURCE_ARCHIVE_CONTENT_TYPE,
          sizeBytes: stored.size,
          createdAt: Date.now(),
        },
      },
      runnerResponse.status,
    );
  }

  async #verifyReusedSourceArchive(
    payload: Record<string, unknown>,
    archive: Record<string, unknown>,
    reuseSnapshot: ReusableSourceSnapshot | undefined,
  ): Promise<void> {
    if (!reuseSnapshot) {
      throw new Error("source archive reuse requires reuseSnapshot");
    }
    const archiveRef = requiredStringField(archive, "ref");
    assertSafeSourceArchiveKey(archiveRef);
    const digest = requiredStringField(archive, "digest");
    const sizeBytes = positiveIntegerField(archive, "sizeBytes");
    assertArtifactSize(
      "source_archive",
      this.#artifactLimits.sourceArchive,
      sizeBytes,
    );
    const reusedFromSnapshotId = requiredStringField(
      archive,
      "reusedFromSnapshotId",
    );
    if (
      reusedFromSnapshotId !== reuseSnapshot.id ||
      archiveRef !== reuseSnapshot.archiveRef ||
      digest !== reuseSnapshot.archiveDigest ||
      sizeBytes !== reuseSnapshot.archiveSizeBytes ||
      stringField(payload, "archiveDigest") !== reuseSnapshot.archiveDigest ||
      positiveIntegerField(payload, "archiveSizeBytes") !==
        reuseSnapshot.archiveSizeBytes
    ) {
      throw new Error("source archive reuse does not match reuseSnapshot");
    }
    const bucket = this.env.R2_SOURCE;
    if (!bucket) {
      throw new Error(
        "R2_SOURCE binding is not configured for source archives",
      );
    }
    const object = await bucket.get(archiveRef);
    if (!object) {
      throw new Error(`source archive object not found: ${archiveRef}`);
    }
    if (object.size !== reuseSnapshot.archiveSizeBytes) {
      throw new Error("source archive reuse size mismatch");
    }
    const bytes = await readBoundedR2ObjectBytes(
      object,
      "source_archive",
      this.#artifactLimits.sourceArchive,
    );
    const actualDigest = await digestBytes(bytes);
    if (actualDigest !== reuseSnapshot.archiveDigest) {
      throw new Error(`source archive reuse digest mismatch: ${actualDigest}`);
    }
  }

  // M2: fetch the snapshotted source archive from R2_SOURCE, verify its digest,
  // and stream it to the container's source-archive restore route. The container
  // extracts it into /work/source as the source tree (the archive already holds
  // the snapshot subtree). Mirrors the plan-artifact restore PUT protocol.
  async #restoreSourceArchive(
    runId: string,
    sourceArchive: SourceArchiveRestore,
    baseUrl: URL,
  ): Promise<void> {
    assertSafeSourceArchiveRestoreKey(sourceArchive.ref);
    const bucket = this.env.R2_SOURCE;
    if (!bucket) {
      throw new Error(
        "R2_SOURCE binding is not configured for source archives",
      );
    }
    const object = await bucket.get(sourceArchive.ref);
    if (!object) {
      throw new Error(`source archive object not found: ${sourceArchive.ref}`);
    }
    const bytes = await readBoundedR2ObjectBytes(
      object,
      "source_archive",
      this.#artifactLimits.sourceArchive,
    );
    const digest = await digestBytes(bytes);
    if (digest !== sourceArchive.digest) {
      throw new Error(`source archive digest mismatch on restore: ${digest}`);
    }
    await this.#ensureContainerReady(baseUrl);
    const response = await this.#containerFetch(
      new Request(sourceArchiveRestoreUrl(baseUrl, runId), {
        method: "PUT",
        headers: { "content-type": SOURCE_ARCHIVE_CONTENT_TYPE },
        body: toArrayBuffer(bytes),
      }),
    );
    if (!response.ok) {
      const failure = await readRunnerFailureDetail(
        response,
        this.#artifactLimits.failureDetail,
      );
      throw new Error(
        `container source archive restore failed: ${response.status}${failure ? ` (${failure})` : ""}`,
      );
    }
  }

  // remote_state dependency restore (spec §15): for each producer state descriptor
  // fetch the encrypted object from R2_STATE, decrypt + verify its recorded
  // plaintext digest (tamper check, same path as #restoreStateFromR2State), and
  // stream the plaintext to the container's dep-state restore route. The DO
  // path-jails the stateRef to the producer env's state prefix (defense against
  // a crafted descriptor pointing at another tenant's object) and the container
  // writes each as /work/deps/<name>.tfstate read-only. The container never sees
  // the passphrase or the ciphertext.
  async #restoreDepStates(
    runId: string,
    depStates: readonly DepState[],
    baseUrl: URL,
  ): Promise<void> {
    const bucket = this.#r2State();
    for (const depState of depStates) {
      // The object key MUST stay inside the producer env's state prefix. A
      // descriptor pointing elsewhere is a crafted cross-tenant read.
      assertDepStateRef(depState);
      const object = await bucket.get(depState.stateRef);
      if (!object) {
        throw new Error(
          `dependency state object not found: ${depState.stateRef}`,
        );
      }
      const ciphertext = await readBoundedR2ObjectBytes(
        object,
        "state",
        maxStateArtifactCiphertextBytes(this.#artifactLimits.state),
      );
      const plaintext = await this.#stateCrypto().open(
        ciphertext,
        depState.digest,
      );
      assertArtifactSize(
        "state",
        this.#artifactLimits.state,
        plaintext.byteLength,
      );
      await this.#ensureContainerReady(baseUrl);
      const response = await this.#containerFetch(
        new Request(depStateRestoreUrl(baseUrl, runId, depState.name), {
          method: "PUT",
          headers: { "content-type": STATE_ARTIFACT_CONTENT_TYPE },
          body: toArrayBuffer(plaintext),
        }),
      );
      if (!response.ok) {
        throw new Error(
          `container dependency state restore failed for ${depState.name}: ` +
            `${response.status}`,
        );
      }
    }
  }

  // M2 state restore: fetch only the exact canonical descriptor supplied by the
  // control ledger. R2 object history and current.json are never discovery or
  // downgrade authority. First-create plans have no prior descriptor.
  async #restoreStateFromR2State(
    runId: string,
    scope: StateScope,
    baseUrl: URL,
    action: string | undefined,
    adoption: StateAdoption | undefined,
  ): Promise<void> {
    const bucket = this.#r2State();
    assertStateRefForScope(scope);
    const expectedGeneration = priorStateGeneration(scope, action);
    if (scope.priorState && adoption) {
      throw new Error("state adoption cannot replace canonical priorState");
    }
    if (adoption) {
      const canonicalRef = stateRefForGeneration(scope, expectedGeneration);
      if (await bucket.head(canonicalRef)) {
        throw new Error(
          "state adoption refused: canonical Resource state already exists",
        );
      }
    }
    const adopted = adoption
      ? await readConfirmedStateAdoption(
          bucket,
          scope,
          adoption,
          expectedGeneration,
        )
      : undefined;
    const resolved =
      adopted ??
      (scope.priorState
        ? await readCanonicalPriorState(
            bucket,
            scope,
            scope.priorState,
            expectedGeneration,
          )
        : undefined);
    if (!resolved && expectedGeneration > 0) {
      throw new Error(
        `canonical priorState is required for generation ${expectedGeneration}`,
      );
    }
    if (!resolved) return;
    const { pointer, object } = resolved;
    const ciphertext = await readBoundedR2ObjectBytes(
      object,
      "state",
      maxStateArtifactCiphertextBytes(this.#artifactLimits.state),
    );
    const plaintext = await this.#stateCrypto().open(
      ciphertext,
      pointer.digest,
    );
    assertArtifactSize(
      "state",
      this.#artifactLimits.state,
      plaintext.byteLength,
    );
    await this.#ensureContainerReady(baseUrl);
    const response = await this.#containerFetch(
      new Request(stateArtifactUrl(baseUrl, runId), {
        method: "PUT",
        headers: { "content-type": STATE_ARTIFACT_CONTENT_TYPE },
        body: toArrayBuffer(plaintext),
      }),
    );
    if (!response.ok) {
      throw new Error(
        `container state artifact restore failed: ${response.status}`,
      );
    }
  }

  // M2 state persist: pull the new plaintext tfstate from the container, encrypt
  // it at rest, write the state object at the generation key the controller owns
  // (8-digit), then best-effort project current.json AFTER the state object. The
  // DO returns the recorded digest in the run payload so the controller can
  // update its ledger; generation arithmetic stays with the controller.
  async #persistStateToR2State(
    containerRunId: string,
    applyRunId: string,
    scope: StateScope,
    baseUrl: URL,
    runnerResponse: Response,
    action: "apply" | "destroy",
    rawOutputRef: string | undefined,
    providerExecutionFailed: boolean,
    mutationDispatch: RunnerMutationDispatchRecord,
  ): Promise<Response> {
    let stateResponse: Response;
    try {
      stateResponse = await this.#containerFetch(
        new Request(stateArtifactUrl(baseUrl, containerRunId), {
          method: "GET",
        }),
      );
    } catch (error) {
      return await this.#recordMutationIndeterminate(mutationDispatch, error);
    }
    if (stateResponse.status === 404) {
      if (providerExecutionFailed) {
        const payload = await readJsonObject(
          runnerResponse,
          this.#artifactLimits.runnerResponse,
        );
        return jsonResponse(
          failedProviderExecutionPayload(
            payload,
            action,
            "unavailable",
          ),
          runnerResponse.status,
        );
      }
      throw new Error(
        `container ${action} completed without a durable state artifact`,
      );
    }
    if (!stateResponse.ok) {
      throw new Error(
        `container state artifact fetch failed: ${stateResponse.status}`,
      );
    }
    let plaintext: Uint8Array;
    try {
      plaintext = await readBoundedResponseBytes(
        stateResponse,
        "state",
        this.#artifactLimits.state,
      );
    } catch (error) {
      if (error instanceof RunnerArtifactSizeLimitError) throw error;
      return await this.#recordMutationIndeterminate(mutationDispatch, error);
    }
    const sealed = await this.#stateCrypto().seal(plaintext);
    const payload = await readJsonObject(
      runnerResponse,
      this.#artifactLimits.runnerResponse,
    );
    // Validate and encrypt outputs before the first durable write. A size-limit
    // failure must not leave a new state generation or current.json behind.
    const preparedRawOutputs =
      action === "apply" && !providerExecutionFailed
        ? await this.#prepareRawOutputs(rawOutputRef!, payload)
        : undefined;
    const bucket = this.#r2State();
    assertStateRefForScope(scope);
    const objectKey = scope.stateRef;
    const persistedRawOutputRef = preparedRawOutputs
      ? await this.#persistPreparedRawOutputs(applyRunId, preparedRawOutputs)
      : undefined;
    try {
      await putR2ObjectWithRetry(
        bucket,
        objectKey,
        sealed.ciphertext,
        {
          httpMetadata: { contentType: ENCRYPTED_ARTIFACT_CONTENT_TYPE },
          customMetadata: {
            "takosumi-run-id": applyRunId,
            "takosumi-action": action,
            "takosumi-content-digest": sealed.contentDigest,
            "takosumi-ciphertext-length": String(sealed.ciphertextLength),
            "takosumi-encryption-format": sealed.format,
            "takosumi-generation": String(scope.generation),
            ...(preparedRawOutputs
              ? { "takosumi-raw-output-ref": preparedRawOutputs.key }
              : { "takosumi-raw-output-status": "none" }),
            ...(providerExecutionFailed
              ? {
                  "takosumi-provider-execution": "failed",
                  ...(providerFailureErrorCode(payload)
                    ? {
                        "takosumi-provider-error-code":
                          providerFailureErrorCode(payload)!,
                      }
                    : {}),
                }
              : {}),
          },
          onlyIf: { etagDoesNotMatch: "*" },
        },
        "state object",
      );
    } catch (error) {
      if (!(error instanceof R2ConditionalPutConflictError)) throw error;
      const adopted = await this.#adoptCompletedStateMutationFromR2(
        applyRunId,
        scope,
        action,
        rawOutputRef,
      );
      if (!adopted) throw error;
      return adopted;
    }
    // current.json is a best-effort cache written AFTER the immutable target.
    // A retry adopts only this ApplyRun's exact target object; neither this
    // pointer nor an R2 prefix scan has ledger authority.
    const current = {
      generation: scope.generation,
      objectKey,
      digest: sealed.contentDigest,
      runId: applyRunId,
      ciphertextLength: sealed.ciphertextLength,
    };
    await writeCurrentStateCache(bucket, scope, current);
    const persistedState = {
      generation: scope.generation,
      stateRef: objectKey,
      digest: sealed.contentDigest,
      ciphertextLength: sealed.ciphertextLength,
    };
    return jsonResponse(
      providerExecutionFailed
        ? failedProviderExecutionPayload(
            payload,
            action,
            "persisted",
            persistedState,
          )
        : {
            ...payload,
            ...(action === "apply" ? { outputs: payload.outputs ?? {} } : {}),
            state: persistedState,
            ...(persistedRawOutputRef
              ? { rawOutputRef: persistedRawOutputRef }
              : {}),
          },
      runnerResponse.status,
    );
  }

  // M7: seal the raw `tofu output -json` envelope (the runner's `outputs` field,
  // which carries the per-output sensitive flags) and write it encrypted at rest
  // to R2_ARTIFACTS at the host-allocated ref. Even an apply with no declared
  // outputs persists `{}` so every successful apply returns a confirmed exact
  // raw-output coordinate to the controller.
  async #prepareRawOutputs(
    rawOutputRef: string,
    payload: Record<string, unknown>,
  ): Promise<PreparedRawOutputs> {
    const outputs = payload.outputs ?? {};
    if (!isRecord(outputs)) {
      throw new Error("runner outputs must be a JSON object");
    }
    assertSafeArtifactObjectKey(rawOutputRef, "raw output");
    const key = rawOutputRef;
    const plaintext = new TextEncoder().encode(JSON.stringify(outputs));
    assertArtifactSize(
      "output",
      this.#artifactLimits.output,
      plaintext.byteLength,
    );
    const sealed = await this.#stateCrypto().seal(plaintext);
    return { key, action: "apply", sealed };
  }

  async #persistPreparedRawOutputs(
    runId: string,
    prepared: PreparedRawOutputs,
  ): Promise<string> {
    try {
      await putR2ObjectWithRetry(
        this.env.R2_ARTIFACTS,
        prepared.key,
        prepared.sealed.ciphertext,
        {
          httpMetadata: { contentType: ENCRYPTED_ARTIFACT_CONTENT_TYPE },
          customMetadata: {
            "takosumi-run-id": runId,
            "takosumi-action": prepared.action,
            "takosumi-content-digest": prepared.sealed.contentDigest,
            "takosumi-ciphertext-length": String(
              prepared.sealed.ciphertextLength,
            ),
            "takosumi-encryption-format": prepared.sealed.format,
          },
          onlyIf: { etagDoesNotMatch: "*" },
        },
        "raw outputs",
      );
    } catch (error) {
      if (
        !(error instanceof R2ConditionalPutConflictError) &&
        !(error instanceof RunnerArtifactRelayInfrastructureError)
      ) {
        throw error;
      }
      const existing = await this.env.R2_ARTIFACTS.head(prepared.key);
      if (
        existing?.customMetadata?.["takosumi-run-id"] !== runId ||
        existing.customMetadata?.["takosumi-action"] !== prepared.action ||
        existing.customMetadata?.["takosumi-content-digest"] !==
          prepared.sealed.contentDigest
      ) {
        throw new Error(
          "raw output target already belongs to different artifact authority",
        );
      }
      // A lost conditional-PUT response is safe to resolve only by reading the
      // same immutable key and matching this ApplyRun plus plaintext digest.
      // Doing so here lets the state object commit continue without replaying
      // provider work merely because raw-output acknowledgement was lost.
    }
    return prepared.key;
  }

  async #adoptCompletedStateMutationFromR2(
    applyRunId: string,
    scope: StateScope,
    action: "apply" | "destroy",
    rawOutputRef: string | undefined,
  ): Promise<Response | undefined> {
    assertStateRefForScope(scope);
    const bucket = this.#r2State();
    const object = await bucket.get(scope.stateRef);
    if (!object) return undefined;
    const persistedRunId = object.customMetadata?.["takosumi-run-id"];
    if (!persistedRunId || persistedRunId !== applyRunId) {
      throw new Error(
        `completed ${action} target belongs to a different ApplyRun`,
      );
    }
    const persistedAction = object.customMetadata?.["takosumi-action"];
    if (persistedAction !== action) {
      throw new Error(
        `completed ${action} target belongs to a different action`,
      );
    }
    const metadataDigest = object.customMetadata?.["takosumi-content-digest"];
    if (!metadataDigest) {
      throw new Error(`completed ${action} target has no canonical digest`);
    }
    const metadataGeneration = Number(
      object.customMetadata?.["takosumi-generation"],
    );
    if (metadataGeneration !== scope.generation) {
      throw new Error(
        `completed ${action} target generation does not match stateScope`,
      );
    }
    const completedState = await this.#stateCrypto().open(
      await readBoundedR2ObjectBytes(
        object,
        "state",
        maxStateArtifactCiphertextBytes(this.#artifactLimits.state),
      ),
      metadataDigest,
    );
    assertArtifactSize(
      "state",
      this.#artifactLimits.state,
      completedState.byteLength,
    );
    const recordedRawOutputRef =
      object.customMetadata?.["takosumi-raw-output-ref"];
    const providerExecutionFailed =
      object.customMetadata?.["takosumi-provider-execution"] === "failed";
    if (action === "destroy" && recordedRawOutputRef) {
      throw new Error(
        "completed destroy target unexpectedly records raw output authority",
      );
    }
    if (
      action === "apply" &&
      !providerExecutionFailed &&
      recordedRawOutputRef !== rawOutputRef
    ) {
      throw new Error(
        "completed apply target raw output authority does not match dispatch",
      );
    }
    const rawOutputs = recordedRawOutputRef
      ? await this.#readPersistedRawOutputs(
          applyRunId,
          action,
          recordedRawOutputRef,
        )
      : undefined;
    if (recordedRawOutputRef && !rawOutputs) {
      throw new Error("completed apply target raw output artifact is missing");
    }
    if (providerExecutionFailed && recordedRawOutputRef) {
      throw new Error(
        "completed failed provider state unexpectedly records raw output authority",
      );
    }
    const ciphertextLength = Number(
      object.customMetadata?.["takosumi-ciphertext-length"],
    );
    await writeCurrentStateCache(bucket, scope, {
      generation: scope.generation,
      objectKey: scope.stateRef,
      digest: metadataDigest,
      runId: applyRunId,
      ...(Number.isFinite(ciphertextLength) ? { ciphertextLength } : {}),
    });
    const state = {
      generation: scope.generation,
      stateRef: scope.stateRef,
      digest: metadataDigest,
      ...(Number.isFinite(ciphertextLength) ? { ciphertextLength } : {}),
    };
    if (providerExecutionFailed) {
      return jsonResponse(
        failedProviderExecutionPayload(
          {
            status: "failed",
            exitCode: 1,
            ...(object.customMetadata?.["takosumi-provider-error-code"]
              ? {
                  errorCode:
                    object.customMetadata["takosumi-provider-error-code"],
                }
              : {}),
          },
          action,
          "persisted",
          state,
        ),
        500,
      );
    }
    return jsonResponse(
      {
        status: "succeeded",
        exitCode: 0,
        state,
        ...(rawOutputs
          ? { outputs: rawOutputs.outputs, rawOutputRef: rawOutputs.ref }
          : {}),
      },
      200,
    );
  }

  async #readPersistedRawOutputs(
    applyRunId: string,
    action: "apply" | "destroy",
    rawOutputRef: string,
  ): Promise<
    | { readonly ref: string; readonly outputs: Record<string, unknown> }
    | undefined
  > {
    assertSafeArtifactObjectKey(rawOutputRef, "raw output");
    const key = rawOutputRef;
    const object = await this.env.R2_ARTIFACTS.get(key);
    if (!object) return undefined;
    if (object.customMetadata?.["takosumi-run-id"] !== applyRunId) {
      throw new Error("raw output artifact belongs to a different ApplyRun");
    }
    if (object.customMetadata?.["takosumi-action"] !== action) {
      throw new Error("raw output artifact belongs to a different action");
    }
    const digest = object.customMetadata?.["takosumi-content-digest"];
    if (!digest) {
      throw new Error("raw output artifact has no canonical digest");
    }
    const plaintext = await this.#stateCrypto().open(
      await readBoundedR2ObjectBytes(
        object,
        "output",
        maxStateArtifactCiphertextBytes(this.#artifactLimits.output),
      ),
      digest,
    );
    assertArtifactSize(
      "output",
      this.#artifactLimits.output,
      plaintext.byteLength,
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("raw output artifact must be a JSON object");
    }
    return { ref: key, outputs: parsed };
  }

  async #restoreStateGeneration(
    runId: string,
    scope: StateScope,
    restoreState: RestoreState,
  ): Promise<Response> {
    assertRestoreStateRef(scope, restoreState.stateRef);
    const bucket = this.#r2State();
    const object = await bucket.get(restoreState.stateRef);
    if (!object) {
      throw new Error(
        `restore state object not found: ${restoreState.stateRef}`,
      );
    }
    const plaintext = await this.#stateCrypto().open(
      await readBoundedR2ObjectBytes(
        object,
        "state",
        maxStateArtifactCiphertextBytes(this.#artifactLimits.state),
      ),
      restoreState.digest,
    );
    assertArtifactSize(
      "state",
      this.#artifactLimits.state,
      plaintext.byteLength,
    );
    const sealed = await this.#stateCrypto().seal(plaintext);
    assertStateRefForScope(scope);
    const objectKey = scope.stateRef;
    await putR2ObjectWithRetry(
      bucket,
      objectKey,
      sealed.ciphertext,
      {
        httpMetadata: { contentType: ENCRYPTED_ARTIFACT_CONTENT_TYPE },
        customMetadata: {
          "takosumi-run-id": runId,
          "takosumi-content-digest": sealed.contentDigest,
          "takosumi-ciphertext-length": String(sealed.ciphertextLength),
          "takosumi-encryption-format": sealed.format,
          "takosumi-generation": String(scope.generation),
          "takosumi-restored-from-object": restoreState.stateRef,
        },
      },
      "restored state object",
    );
    const current = {
      generation: scope.generation,
      objectKey,
      digest: sealed.contentDigest,
      runId,
      ciphertextLength: sealed.ciphertextLength,
    };
    await putR2ObjectWithRetry(
      bucket,
      currentStateKey(scope),
      JSON.stringify(current),
      {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { "takosumi-run-id": runId },
      },
      "restored state pointer",
    );
    return jsonResponse(
      {
        state: {
          generation: current.generation,
          stateRef: current.objectKey,
          digest: current.digest,
          runId: current.runId,
          ciphertextLength: current.ciphertextLength,
        },
      },
      200,
    );
  }

  async #persistPlanArtifact(
    runId: string,
    runnerResponse: Response,
    baseUrl: URL,
    stateScope: StateScope | undefined,
  ): Promise<Response> {
    const payload = await readJsonObject(
      runnerResponse,
      this.#artifactLimits.runnerResponse,
    );
    const artifact = recordField(payload, "planArtifact");
    if (!artifact || stringField(artifact, "kind") !== "runner-local") {
      return jsonResponse(payload, runnerResponse.status);
    }
    const artifactResponse = await this.#containerFetch(
      new Request(artifactUrl(baseUrl, runId), { method: "GET" }),
    );
    if (!artifactResponse.ok) {
      throw new Error(
        `container plan artifact fetch failed: ${artifactResponse.status}`,
      );
    }
    const bytes = await readBoundedResponseBytes(
      artifactResponse,
      "plan",
      this.#artifactLimits.plan,
    );
    const digest = await digestBytes(bytes);
    const expectedDigest = stringField(artifact, "digest");
    if (expectedDigest && expectedDigest !== digest) {
      throw new Error(`container plan artifact digest mismatch: ${digest}`);
    }
    const bucket = this.#planArtifactBucket();
    const key = planArtifactKey(runId, stateScope);
    // At-rest encryption (spec invariant #13): the plan binary is sealed with
    // the same AES-GCM primitive as state. The object key gains `.enc`; the
    // object-storage ref the consumer restores from still names the plaintext
    // key so #restorePlanArtifact maps it back to `<key>.enc` transparently.
    const sealed = await this.#stateCrypto().seal(bytes);
    const stored = await putR2ObjectWithRetry(
      this.env.R2_ARTIFACTS,
      encryptedKey(key),
      sealed.ciphertext,
      {
        httpMetadata: { contentType: ENCRYPTED_ARTIFACT_CONTENT_TYPE },
        customMetadata: {
          "takosumi-plan-run-id": runId,
          "takosumi-content-digest": digest,
          "takosumi-ciphertext-length": String(sealed.ciphertextLength),
          "takosumi-encryption-format": sealed.format,
        },
      },
      "plan artifact",
    );
    // Plan JSON sits beside the binary; encrypt it too when the runner produced
    // it (the runner exposes it on the /artifacts/tfplan-json route).
    await this.#persistPlanJsonArtifact(runId, baseUrl, stateScope);
    return jsonResponse(
      {
        ...payload,
        planArtifact: {
          kind: "object-storage",
          ref: planArtifactRef(bucket, key),
          digest,
          contentType: PLAN_ARTIFACT_CONTENT_TYPE,
          sizeBytes: stored.size,
          createdAt: Date.now(),
        },
      },
      runnerResponse.status,
    );
  }

  // Pull the `tofu show -json tfplan` JSON from the container (when present) and
  // persist it encrypted alongside the plan binary under the run-scoped
  // `plan.json.zst.enc` key when stateScope is available.
  async #persistPlanJsonArtifact(
    runId: string,
    baseUrl: URL,
    stateScope: StateScope | undefined,
  ): Promise<void> {
    const response = await this.#containerFetch(
      new Request(planJsonArtifactUrl(baseUrl, runId), { method: "GET" }),
    );
    if (response.status === 404) return;
    if (!response.ok) {
      throw new Error(
        `container plan-json artifact fetch failed: ${response.status}`,
      );
    }
    const maxBytes = planJsonArtifactMaxBytes(this.env);
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedResponseBytes(response, "plan_json", maxBytes);
    } catch (error) {
      if (!(error instanceof RunnerArtifactSizeLimitError)) throw error;
      console.warn("skipping oversized OpenTofu plan JSON artifact", {
        artifact: "plan_json",
        reason: "artifact_size_limit",
        sizeBytes: error.observedBytes,
        maxBytes,
      });
      return;
    }
    const digest = await digestBytes(bytes);
    const sealed = await this.#stateCrypto().seal(zstdCompressRaw(bytes));
    await putR2ObjectWithRetry(
      this.env.R2_ARTIFACTS,
      encryptedKey(planJsonArtifactKey(runId, stateScope)),
      sealed.ciphertext,
      {
        httpMetadata: { contentType: ENCRYPTED_ARTIFACT_CONTENT_TYPE },
        customMetadata: {
          "takosumi-plan-run-id": runId,
          "takosumi-content-digest": digest,
          "takosumi-ciphertext-length": String(sealed.ciphertextLength),
          "takosumi-encryption-format": sealed.format,
        },
      },
      "plan json artifact",
    );
  }

  async #restorePlanArtifact(
    runId: string,
    requestPayload: unknown,
    baseUrl: URL,
  ): Promise<void> {
    const artifact = recordField(requestPayload, "planArtifact");
    if (!artifact || stringField(artifact, "kind") !== "object-storage") return;
    const key = planArtifactKeyFromRef(
      requiredStringField(artifact, "ref"),
      this.#planArtifactBucket(),
    );
    const expectedDigest = requiredStringField(artifact, "digest");
    // The plan binary is stored encrypted at `<key>.enc`; plaintext plan
    // objects are not a valid restore source.
    const bytes = await this.#readPlanArtifactPlaintext(key, expectedDigest);
    const response = await this.#containerFetch(
      new Request(artifactUrl(baseUrl, runId), {
        method: "PUT",
        headers: { "content-type": PLAN_ARTIFACT_CONTENT_TYPE },
        body: toArrayBuffer(bytes),
      }),
    );
    if (!response.ok) {
      throw new Error(
        `container plan artifact restore failed: ${response.status}`,
      );
    }
  }

  async #readPlanArtifactPlaintext(
    key: string,
    expectedDigest: string,
  ): Promise<Uint8Array> {
    const encrypted = await this.env.R2_ARTIFACTS.get(encryptedKey(key));
    if (!encrypted) {
      throw new Error(`plan artifact object not found: ${key}`);
    }
    const ciphertext = await readBoundedR2ObjectBytes(
      encrypted,
      "plan",
      maxStateArtifactCiphertextBytes(this.#artifactLimits.plan),
    );
    const plaintext = await this.#stateCrypto().open(
      ciphertext,
      expectedDigest,
    );
    assertArtifactSize("plan", this.#artifactLimits.plan, plaintext.byteLength);
    return plaintext;
  }

  async #restoreStateArtifact(
    runId: string,
    keys: readonly string[],
    baseUrl: URL,
  ): Promise<void> {
    for (const key of keys) {
      const object = await this.env.R2_ARTIFACTS.get(encryptedKey(key));
      if (!object) continue;
      const ciphertext = await readBoundedR2ObjectBytes(
        object,
        "state",
        maxStateArtifactCiphertextBytes(this.#artifactLimits.state),
      );
      const bytes = await this.#stateCrypto().open(
        ciphertext,
        object.customMetadata?.["takosumi-content-digest"],
      );
      assertArtifactSize("state", this.#artifactLimits.state, bytes.byteLength);
      await this.#ensureContainerReady(baseUrl);
      const response = await this.#containerFetch(
        new Request(stateArtifactUrl(baseUrl, runId), {
          method: "PUT",
          headers: { "content-type": STATE_ARTIFACT_CONTENT_TYPE },
          body: toArrayBuffer(bytes),
        }),
      );
      if (!response.ok) {
        throw new Error(
          `container state artifact restore failed: ${response.status}`,
        );
      }
      return;
    }
  }

  async #persistStateArtifact(
    runId: string,
    keys: readonly string[],
    baseUrl: URL,
    mutationDispatch: RunnerMutationDispatchRecord,
  ): Promise<Response | undefined> {
    let response: Response;
    try {
      response = await this.#containerFetch(
        new Request(stateArtifactUrl(baseUrl, runId), { method: "GET" }),
      );
    } catch (error) {
      return await this.#recordMutationIndeterminate(mutationDispatch, error);
    }
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `container state artifact fetch failed: ${response.status}`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedResponseBytes(
        response,
        "state",
        this.#artifactLimits.state,
      );
    } catch (error) {
      if (error instanceof RunnerArtifactSizeLimitError) throw error;
      return await this.#recordMutationIndeterminate(mutationDispatch, error);
    }
    const sealed = await this.#stateCrypto().seal(bytes);
    for (const key of keys) {
      await putR2ObjectWithRetry(
        this.env.R2_ARTIFACTS,
        encryptedKey(key),
        sealed.ciphertext,
        {
          httpMetadata: { contentType: ENCRYPTED_ARTIFACT_CONTENT_TYPE },
          customMetadata: {
            "takosumi-run-id": runId,
            "takosumi-content-digest": sealed.contentDigest,
            "takosumi-ciphertext-length": String(sealed.ciphertextLength),
            "takosumi-encryption-format": sealed.format,
          },
        },
        "state artifact",
      );
    }
    return undefined;
  }

  #planArtifactBucket(): string {
    const configured = this.env.R2_ARTIFACTS_BUCKET_NAME;
    return typeof configured === "string" && configured.trim().length > 0
      ? configured.trim()
      : DEFAULT_PLAN_ARTIFACT_BUCKET;
  }
}

/**
 * Miniflare must not bind the Container-derived class directly: it interprets
 * that binding as a Cloudflare Container and rejects it before the local proxy
 * can run. This plain Durable Object delegates to the same artifact-relay class
 * and exists only for the local-substrate wrapper.
 */
export class LocalSubstrateOpenTofuRunnerProxyObject {
  readonly #delegate: OpenTofuRunnerObject;

  constructor(ctx: ContainerHostContext, env: CloudflareWorkerEnv) {
    if (
      env.LOCAL_SUBSTRATE_TEST_BED !== "1" ||
      !env.TAKOSUMI_LOCAL_OPENTOFU_RUNNER_URL?.trim()
    ) {
      throw new Error(
        "LocalSubstrateOpenTofuRunnerProxyObject is local-substrate-only",
      );
    }
    this.#delegate = new OpenTofuRunnerObject(ctx, env);
  }

  fetch(request: Request): Promise<Response> {
    return this.#delegate.fetch(request);
  }
}

export function localOpenTofuRunnerProxyUrl(
  env: Pick<
    CloudflareWorkerEnv,
    "LOCAL_SUBSTRATE_TEST_BED" | "TAKOSUMI_LOCAL_OPENTOFU_RUNNER_URL"
  >,
): URL | undefined {
  const raw = env.TAKOSUMI_LOCAL_OPENTOFU_RUNNER_URL?.trim();
  if (!raw) return undefined;
  if (env.LOCAL_SUBSTRATE_TEST_BED !== "1") {
    throw new Error(
      "TAKOSUMI_LOCAL_OPENTOFU_RUNNER_URL requires LOCAL_SUBSTRATE_TEST_BED=1",
    );
  }
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "TAKOSUMI_LOCAL_OPENTOFU_RUNNER_URL must use http or https",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

export async function proxyLocalOpenTofuRunnerRequest(
  request: Request,
  baseUrl: URL,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const source = new URL(request.url);
  const target = new URL(`${source.pathname}${source.search}`, baseUrl);
  return await fetcher(new Request(target, request));
}

async function putR2ObjectWithRetry(
  bucket: R2Bucket,
  key: string,
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
  options: R2PutOptions | undefined,
  context: string,
): Promise<R2Object> {
  for (let attempt = 1; attempt <= R2_PUT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const object = await bucket.put(key, value, options);
      if (!object) {
        throw new R2ConditionalPutConflictError();
      }
      return object;
    } catch (error) {
      if (error instanceof R2ConditionalPutConflictError) throw error;
      if (options?.onlyIf?.etagDoesNotMatch === "*") {
        throw new RunnerArtifactRelayInfrastructureError();
      }
      if (attempt >= R2_PUT_RETRY_ATTEMPTS || !isRetryableR2PutError(error)) {
        throw new Error(
          `runner R2 ${runnerR2LogArtifact(context, key)} put failed after ${attempt} attempt${
            attempt === 1 ? "" : "s"
          }`,
        );
      }
      console.warn("OpenTofu runner R2 put failed; retrying", {
        artifact: runnerR2LogArtifact(context, key),
        attempt,
        maxAttempts: R2_PUT_RETRY_ATTEMPTS,
        reason: RUNNER_R2_LOG_REASON.putRetryable,
        errorName: safeRunnerErrorName(error),
      });
      await sleep(
        Math.min(
          R2_PUT_RETRY_MAX_MS,
          R2_PUT_RETRY_BASE_MS * 2 ** (attempt - 1),
        ),
      );
    }
  }
  throw new Error("runner R2 put retry budget exhausted");
}

class R2ConditionalPutConflictError extends Error {
  constructor() {
    super("runner R2 conditional put conflict");
    this.name = "R2ConditionalPutConflictError";
  }
}

const RUNNER_ARTIFACT_RELAY_AMBIGUOUS_CODE = "runner_artifact_relay_ambiguous";

class RunnerArtifactRelayInfrastructureError extends Error {
  readonly code = RUNNER_ARTIFACT_RELAY_AMBIGUOUS_CODE;

  constructor() {
    super("runner R2 immutable put outcome is ambiguous");
    this.name = "RunnerArtifactRelayInfrastructureError";
  }
}

function isRetryableR2PutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:10043|cloudflarestatus\.com|internal error|timed?\s*out|timeout|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/iu.test(
    message,
  );
}

function artifactUrl(baseUrl: URL, runId: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/runs/${encodeURIComponent(runId)}/artifacts/tfplan`;
  url.search = "";
  return url.toString();
}

function isRunDispatchRequest(request: Request): boolean {
  if (request.method !== "POST") return false;
  return /^\/runs\/[^/]+$/.test(new URL(request.url).pathname);
}

function runnerRelayOperation(request: Request): "run_dispatch" | "other" {
  return isRunDispatchRequest(request) ? "run_dispatch" : "other";
}

function runnerR2LogArtifact(context: string, key: string): string {
  switch (context) {
    case "source archive":
      return RUNNER_R2_LOG_ARTIFACT.sourceArchive;
    case "state object":
      return RUNNER_R2_LOG_ARTIFACT.stateObject;
    case "raw outputs":
      return RUNNER_R2_LOG_ARTIFACT.rawOutputs;
    case "restored state object":
      return RUNNER_R2_LOG_ARTIFACT.restoredStateObject;
    case "plan artifact":
      return RUNNER_R2_LOG_ARTIFACT.planArtifact;
    case "plan json artifact":
      return RUNNER_R2_LOG_ARTIFACT.planJsonArtifact;
    case "state artifact":
      return RUNNER_R2_LOG_ARTIFACT.stateArtifact;
    case "restored state pointer":
    case "state pointer cache":
      return RUNNER_R2_LOG_ARTIFACT.statePointer;
    default:
      return key.endsWith("/current.json")
        ? RUNNER_R2_LOG_ARTIFACT.statePointer
        : RUNNER_R2_LOG_ARTIFACT.other;
  }
}

function runnerArtifactLimits(env: CloudflareWorkerEnv): RunnerArtifactLimits {
  return {
    sourceArchive: configuredArtifactLimit(
      env,
      RUNNER_ARTIFACT_LIMIT_ENV.sourceArchive,
      RUNNER_ARTIFACT_LIMIT_DEFAULTS.sourceArchive,
    ),
    state: configuredArtifactLimit(
      env,
      RUNNER_ARTIFACT_LIMIT_ENV.state,
      RUNNER_ARTIFACT_LIMIT_DEFAULTS.state,
    ),
    plan: configuredArtifactLimit(
      env,
      RUNNER_ARTIFACT_LIMIT_ENV.plan,
      RUNNER_ARTIFACT_LIMIT_DEFAULTS.plan,
    ),
    output: configuredArtifactLimit(
      env,
      RUNNER_ARTIFACT_LIMIT_ENV.output,
      RUNNER_ARTIFACT_LIMIT_DEFAULTS.output,
    ),
    runnerResponse: configuredArtifactLimit(
      env,
      RUNNER_ARTIFACT_LIMIT_ENV.runnerResponse,
      RUNNER_ARTIFACT_LIMIT_DEFAULTS.runnerResponse,
    ),
    statePointer: RUNNER_ARTIFACT_LIMIT_DEFAULTS.statePointer,
    failureDetail: RUNNER_ARTIFACT_LIMIT_DEFAULTS.failureDetail,
  };
}

function configuredArtifactLimit(
  env: CloudflareWorkerEnv,
  name: string,
  hardMaximum: number,
): number {
  const raw = (env as unknown as Readonly<Record<string, unknown>>)[name];
  const parsed =
    typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, hardMaximum)
    : hardMaximum;
}

function assertArtifactSize(
  artifact: RunnerArtifactKind,
  maxBytes: number,
  observedBytes: number,
): void {
  if (observedBytes > maxBytes) {
    throw new RunnerArtifactSizeLimitError(artifact, maxBytes, observedBytes);
  }
}

/**
 * Reads an HTTP body without ever invoking the runtime's unbounded
 * `arrayBuffer()`/`text()` helpers. A trustworthy Content-Length can reject
 * oversized bodies before the first allocation; absent, invalid, or forged
 * lengths still pass through the byte-counting stream guard.
 */
export async function readBoundedResponseBytes(
  response: Response,
  artifact: RunnerArtifactKind,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = parseContentLength(
    response.headers.get("content-length"),
  );
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    await cancelResponseBody(response);
    throw new RunnerArtifactSizeLimitError(artifact, maxBytes, declaredLength);
  }
  if (!response.body) return new Uint8Array();

  const initialCapacity =
    declaredLength !== undefined
      ? declaredLength
      : Math.min(BOUNDED_STREAM_INITIAL_BYTES, maxBytes);
  let buffer = new Uint8Array(initialCapacity);
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const nextLength = length + chunk.byteLength;
      if (!Number.isSafeInteger(nextLength) || nextLength > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The deterministic limit error is authoritative.
        }
        throw new RunnerArtifactSizeLimitError(
          artifact,
          maxBytes,
          Number.isSafeInteger(nextLength) ? nextLength : maxBytes + 1,
        );
      }
      if (nextLength > buffer.byteLength) {
        const doubled =
          buffer.byteLength === 0
            ? Math.min(BOUNDED_STREAM_INITIAL_BYTES, maxBytes)
            : Math.min(buffer.byteLength * 2, maxBytes);
        const nextCapacity = Math.max(nextLength, doubled);
        const replacement = new Uint8Array(nextCapacity);
        replacement.set(buffer.subarray(0, length));
        buffer = replacement;
      }
      buffer.set(chunk, length);
      length = nextLength;
    }
  } finally {
    reader.releaseLock();
  }
  return buffer.subarray(0, length);
}

async function readBoundedR2ObjectBytes(
  object: R2ObjectBody,
  artifact: RunnerArtifactKind,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(object.size) || object.size < 0) {
    throw new RunnerArtifactSizeLimitError(artifact, maxBytes, maxBytes + 1);
  }
  assertArtifactSize(artifact, maxBytes, object.size);
  // The current Cloudflare R2ObjectBody exposes `body`, while the repository's
  // narrow binding/test doubles still model only arrayBuffer(). Prefer the real
  // stream so a future adapter cannot forge `size` and force an unbounded read.
  const body = (
    object as unknown as {
      readonly body?: ReadableStream<Uint8Array>;
    }
  ).body;
  if (body) {
    return await readBoundedResponseBytes(
      new Response(body, {
        headers: { "content-length": String(object.size) },
      }),
      artifact,
      maxBytes,
    );
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  // R2's size is authoritative in production; checking the materialized bytes
  // as well keeps test doubles and future adapters fail-closed.
  assertArtifactSize(artifact, maxBytes, bytes.byteLength);
  return bytes;
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Best effort only; the caller still receives the deterministic limit error.
  }
}

async function bufferedResponse(
  response: Response,
  maxBytes: number,
): Promise<Response> {
  const body = await readBoundedResponseBytes(
    response,
    "runner_response",
    maxBytes,
  );
  return new Response(toArrayBuffer(body), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function containerHealthUrl(baseUrl: URL): string {
  const url = new URL(baseUrl);
  url.pathname = "/healthz";
  url.search = "";
  return url.toString();
}

function isContainerNotRunningError(error: unknown): boolean {
  return (
    error instanceof Error && CONTAINER_NOT_RUNNING_PATTERN.test(error.message)
  );
}

function safeRunnerErrorName(error: unknown): string {
  if (error instanceof DOMException) return "DOMException";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof Error) return "Error";
  return "NonError";
}

function safeRunnerFailureReason(error: unknown): string {
  if (error instanceof RunnerArtifactSizeLimitError) {
    return "artifact_size_limit";
  }
  if (error instanceof RunnerArtifactRelayInfrastructureError) {
    return "artifact_durability_ambiguous";
  }
  if (error instanceof R2ConditionalPutConflictError) {
    return "artifact_authority_conflict";
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "request_aborted";
  }
  if (isContainerNotRunningError(error)) {
    return "container_unavailable";
  }
  return "relay_failure";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function stateArtifactUrl(baseUrl: URL, runId: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/runs/${encodeURIComponent(runId)}/artifacts/tfstate`;
  url.search = "";
  return url.toString();
}

function sourceArchiveUrl(baseUrl: URL, runId: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/runs/${encodeURIComponent(runId)}/artifacts/source-archive`;
  url.search = "";
  return url.toString();
}

// M2: restore route the DO PUTs the snapshotted source archive to. The runner
// server extracts it into /work/source as the source tree for build/plan.
function sourceArchiveRestoreUrl(baseUrl: URL, runId: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/runs/${encodeURIComponent(runId)}/source-archive/restore`;
  url.search = "";
  return url.toString();
}

// remote_state dependency restore route: the DO PUTs the decrypted producer
// state and the runner server writes it read-only to /work/deps/<name>.tfstate.
// The dep name is path-segment encoded so a single URL path segment carries it
// (the runner re-validates it is a safe filename).
function depStateRestoreUrl(baseUrl: URL, runId: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/runs/${encodeURIComponent(runId)}/deps/${encodeURIComponent(
    name,
  )}/restore`;
  url.search = "";
  return url.toString();
}

function planJsonArtifactUrl(baseUrl: URL, runId: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/runs/${encodeURIComponent(runId)}/artifacts/tfplan-json`;
  url.search = "";
  return url.toString();
}

function planJsonArtifactMaxBytes(env: CloudflareWorkerEnv): number {
  const parsed = Number(env.TAKOSUMI_PLAN_JSON_ARTIFACT_MAX_BYTES);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, DEFAULT_PLAN_JSON_ARTIFACT_MAX_BYTES)
    : DEFAULT_PLAN_JSON_ARTIFACT_MAX_BYTES;
}

// ===========================================================================
// R2_STATE keys (spec §20 / §26):
//   workspaces/{workspaceId}/capsules/{capsuleId}/environments/{environment}/state-versions/{NNNNNNNN}.tfstate.enc
//   workspaces/{workspaceId}/capsules/{capsuleId}/environments/{environment}/state-versions/current.json
// The generation is owned by the controller (other lane); the DO formats it as
// an 8-digit, zero-padded segment for the object key.
// ===========================================================================

function stateScopePrefix(scope: StateScope): string {
  const collection =
    scope.subjectKind === "resource" ? "resources" : "capsules";
  return `workspaces/${safeKeySegment(scope.workspaceId)}/${collection}/${safeKeySegment(
    scope.subjectId,
  )}/environments/${safeKeySegment(scope.environment)}/state-versions`;
}

function currentStateKey(scope: StateScope): string {
  return `${stateScopePrefix(scope)}/current.json`;
}

function assertStateRefForScope(scope: StateScope): void {
  const expected = `${stateScopePrefix(scope)}/${formatGeneration(
    scope.generation,
  )}.tfstate.enc`;
  if (scope.stateRef !== expected) {
    throw new Error("allocated stateRef does not match this R2 state adapter");
  }
}

function assertRawOutputRefForScope(
  scope: StateScope,
  runId: string,
  ref: string,
): void {
  const collection =
    scope.subjectKind === "resource" ? "resources" : "capsules";
  const expected = `workspaces/${safeKeySegment(scope.workspaceId)}/${collection}/${safeKeySegment(
    scope.subjectId,
  )}/runs/${safeKeySegment(runId)}/outputs.raw.json.enc`;
  if (ref !== expected) {
    throw new Error(
      "allocated rawOutputRef does not match this R2 artifact storage binding",
    );
  }
}

function formatGeneration(generation: number): string {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error(
      `state generation must be a non-negative integer: ${generation}`,
    );
  }
  return String(generation).padStart(8, "0");
}

interface CurrentStatePointer {
  readonly generation: number;
  readonly objectKey: string;
  readonly digest?: string;
  readonly runId?: string;
  readonly ciphertextLength?: number;
}

async function writeCurrentStateCache(
  bucket: NonNullable<CloudflareWorkerEnv["R2_STATE"]>,
  scope: StateScope,
  pointer: CurrentStatePointer,
): Promise<void> {
  try {
    await putR2ObjectWithRetry(
      bucket,
      currentStateKey(scope),
      JSON.stringify(pointer),
      {
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          ...(pointer.runId ? { "takosumi-run-id": pointer.runId } : {}),
          "takosumi-cache-only": "true",
        },
      },
      "state pointer cache",
    );
  } catch (error) {
    // current.json is only an inventory/cache projection. The immutable exact
    // state target and the control-plane ledger remain authoritative, so cache
    // repair must never turn a successful mutation into a provider replay.
    console.warn("OpenTofu runner current-state cache write failed", {
      generation: pointer.generation,
      reason: RUNNER_R2_LOG_REASON.currentStateCacheWriteFailed,
      errorName: safeRunnerErrorName(error),
    });
  }
}

async function readConfirmedStateAdoption(
  bucket: NonNullable<CloudflareWorkerEnv["R2_STATE"]>,
  scope: StateScope,
  adoption: StateAdoption,
  expectedGeneration: number,
): Promise<{
  readonly pointer: CurrentStatePointer;
  readonly object: NonNullable<Awaited<ReturnType<typeof bucket.get>>>;
}> {
  if (scope.subjectKind !== "resource") {
    throw new Error("state adoption is valid only for a Resource state scope");
  }
  if (
    adoption.sourceWorkspaceId !== scope.workspaceId ||
    adoption.stateGeneration !== expectedGeneration
  ) {
    throw new Error(
      "state adoption ownership or generation does not match the Resource run",
    );
  }
  // The source ref was confirmed by the control plane and can point at an
  // immutable pre-v1 object. Treat it as an opaque read-only coordinate: the
  // current adapter must not reconstruct or extend a retired physical layout.
  assertSafeArtifactObjectKey(adoption.stateRef, "state adoption");
  if (!adoption.stateRef.endsWith(".tfstate.enc")) {
    throw new Error("state adoption ref must name an encrypted state object");
  }
  const object = await bucket.get(adoption.stateRef);
  if (!object) {
    throw new Error(`state adoption object is missing: ${adoption.stateRef}`);
  }
  const metadataDigest = object.customMetadata?.["takosumi-content-digest"];
  if (metadataDigest && metadataDigest !== adoption.stateDigest) {
    throw new Error("state adoption digest disagrees with object metadata");
  }
  return {
    pointer: {
      generation: adoption.stateGeneration,
      objectKey: adoption.stateRef,
      digest: adoption.stateDigest,
      ...(object.customMetadata?.["takosumi-run-id"]
        ? { runId: object.customMetadata["takosumi-run-id"] }
        : {}),
    },
    object,
  };
}

async function readCanonicalPriorState(
  bucket: NonNullable<CloudflareWorkerEnv["R2_STATE"]>,
  scope: StateScope,
  descriptor: StateVersionDescriptor,
  expectedGeneration: number,
): Promise<{
  readonly pointer: CurrentStatePointer;
  readonly object: NonNullable<Awaited<ReturnType<typeof bucket.get>>>;
}> {
  if (descriptor.generation !== expectedGeneration) {
    throw new Error(
      `canonical priorState generation mismatch: expected ${expectedGeneration}`,
    );
  }
  const expectedRef = stateRefForGeneration(scope, expectedGeneration);
  if (descriptor.stateRef !== expectedRef) {
    throw new Error("canonical priorState ref does not match stateScope");
  }
  const object = await bucket.get(descriptor.stateRef);
  if (!object) {
    throw new Error(
      `canonical priorState object not found: ${descriptor.stateRef}`,
    );
  }
  if (
    descriptor.digest &&
    object.customMetadata?.["takosumi-content-digest"] !== descriptor.digest
  ) {
    throw new Error("canonical priorState digest does not match R2 metadata");
  }
  const metadataRunId = object.customMetadata?.["takosumi-run-id"];
  if (
    (descriptor.digest || metadataRunId) &&
    metadataRunId !== descriptor.createdByRunId
  ) {
    throw new Error("canonical priorState creator does not match R2 metadata");
  }
  const metadataGeneration = object.customMetadata?.["takosumi-generation"];
  if (
    (descriptor.digest || metadataGeneration !== undefined) &&
    Number(metadataGeneration) !== descriptor.generation
  ) {
    throw new Error(
      "canonical priorState generation does not match R2 metadata",
    );
  }
  const ciphertextLength = Number(
    object.customMetadata?.["takosumi-ciphertext-length"],
  );
  const metadataDigest = object.customMetadata?.["takosumi-content-digest"];
  if (
    descriptor.legacyDigestMissing &&
    metadataDigest !== undefined &&
    !/^sha256:[0-9a-f]{64}$/u.test(metadataDigest)
  ) {
    throw new Error(
      "legacy canonical priorState has invalid R2 digest metadata",
    );
  }
  const digest = descriptor.digest ?? metadataDigest;
  return {
    pointer: {
      generation: descriptor.generation,
      objectKey: descriptor.stateRef,
      ...(digest ? { digest } : {}),
      runId: descriptor.createdByRunId,
      ...(Number.isFinite(ciphertextLength) ? { ciphertextLength } : {}),
    },
    object,
  };
}

function priorStateGeneration(
  scope: StateScope,
  action: string | undefined,
): number {
  if (action === "apply" || action === "destroy") {
    if (scope.generation < 1) {
      throw new Error(`${action} stateScope generation must be at least one`);
    }
    return scope.generation - 1;
  }
  return scope.generation;
}

function stateRefForGeneration(scope: StateScope, generation: number): string {
  return `${stateScopePrefix(scope)}/${formatGeneration(generation)}.tfstate.enc`;
}

// The R2 key for the encrypted form of an artifact key (spec keys gain `.enc`).
function encryptedKey(key: string): string {
  return `${key}.enc`;
}

function parseStateScope(requestPayload: unknown): StateScope | undefined {
  const scope = recordField(requestPayload, "stateScope");
  if (!scope) return undefined;
  const workspaceId = stringField(scope, "workspaceId");
  const subject = recordField(scope, "subject");
  const subjectKind = subject ? stringField(subject, "kind") : undefined;
  const subjectId = subject ? stringField(subject, "id") : undefined;
  const environment = stringField(scope, "environment");
  const stateRef = stringField(scope, "stateRef");
  const generation = scope.generation;
  const priorState = parseStateVersionDescriptor(scope.priorState);
  if (
    !workspaceId ||
    !(subjectKind === "resource" || subjectKind === "capsule") ||
    !subjectId ||
    !environment ||
    !stateRef ||
    typeof generation !== "number"
  ) {
    throw new Error(
      "stateScope requires workspaceId, a Capsule/Resource subject, environment, stateRef, and a numeric generation",
    );
  }
  return {
    workspaceId,
    subjectKind,
    subjectId,
    environment,
    generation,
    stateRef,
    ...(priorState ? { priorState } : {}),
  };
}

function parseStateVersionDescriptor(
  value: unknown,
): StateVersionDescriptor | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error("stateScope.priorState must be a JSON object");
  }
  const generation = value.generation;
  const stateRef = stringField(value, "stateRef");
  const digest = stringField(value, "digest");
  const legacyDigestMissing = value.legacyDigestMissing === true;
  const createdByRunId = stringField(value, "createdByRunId");
  if (
    !Number.isInteger(generation) ||
    (generation as number) < 0 ||
    !stateRef ||
    Boolean(digest) === legacyDigestMissing ||
    !createdByRunId
  ) {
    throw new Error(
      "stateScope.priorState requires generation, stateRef, createdByRunId, and exactly one of digest or legacyDigestMissing",
    );
  }
  return {
    generation: generation as number,
    stateRef,
    ...(digest ? { digest } : { legacyDigestMissing: true }),
    createdByRunId,
  };
}

function parseRawOutputRef(requestPayload: unknown): string | undefined {
  if (!isRecord(requestPayload)) return undefined;
  const ref = stringField(requestPayload, "rawOutputRef");
  if (!ref) return undefined;
  assertSafeArtifactObjectKey(ref, "raw output");
  return ref;
}

function parseApplyRunId(requestPayload: unknown): string | undefined {
  const applyRun = recordField(requestPayload, "applyRun");
  return applyRun ? stringField(applyRun, "id") : undefined;
}

function parseStateAdoption(
  requestPayload: unknown,
): StateAdoption | undefined {
  const adoption = recordField(requestPayload, "stateAdoption");
  if (!adoption) return undefined;
  const kind = stringField(adoption, "kind");
  const sourceWorkspaceId = stringField(adoption, "sourceWorkspaceId");
  const sourceCapsuleId = stringField(adoption, "sourceCapsuleId");
  const sourceEnvironment = stringField(adoption, "sourceEnvironment");
  const sourceStateVersionId = stringField(adoption, "sourceStateVersionId");
  const stateRef = stringField(adoption, "stateRef");
  const stateDigest = stringField(adoption, "stateDigest");
  const confirmedBy = stringField(adoption, "confirmedBy");
  const confirmedAt = stringField(adoption, "confirmedAt");
  const stateGeneration = adoption.stateGeneration;
  if (
    kind !== "legacy_backing_capsule_state" ||
    !sourceWorkspaceId ||
    !sourceCapsuleId ||
    !sourceEnvironment ||
    !sourceStateVersionId ||
    !stateRef ||
    !stateDigest ||
    !confirmedBy ||
    !confirmedAt ||
    !Number.isInteger(stateGeneration) ||
    (stateGeneration as number) < 0
  ) {
    throw new Error("stateAdoption is incomplete or invalid");
  }
  return {
    kind,
    sourceWorkspaceId,
    sourceCapsuleId,
    sourceEnvironment,
    sourceStateVersionId,
    stateGeneration: stateGeneration as number,
    stateRef,
    stateDigest,
    confirmedBy,
    confirmedAt,
  };
}

function parseSourceArchiveRestore(
  requestPayload: unknown,
): SourceArchiveRestore | undefined {
  const archive = recordField(requestPayload, "sourceArchive");
  if (!archive) return undefined;
  const ref = stringField(archive, "ref");
  const digest = stringField(archive, "digest");
  if (!ref || !digest) return undefined;
  return { ref, digest };
}

// Parse the optional remote_state dependency descriptors off the dispatch
// request. Each entry must carry a name, stateRef, digest, environment,
// capsuleId, and a numeric generation; a malformed entry fails the run closed
// (a remote_state
// edge cannot be silently dropped). Returns [] when the dispatch carries no
// depStates.
function parseDepStates(requestPayload: unknown): readonly DepState[] {
  if (!isRecord(requestPayload)) return [];
  const raw = requestPayload.depStates;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("depStates must be an array");
  }
  return raw.map((entry) => {
    if (!isRecord(entry)) throw new Error("depStates entry must be an object");
    const name = stringField(entry, "name");
    const capsuleId = stringField(entry, "capsuleId");
    const environment = stringField(entry, "environment");
    const stateRef = stringField(entry, "stateRef");
    const digest = stringField(entry, "digest");
    const generation = entry.generation;
    if (
      !name ||
      !capsuleId ||
      !environment ||
      !stateRef ||
      !digest ||
      typeof generation !== "number"
    ) {
      throw new Error(
        "depStates entry requires name, capsuleId, environment, " +
          "stateRef, digest, and a numeric generation",
      );
    }
    return { name, capsuleId, environment, generation, stateRef, digest };
  });
}

function parseRestoreState(requestPayload: unknown): RestoreState | undefined {
  const restoreState = recordField(requestPayload, "restoreState");
  if (!restoreState) return undefined;
  const stateRef = stringField(restoreState, "stateRef");
  const digest = stringField(restoreState, "digest");
  if (!stateRef || !digest) return undefined;
  return { stateRef, digest };
}

function assertRestoreStateRef(scope: StateScope, key: string): void {
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("..") ||
    key.includes("\0") ||
    key.includes("\\") ||
    !key.startsWith("workspaces/") ||
    !key.endsWith(".tfstate.enc")
  ) {
    throw new Error(`unsafe restore state object key: ${key}`);
  }
  if (!key.startsWith(`${stateScopePrefix(scope)}/`)) {
    throw new Error(`restore state object key escapes target prefix: ${key}`);
  }
}

// Re-assert a dependency stateRef is a traversal-free R2_STATE key inside
// the producer environment's state prefix (defense in depth against a crafted
// descriptor pointing at another tenant's object). It must name the
// descriptor's own Capsule and environment.
function assertDepStateRef(depState: DepState): void {
  const key = depState.stateRef;
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("..") ||
    key.includes("\0") ||
    key.includes("\\") ||
    !key.startsWith("workspaces/") ||
    !key.endsWith(".tfstate.enc")
  ) {
    throw new Error(`unsafe dependency state object key: ${key}`);
  }
  const expectedSuffix = `/capsules/${safeKeySegment(
    depState.capsuleId,
  )}/environments/${safeKeySegment(depState.environment)}/state-versions/`;
  if (!key.includes(expectedSuffix)) {
    throw new Error(
      `dependency state object key escapes producer prefix: ${key}`,
    );
  }
}

function isSourceSyncEnvelope(envelope: {
  readonly action: string | undefined;
  readonly request: unknown;
}): boolean {
  if (envelope.action === "source_sync") return true;
  const request = envelope.request;
  return isRecord(request) && stringField(request, "action") === "source_sync";
}

interface ReusableSourceSnapshot {
  readonly id: string;
  readonly archiveRef: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
}

function parseReusableSourceSnapshot(
  requestPayload: unknown,
): ReusableSourceSnapshot | undefined {
  const snapshot = recordField(requestPayload, "reuseSnapshot");
  if (!snapshot) return undefined;
  const archiveRef = requiredStringField(snapshot, "archiveRef");
  assertSafeSourceArchiveKey(archiveRef);
  return {
    id: requiredStringField(snapshot, "id"),
    archiveRef,
    archiveDigest: requiredSha256DigestField(snapshot, "archiveDigest"),
    archiveSizeBytes: positiveIntegerField(snapshot, "archiveSizeBytes"),
  };
}

function sourceSyncArchiveRef(requestPayload: unknown): string {
  if (!isRecord(requestPayload)) {
    throw new Error("source_sync request is required");
  }
  const archiveRef = stringField(requestPayload, "archiveRef");
  if (!archiveRef) {
    throw new Error("source_sync archiveRef is required");
  }
  assertSafeSourceArchiveKey(archiveRef);
  return archiveRef;
}

// Re-assert the R2_SOURCE archive key (agreed layout
// workspaces/{workspaceId}/sources/{sourceId}/snapshots/{snapshotId}/source.tar.zst) is
// a safe, traversal-free relative key before writing to the bucket.
function assertSafeSourceArchiveKey(key: string): void {
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("..") ||
    key.includes("\0") ||
    key.includes("\\") ||
    !key.startsWith("workspaces/")
  ) {
    throw new Error(`unsafe source archive object key: ${key}`);
  }
}

function assertSafeSourceArchiveRestoreKey(key: string): void {
  try {
    assertSafeSourceArchiveKey(key);
  } catch (error) {
    if (isLegacySourceArchiveRestoreRef(key)) return;
    throw error;
  }
}

function assertSafeArtifactObjectKey(key: string, label: string): void {
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("..") ||
    key.includes("\0") ||
    key.includes("\\") ||
    /\s/u.test(key)
  ) {
    throw new Error(`unsafe ${label} artifact ref`);
  }
}

function requiredSha256DigestField(
  value: Record<string, unknown>,
  key: string,
): `sha256:${string}` {
  const digest = requiredStringField(value, key).toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(`${key} must be a sha256 digest`);
  }
  return digest as `sha256:${string}`;
}

function positiveIntegerField(
  value: Record<string, unknown>,
  key: string,
): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return field;
}

function planArtifactKey(runId: string, scope?: StateScope): string {
  if (scope) {
    const collection =
      scope.subjectKind === "resource" ? "resources" : "capsules";
    return `workspaces/${safeKeySegment(scope.workspaceId)}/${collection}/${safeKeySegment(
      scope.subjectId,
    )}/runs/${safeKeySegment(runId)}/plan.bin`;
  }
  return `opentofu-plan-runs/${runId.replace(/[^a-zA-Z0-9._-]+/g, "_")}/tfplan`;
}

function planJsonArtifactKey(runId: string, scope?: StateScope): string {
  if (scope) {
    const collection =
      scope.subjectKind === "resource" ? "resources" : "capsules";
    return `workspaces/${safeKeySegment(scope.workspaceId)}/${collection}/${safeKeySegment(
      scope.subjectId,
    )}/runs/${safeKeySegment(runId)}/plan.json.zst`;
  }
  return `opentofu-plan-runs/${runId.replace(
    /[^a-zA-Z0-9._-]+/g,
    "_",
  )}/tfplan.json`;
}

function planArtifactRef(bucket: string, key: string): string {
  return `r2://${bucket}/${key}`;
}

function planArtifactKeyFromRef(ref: string, bucket: string): string {
  const prefix = `r2://${bucket}/`;
  if (!ref.startsWith(prefix)) {
    throw new Error(`unsupported plan artifact ref: ${ref}`);
  }
  const key = ref.slice(prefix.length);
  const canonical =
    /^workspaces\/[^/]+\/(?:capsules|resources)\/[^/]+\/runs\/[^/]+\/plan\.bin$/.test(
      key,
    );
  if (
    (!canonical && !key.startsWith("opentofu-plan-runs/")) ||
    key.includes("..")
  ) {
    throw new Error(`unsafe plan artifact key: ${key}`);
  }
  return key;
}

function zstdCompressRaw(input: Uint8Array): Uint8Array {
  if (input.byteLength > 0xffffffff) {
    throw new Error("plan JSON exceeds the portable zstd encoder limit");
  }
  const chunks: Uint8Array[] = [
    new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]),
    new Uint8Array([0xa0]),
    uint32le(input.byteLength),
  ];
  const maxBlockSize = 128 * 1024;
  for (
    let offset = 0;
    offset < input.byteLength || offset === 0;
    offset += maxBlockSize
  ) {
    const end = Math.min(offset + maxBlockSize, input.byteLength);
    const block = input.slice(offset, end);
    const last = end >= input.byteLength ? 1 : 0;
    chunks.push(uint24le((block.byteLength << 3) | last));
    chunks.push(block);
    if (input.byteLength === 0) break;
  }
  return concatBytes(chunks);
}

function uint32le(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function uint24le(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
  ]);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function stateArtifactKeys(
  requestPayload: unknown,
): Promise<readonly string[]> {
  const planRun = recordField(requestPayload, "planRun");
  if (!planRun) return [];
  const backendKey = await stateBackendKey(requestPayload);
  const keys: string[] = [];
  const capsuleId = stringField(planRun, "capsuleId");
  if (capsuleId) {
    keys.push(
      `${backendKey}/capsules/${safeKeySegment(capsuleId)}/terraform.tfstate`,
    );
  }
  const source = recordField(planRun, "source");
  const sourceKey = await sourceStateKey({
    backendKey,
    // `workspaceId` here is the frozen `sourceIdentity` digest field.
    workspaceId: stringField(planRun, "workspaceId"),
    runnerProfileId: stringField(planRun, "runnerProfileId"),
    source,
  });
  if (sourceKey) keys.push(sourceKey);
  return Array.from(new Set(keys));
}

async function sourceStateKey(input: {
  readonly backendKey: string;
  readonly workspaceId: string | undefined;
  readonly runnerProfileId: string | undefined;
  readonly source: Record<string, unknown> | undefined;
}): Promise<string | undefined> {
  if (!input.workspaceId || !input.runnerProfileId || !input.source)
    return undefined;
  const sourceIdentity = {
    workspaceId: input.workspaceId,
    runnerProfileId: input.runnerProfileId,
    kind: stringField(input.source, "kind"),
    url: stringField(input.source, "url"),
    path: stringField(input.source, "path"),
    modulePath: stringField(input.source, "modulePath") ?? "",
  };
  const digest = await digestText(JSON.stringify(sourceIdentity));
  return `${input.backendKey}/sources/${digest.slice("sha256:".length)}/terraform.tfstate`;
}

async function stateBackendKey(requestPayload: unknown): Promise<string> {
  const runnerProfile = recordField(requestPayload, "runnerProfile");
  const stateBackend = recordField(runnerProfile, "stateBackend");
  const ref = stateBackend
    ? (stringField(stateBackend, "ref") ?? stringField(stateBackend, "kind"))
    : undefined;
  if (!ref) {
    const planRun = recordField(requestPayload, "planRun");
    const runnerProfileId = planRun
      ? stringField(planRun, "runnerProfileId")
      : undefined;
    return `opentofu-state/backends/${safeKeySegment(runnerProfileId ?? "default")}`;
  }
  const digest = await digestText(ref);
  return `opentofu-state/backends/${digest.slice("sha256:".length)}`;
}

function safeKeySegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function parseRunEnvelope(bodyText: string): {
  readonly action: string | undefined;
  readonly request: unknown;
} {
  const body = JSON.parse(bodyText) as unknown;
  if (!isRecord(body)) return { action: undefined, request: undefined };
  return {
    action: stringField(body, "action"),
    request: body.request,
  };
}

function isRunnerMutationAction(
  action: string | undefined,
): action is RunnerMutationAction {
  return action === "apply" || action === "destroy";
}

function parseRunnerMutationDispatchRecord(
  value: unknown,
): RunnerMutationDispatchRecord | undefined {
  if (!isRecord(value)) return undefined;
  const action = stringField(value, "action");
  const semanticDigest = stringField(value, "semanticDigest");
  const phase = stringField(value, "phase");
  if (
    value.kind !== "takosumi.runner-mutation-dispatch@v2" ||
    !isRunnerMutationAction(action) ||
    !semanticDigest ||
    !/^sha256:[0-9a-f]{64}$/u.test(semanticDigest) ||
    (phase !== "preparing" &&
      phase !== "dispatched" &&
      phase !== "indeterminate" &&
      phase !== "orphaned") ||
    value.redispatchBlocked !== true
  ) {
    return undefined;
  }
  return {
    kind: "takosumi.runner-mutation-dispatch@v2",
    action,
    semanticDigest,
    phase,
    redispatchBlocked: true,
  };
}

function parseRunnerReleaseDispatchRecord(
  value: unknown,
): RunnerReleaseDispatchRecord | undefined {
  if (!isRecord(value)) return undefined;
  const releaseRunId = stringField(value, "releaseRunId");
  const applyRunId = stringField(value, "applyRunId");
  const actionIds = value.actionIds;
  const semanticDigest = stringField(value, "semanticDigest");
  const phase = stringField(value, "phase");
  if (
    value.kind !== "takosumi.runner-release-dispatch@v1" ||
    !releaseRunId ||
    !applyRunId ||
    !Array.isArray(actionIds) ||
    actionIds.length === 0 ||
    actionIds.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(actionIds).size !== actionIds.length ||
    !semanticDigest ||
    !/^sha256:[0-9a-f]{64}$/u.test(semanticDigest) ||
    (phase !== "preparing" &&
      phase !== "dispatched" &&
      phase !== "completed" &&
      phase !== "indeterminate") ||
    value.redispatchBlocked !== true
  ) {
    return undefined;
  }
  const outcome = parseRunnerReleaseCompletedOutcome(value.outcome);
  if (
    (phase === "completed" && !outcome) ||
    (phase !== "completed" && value.outcome !== undefined) ||
    (outcome?.status === "failed" &&
      outcome.failedCommandId !== undefined &&
      !actionIds.includes(outcome.failedCommandId))
  ) {
    return undefined;
  }
  return {
    kind: "takosumi.runner-release-dispatch@v1",
    releaseRunId,
    applyRunId,
    actionIds: [...actionIds] as string[],
    semanticDigest,
    phase,
    redispatchBlocked: true,
    ...(outcome ? { outcome } : {}),
  };
}

function parseRunnerReleaseCompletedOutcome(
  value: unknown,
): RunnerReleaseCompletedOutcome | undefined {
  if (!isRecord(value)) return undefined;
  const status = stringField(value, "status");
  const exitCode = value.exitCode;
  const commandCount = value.commandCount;
  const failedCommandId = stringField(value, "failedCommandId");
  if (
    (status !== "succeeded" && status !== "failed") ||
    typeof exitCode !== "number" ||
    !Number.isSafeInteger(exitCode) ||
    typeof commandCount !== "number" ||
    !Number.isSafeInteger(commandCount) ||
    commandCount < 0 ||
    (status === "succeeded" && exitCode !== 0) ||
    (status === "failed" && exitCode === 0)
  ) {
    return undefined;
  }
  return {
    status,
    exitCode,
    commandCount,
    ...(failedCommandId ? { failedCommandId } : {}),
    ...(status === "failed"
      ? (() => {
          const detail = normalizedReleaseCommandFailureDetail(value);
          return detail ? { detail } : {};
        })()
      : {}),
  };
}

function sameReleaseDispatchIdentity(
  left: RunnerReleaseDispatchRecord,
  right: RunnerReleaseDispatchRecord,
): boolean {
  return (
    left.releaseRunId === right.releaseRunId &&
    left.applyRunId === right.applyRunId &&
    sameOrderedStrings(left.actionIds, right.actionIds) &&
    left.semanticDigest === right.semanticDigest
  );
}

async function runnerReleaseSemanticIdentity(
  releaseRunId: string,
  requestPayload: unknown,
  env: CloudflareWorkerEnv,
): Promise<{
  readonly applyRunId: string;
  readonly actionIds: readonly string[];
  readonly semanticDigest: string;
}> {
  if (!isRecord(requestPayload)) {
    throw new Error("runner release request must be an object");
  }
  const activation = recordField(requestPayload, "activation");
  const applyRunId = activation && stringField(activation, "applyRunId");
  const workspaceId = activation && stringField(activation, "workspaceId");
  const capsuleId = activation && stringField(activation, "capsuleId");
  const stateVersionId = activation && stringField(activation, "stateVersionId");
  const sourceSnapshotId =
    activation && stringField(activation, "sourceSnapshotId");
  const sourceCommit = activation && stringField(activation, "sourceCommit");
  if (
    !applyRunId ||
    !workspaceId ||
    !capsuleId ||
    !stateVersionId ||
    !sourceSnapshotId ||
    !sourceCommit
  ) {
    throw new Error(
      "runner release requires exact ApplyRun, Workspace, Capsule, StateVersion, and SourceSnapshot authority",
    );
  }
  if (`release_${safeKeySegment(applyRunId)}` !== releaseRunId) {
    throw new Error("runner release id does not match activation.applyRunId");
  }
  const release = recordField(requestPayload, "release");
  const commands = release?.commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error("runner release requires immutable command actions");
  }
  const actionIds = commands.map((command) => {
    if (!isRecord(command) || !stringField(command, "id")) {
      throw new Error("runner release command action requires an id");
    }
    return stringField(command, "id")!;
  });
  if (new Set(actionIds).size !== actionIds.length) {
    throw new Error("runner release command action ids must be unique");
  }
  const request: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(requestPayload)) {
    if (key === "runtimeSecrets") {
      request[key] = runnerReleaseRuntimeSecretSemantics(value);
      continue;
    }
    if (key === "credentials") {
      request[key] = await runnerReleaseCredentialSemantics(
        value,
        activation!,
        env,
      );
      continue;
    }
    request[key] = value;
  }
  return {
    applyRunId,
    actionIds,
    semanticDigest: await digestText(
      canonicalRunnerMutationJson({
        kind: "takosumi.runner-release-semantics@v1",
        releaseRunId,
        applyRunId,
        request,
      }),
    ),
  };
}

function runnerReleaseRuntimeSecretSemantics(value: unknown): unknown {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    throw new Error("runner release runtime secret dispatch must be an object");
  }
  const contract = stringField(value, "contract");
  const profileDigest = stringField(value, "profileDigest");
  const files = value.files;
  if (
    contract !== "takosumi.runner-runtime-secret-files/v1" ||
    !profileDigest ||
    !/^sha256:[0-9a-f]{64}$/u.test(profileDigest) ||
    !Array.isArray(files) ||
    files.length !== 1
  ) {
    throw new Error("runner release runtime secret profile is invalid");
  }
  const file = files[0];
  if (!isRecord(file)) {
    throw new Error("runner release runtime secret file is invalid");
  }
  const path = stringField(file, "path");
  const envName = stringField(file, "envName");
  const secretNames = file.secretNames;
  if (
    !path ||
    !envName ||
    file.mode !== 0o600 ||
    typeof file.content !== "string" ||
    !Array.isArray(secretNames) ||
    secretNames.length === 0 ||
    secretNames.some((name) => typeof name !== "string" || name.length === 0)
  ) {
    throw new Error("runner release runtime secret file profile is invalid");
  }
  return {
    contract,
    profileDigest,
    files: [
      {
        path,
        mode: 0o600,
        envName,
        secretNames: [...secretNames],
      },
    ],
  };
}

async function runnerReleaseCredentialSemantics(
  value: unknown,
  activation: Readonly<Record<string, unknown>>,
  env: CloudflareWorkerEnv,
): Promise<unknown> {
  if (!isRecord(value)) {
    throw new Error("runner release credentials must be an object");
  }
  const rawEnv = recordField(value, "env") ?? {};
  if (Object.values(rawEnv).some((entry) => typeof entry !== "string")) {
    throw new Error("runner release credential env must contain strings");
  }
  const rawFiles = value.files;
  if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
    throw new Error("runner release credential files must be an array");
  }
  const files = (Array.isArray(rawFiles) ? rawFiles : []).map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("runner release credential file must be an object");
    }
    const path = stringField(entry, "path");
    const content = stringField(entry, "content");
    const mode = entry.mode;
    if (!path || content === undefined || typeof mode !== "number") {
      throw new Error(
        "runner release credential file requires path, mode, and content",
      );
    }
    return {
      path,
      mode,
      ...(stringField(entry, "envName")
        ? { envName: stringField(entry, "envName")! }
        : {}),
    };
  });
  const deliveries = [
    ...Object.entries(rawEnv).map(([name, entry]) => ({
      delivery: `env:${name}`,
      value: entry as string,
    })),
    ...(Array.isArray(rawFiles)
      ? rawFiles.flatMap((entry) =>
          isRecord(entry) &&
          typeof entry.path === "string" &&
          typeof entry.content === "string"
            ? [{ delivery: `file:${entry.path}`, value: entry.content }]
            : [],
        )
      : []),
  ];
  const signedTokenDeliveries = new Map<string, Set<string>>();
  for (const entry of deliveries) {
    if (!isRunCredentialToken(entry.value)) continue;
    const tokenDeliveries =
      signedTokenDeliveries.get(entry.value) ?? new Set<string>();
    tokenDeliveries.add(entry.delivery);
    signedTokenDeliveries.set(entry.value, tokenDeliveries);
  }
  const authorities: RunnerVerifiedCredentialAuthority[] = [];
  if (signedTokenDeliveries.size > 0) {
    const secret = runCredentialTokenSecret(env as Record<string, unknown>);
    if (!secret) {
      throw new Error("Run credential verification authority is unavailable");
    }
    const bindings = mutationCredentialManifestBindings(value);
    const signingAuthorityDigest = await digestText(secret);
    const workspaceId = stringField(activation, "workspaceId");
    const capsuleId = stringField(activation, "capsuleId");
    const applyRunId = stringField(activation, "applyRunId");
    if (!workspaceId || !capsuleId || !applyRunId) {
      throw new Error(
        "signed release credentials require exact ApplyRun Workspace and Capsule context",
      );
    }
    for (const [token, tokenDeliveries] of signedTokenDeliveries) {
      const verified = await verifyRunCredentialTokenAuthority(token, { secret });
      if (!verified.ok) {
        throw new Error(`Run credential verification failed: ${verified.reason}`);
      }
      const payload = verified.payload;
      if (
        (payload.phase !== "apply" && payload.phase !== "destroy") ||
        payload.workspaceId !== workspaceId ||
        payload.capsuleId !== capsuleId ||
        payload.runId !== applyRunId ||
        payload.sub !== payload.installingPrincipalId
      ) {
        throw new Error(
          "signed Run credential authority mismatches the release activation",
        );
      }
      if (
        !bindings.some(
          (binding) =>
            stringField(binding, "connectionId") === payload.connectionId &&
            stringField(binding, "providerSource") === payload.provider,
        )
      ) {
        throw new Error(
          "signed Run credential authority mismatches the credential manifest",
        );
      }
      authorities.push({
        kind: "takosumi.run-credential-authority@v1",
        tokenType: payload.typ,
        tokenVersion: payload.v,
        signingAuthorityDigest,
        audience: payload.aud,
        subject: payload.sub,
        workspaceId: payload.workspaceId,
        capsuleId: payload.capsuleId,
        runId: payload.runId,
        installingPrincipalId: payload.installingPrincipalId,
        connectionId: payload.connectionId,
        provider: payload.provider,
        phase: payload.phase,
        scopes: [...payload.scopes].sort(),
        deliveries: [...tokenDeliveries].sort(),
      });
    }
  }
  return {
    envNames: Object.keys(rawEnv).sort(),
    files: files.sort((left, right) =>
      canonicalRunnerMutationJson(left).localeCompare(
        canonicalRunnerMutationJson(right),
      ),
    ),
    manifest: value.manifest ?? null,
    authorities: authorities.sort((left, right) =>
      canonicalRunnerMutationJson(left).localeCompare(
        canonicalRunnerMutationJson(right),
      ),
    ),
    opaqueMaterialDigests: (
      await Promise.all(
        deliveries
          .filter((entry) => !isRunCredentialToken(entry.value))
          .map(async (entry) => ({
            delivery: entry.delivery,
            materialDigest: await digestText(
              canonicalRunnerMutationJson({
                kind: "takosumi.runner-release-opaque-credential@v1",
                delivery: entry.delivery,
                material: entry.value,
              }),
            ),
          })),
      )
    ).sort((left, right) => left.delivery.localeCompare(right.delivery)),
  };
}

function releaseCompletedOutcome(
  payload: Record<string, unknown>,
  record: RunnerReleaseDispatchRecord,
): RunnerReleaseCompletedOutcome {
  if (
    stringField(payload, "runId") !== record.releaseRunId ||
    stringField(payload, "action") !== "release"
  ) {
    throw new Error("runner release response identity does not match dispatch");
  }
  const outcome = parseRunnerReleaseCompletedOutcome({
    ...payload,
    commandCount:
      typeof payload.commandCount === "number"
        ? payload.commandCount
        : record.actionIds.length,
  });
  if (!outcome || outcome.commandCount !== record.actionIds.length) {
    throw new Error("runner release response has no terminal outcome");
  }
  if (
    outcome.status !== "failed" ||
    (stringField(payload, "phase") === "release" &&
      outcome.failedCommandId !== undefined &&
      record.actionIds.includes(outcome.failedCommandId))
  ) {
    return outcome;
  }
  // A failed setup/validation/runtime-secret path is still a completed,
  // one-shot release outcome, but it is not evidence that a release command
  // reached a terminal response. Strip command detail and the untrusted id so
  // the normalization boundary keeps the historical runner_rejected fallback.
  return {
    status: outcome.status,
    exitCode: outcome.exitCode,
    commandCount: outcome.commandCount,
  };
}

function sameOrderedStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function runnerCompletedReleaseResponse(
  record: RunnerReleaseDispatchRecord,
): Response {
  const outcome = record.outcome;
  if (!outcome) return runnerReleaseIndeterminateResponse();
  return Response.json(
    {
      runId: record.releaseRunId,
      action: "release",
      status: outcome.status,
      exitCode: outcome.exitCode,
      commandCount: outcome.commandCount,
      ...(outcome.failedCommandId
        ? { failedCommandId: outcome.failedCommandId }
        : {}),
      ...(outcome.status === "failed"
        ? {
            phase: "release",
            ...(outcome.failedCommandId
              ? {
                  errorCode: RUNNER_RELEASE_COMMAND_FAILED_CODE,
                  ...(outcome.detail ? { detail: outcome.detail } : {}),
                }
              : {}),
            stderr:
              "release command previously completed with a failed outcome; automatic redispatch is blocked",
          }
        : {}),
    },
    { status: outcome.status === "succeeded" ? 200 : 500 },
  );
}

function runnerReleaseIndeterminateResponse(): Response {
  return Response.json(
    {
      error: "OpenTofu runner release outcome is indeterminate",
      errorCode: RUNNER_MUTATION_INDETERMINATE_CODE,
      status: "failed",
      phase: "release",
      retryable: false,
      outcome: "indeterminate",
      evidence: {
        kind: RUNNER_MUTATION_INDETERMINATE_CODE,
        action: "release",
        redispatchBlocked: true,
      },
      detail:
        "release mutation may have occurred; automatic redispatch is blocked until authoritative repair confirms the outcome",
    },
    {
      status: 409,
      headers: { [RUNNER_MUTATION_INDETERMINATE_HEADER]: "1" },
    },
  );
}

const MUTABLE_RUN_EVIDENCE_FIELDS = new Set([
  "auditEvents",
  "createdAt",
  "diagnostics",
  "finishedAt",
  "heartbeatAt",
  "startedAt",
  "status",
  "updatedAt",
]);

interface RunnerVerifiedCredentialAuthority {
  readonly kind: "takosumi.run-credential-authority@v1";
  readonly tokenType: string;
  readonly tokenVersion: number;
  /** Nested only in the semantic hash; the signer secret is never persisted. */
  readonly signingAuthorityDigest: string;
  readonly audience: string;
  readonly subject: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly runId: string;
  readonly installingPrincipalId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly phase: "apply" | "destroy";
  readonly scopes: readonly string[];
  readonly deliveries: readonly string[];
}

async function runnerMutationSemanticDigest(
  runId: string,
  action: RunnerMutationAction,
  requestPayload: unknown,
  env: CloudflareWorkerEnv,
): Promise<string> {
  if (!isRecord(requestPayload)) {
    throw new Error("runner mutation request must be an object");
  }
  const request: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(requestPayload)) {
    if (key === "credentials") continue;
    if (key === "applyRun" || key === "planRun") {
      request[key] = stableMutationRunEvidence(value, key);
      continue;
    }
    request[key] = value;
  }
  request.credentials = await runnerMutationCredentialSemantics(
    requestPayload.credentials,
    requestPayload,
    action,
    env,
  );
  return await digestText(
    canonicalRunnerMutationJson({
      kind: "takosumi.runner-mutation-semantics@v2",
      runId,
      action,
      request,
    }),
  );
}

function stableMutationRunEvidence(value: unknown, label: string): unknown {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const stable: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (MUTABLE_RUN_EVIDENCE_FIELDS.has(key)) continue;
    if (key === "stateLock" && isRecord(entry)) {
      stable.stateLock = {
        ...(stringField(entry, "backendRef")
          ? { backendRef: stringField(entry, "backendRef")! }
          : {}),
        ...(stringField(entry, "lockRef")
          ? { lockRef: stringField(entry, "lockRef")! }
          : {}),
      };
      continue;
    }
    stable[key] = entry;
  }
  return stable;
}

async function runnerMutationCredentialSemantics(
  value: unknown,
  requestPayload: Readonly<Record<string, unknown>>,
  action: RunnerMutationAction,
  env: CloudflareWorkerEnv,
): Promise<unknown> {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    throw new Error("runner mutation credentials must be an object");
  }
  const rawEnv = recordField(value, "env") ?? {};
  const envNames = Object.keys(rawEnv).sort();
  if (Object.values(rawEnv).some((entry) => typeof entry !== "string")) {
    throw new Error("runner mutation credential env must contain strings");
  }
  const rawFiles = value.files;
  if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
    throw new Error("runner mutation credential files must be an array");
  }
  const fileSemantics = (Array.isArray(rawFiles) ? rawFiles : []).map(
    (entry) => {
      if (!isRecord(entry)) {
        throw new Error("runner mutation credential file must be an object");
      }
      const path = stringField(entry, "path");
      const content = stringField(entry, "content");
      const mode = entry.mode;
      if (!path || content === undefined || typeof mode !== "number") {
        throw new Error(
          "runner mutation credential file requires path, mode, and content",
        );
      }
      return {
        path,
        mode,
        ...(stringField(entry, "envName")
          ? { envName: stringField(entry, "envName")! }
          : {}),
      };
    },
  );
  const secretEntries = [
    ...Object.entries(rawEnv).map(([name, entry]) => ({
      delivery: `env:${name}`,
      value: entry as string,
    })),
    ...(Array.isArray(rawFiles)
      ? rawFiles.flatMap((entry) =>
          isRecord(entry) &&
          typeof entry.path === "string" &&
          typeof entry.content === "string"
            ? [{ delivery: `file:${entry.path}`, value: entry.content }]
            : [],
        )
      : []),
  ];
  const signedTokenDeliveries = new Map<string, Set<string>>();
  for (const entry of secretEntries) {
    if (!isRunCredentialToken(entry.value)) continue;
    const deliveries = signedTokenDeliveries.get(entry.value) ?? new Set();
    deliveries.add(entry.delivery);
    signedTokenDeliveries.set(entry.value, deliveries);
  }
  const staticMaterialDigests = await Promise.all(
    secretEntries
      .filter((entry) => !isRunCredentialToken(entry.value))
      .map(async (entry) => ({
        delivery: entry.delivery,
        digest: await digestText(entry.value),
      })),
  );
  const authorities = await verifiedRunnerCredentialAuthorities(
    signedTokenDeliveries,
    requestPayload,
    action,
    value,
    env,
  );
  return {
    envNames,
    files: fileSemantics.sort((left, right) =>
      canonicalRunnerMutationJson(left).localeCompare(
        canonicalRunnerMutationJson(right),
      ),
    ),
    manifest: value.manifest ?? null,
    authorities,
    staticMaterialDigests: staticMaterialDigests.sort((left, right) =>
      left.delivery.localeCompare(right.delivery),
    ),
  };
}

async function verifiedRunnerCredentialAuthorities(
  tokenDeliveries: ReadonlyMap<string, ReadonlySet<string>>,
  requestPayload: Readonly<Record<string, unknown>>,
  action: RunnerMutationAction,
  credentials: Readonly<Record<string, unknown>>,
  env: CloudflareWorkerEnv,
): Promise<readonly RunnerVerifiedCredentialAuthority[]> {
  if (tokenDeliveries.size === 0) return [];
  const secret = runCredentialTokenSecret(env as Record<string, unknown>);
  if (!secret) {
    throw new Error("Run credential verification authority is unavailable");
  }
  const context = mutationCredentialExpectedContext(requestPayload, action);
  const bindings = mutationCredentialManifestBindings(credentials);
  const signingAuthorityDigest = await digestText(secret);
  const authorities: RunnerVerifiedCredentialAuthority[] = [];
  for (const [token, deliveries] of tokenDeliveries) {
    const verified = await verifyRunCredentialTokenAuthority(token, { secret });
    if (!verified.ok) {
      throw new Error(`Run credential verification failed: ${verified.reason}`);
    }
    assertMutationCredentialAuthority(verified.payload, context, bindings);
    authorities.push({
      kind: "takosumi.run-credential-authority@v1",
      tokenType: verified.payload.typ,
      tokenVersion: verified.payload.v,
      signingAuthorityDigest,
      audience: verified.payload.aud,
      subject: verified.payload.sub,
      workspaceId: verified.payload.workspaceId,
      capsuleId: verified.payload.capsuleId,
      runId: verified.payload.runId,
      installingPrincipalId: verified.payload.installingPrincipalId,
      connectionId: verified.payload.connectionId,
      provider: verified.payload.provider,
      phase: action,
      scopes: [...verified.payload.scopes].sort(),
      deliveries: [...deliveries].sort(),
    });
  }
  return authorities.sort((left, right) =>
    canonicalRunnerMutationJson(left).localeCompare(
      canonicalRunnerMutationJson(right),
    ),
  );
}

function mutationCredentialExpectedContext(
  requestPayload: Readonly<Record<string, unknown>>,
  action: RunnerMutationAction,
): {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly runId: string;
  readonly action: RunnerMutationAction;
} {
  const applyRun = recordField(requestPayload, "applyRun");
  const planRun = recordField(requestPayload, "planRun");
  const workspaceId = applyRun && stringField(applyRun, "workspaceId");
  const capsuleId =
    (applyRun && stringField(applyRun, "capsuleId")) ??
    (planRun && stringField(planRun, "capsuleId"));
  const runId = applyRun && stringField(applyRun, "id");
  if (!workspaceId || !capsuleId || !runId) {
    throw new Error(
      "signed Run credentials require exact ApplyRun Workspace and Capsule context",
    );
  }
  if (
    planRun &&
    ((stringField(planRun, "workspaceId") !== undefined &&
      stringField(planRun, "workspaceId") !== workspaceId) ||
      (stringField(planRun, "capsuleId") !== undefined &&
        stringField(planRun, "capsuleId") !== capsuleId))
  ) {
    throw new Error("signed Run credential context mismatches the PlanRun");
  }
  return { workspaceId, capsuleId, runId, action };
}

function mutationCredentialManifestBindings(
  credentials: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  const manifest = recordField(credentials, "manifest");
  const bindings = manifest?.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error("signed Run credentials require a credential manifest");
  }
  return bindings.map((binding) => {
    if (!isRecord(binding)) {
      throw new Error("credential manifest binding must be an object");
    }
    return binding;
  });
}

function assertMutationCredentialAuthority(
  payload: RunCredentialTokenPayload,
  context: ReturnType<typeof mutationCredentialExpectedContext>,
  bindings: readonly Readonly<Record<string, unknown>>[],
): void {
  if (
    payload.workspaceId !== context.workspaceId ||
    payload.capsuleId !== context.capsuleId ||
    payload.runId !== context.runId ||
    payload.phase !== context.action ||
    payload.sub !== payload.installingPrincipalId
  ) {
    throw new Error("signed Run credential authority mismatches the mutation");
  }
  if (
    !bindings.some(
      (binding) =>
        stringField(binding, "connectionId") === payload.connectionId &&
        stringField(binding, "providerSource") === payload.provider,
    )
  ) {
    throw new Error(
      "signed Run credential authority mismatches the credential manifest",
    );
  }
}

function canonicalRunnerMutationJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalRunnerMutationJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalRunnerMutationJson(value[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("runner mutation identity must be canonical JSON");
}

function runnerMutationIndeterminateResponse(
  action: RunnerMutationAction,
): Response {
  const payload: RunnerMutationIndeterminatePayload = {
    error: "OpenTofu runner mutation outcome is indeterminate",
    errorCode: RUNNER_MUTATION_INDETERMINATE_CODE,
    status: "failed",
    phase: action,
    retryable: false,
    outcome: "indeterminate",
    evidence: {
      kind: RUNNER_MUTATION_INDETERMINATE_CODE,
      action,
      redispatchBlocked: true,
    },
    detail:
      "provider mutation may have occurred; automatic redispatch is blocked until an authoritative reconcile or adopt path confirms the outcome",
  };
  return Response.json(payload, {
    status: 409,
    headers: { [RUNNER_MUTATION_INDETERMINATE_HEADER]: "1" },
  });
}

function runnerProviderExecutionFailed(
  payload: Record<string, unknown>,
): boolean {
  const failure = recordField(payload, "providerExecutionFailure");
  return (
    isRecord(failure) &&
    stringField(failure, "kind") === "provider_execution_failed"
  );
}

function providerFailureErrorCode(
  payload: Record<string, unknown>,
): "apply_failed" | typeof RUNNER_PROVIDER_EXECUTION_FAILED_CODE | undefined {
  const value = stringField(payload, "errorCode");
  return value && RUNNER_PROVIDER_FAILURE_CODES.has(value)
    ? (value as "apply_failed" | typeof RUNNER_PROVIDER_EXECUTION_FAILED_CODE)
    : undefined;
}

function failedProviderExecutionPayload(
  payload: Record<string, unknown>,
  action: "apply" | "destroy",
  statePersistence: "persisted" | "unavailable",
  state?: Record<string, unknown>,
): Record<string, unknown> {
  const errorCode =
    providerFailureErrorCode(payload) ?? RUNNER_PROVIDER_EXECUTION_FAILED_CODE;
  const detail = normalizedRunnerExecutionFailureDetail(payload, errorCode);
  return {
    status: "failed",
    phase: action,
    errorCode,
    providerExecutionFailure: {
      kind: "provider_execution_failed",
      statePersistence,
    },
    ...(detail ? { detail } : {}),
    ...(state ? { state } : {}),
  };
}

async function readJsonObject(
  response: Response,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const text = new TextDecoder().decode(
    await readBoundedResponseBytes(response, "runner_response", maxBytes),
  );
  const value = text.length > 0 ? (JSON.parse(text) as unknown) : {};
  if (isRecord(value)) return value;
  throw new Error("OpenTofu runner response must be a JSON object");
}

async function normalizeRunnerFailureResponse(
  response: Response,
  phase: string | undefined,
  maxBytes: number,
  releaseActionIds?: readonly string[],
): Promise<Response> {
  let payload: Record<string, unknown> = {};
  try {
    payload = await readJsonObject(response.clone(), maxBytes);
  } catch {
    // The failure envelope below is intentionally finite even when the
    // provider returned malformed or non-JSON text.
  }
  const errorCode = finiteRunnerFailureCode(payload, phase, releaseActionIds);
  if (errorCode === RUNNER_MUTATION_INDETERMINATE_CODE) {
    return runnerMutationIndeterminateResponse(
      phase === "apply" || phase === "destroy" ? phase : "apply",
    );
  }
  const detail = normalizedRunnerExecutionFailureDetail(payload, errorCode);
  const terminalReleaseFailure =
    errorCode === RUNNER_RELEASE_COMMAND_FAILED_CODE;
  return jsonResponse(
    {
      status: "failed",
      errorCode,
      phase: runnerFailurePhase(phase),
      ...(terminalReleaseFailure &&
      typeof payload.exitCode === "number" &&
      Number.isSafeInteger(payload.exitCode)
        ? { exitCode: payload.exitCode }
        : {}),
      ...(terminalReleaseFailure && stringField(payload, "failedCommandId")
        ? { failedCommandId: stringField(payload, "failedCommandId")! }
        : {}),
      ...(detail ? { detail } : {}),
      ...(errorCode === "runner_artifact_relay_ambiguous"
        ? { retryable: true }
        : {}),
    },
    response.status,
  );
}

function normalizedRunnerExecutionFailureDetail(
  payload: Record<string, unknown>,
  errorCode: ReturnType<typeof finiteRunnerFailureCode>,
): string | undefined {
  if (errorCode === RUNNER_RELEASE_COMMAND_FAILED_CODE) {
    return normalizedReleaseCommandFailureDetail(payload);
  }
  if (
    !RUNNER_PLAN_EXECUTION_FAILURE_CODES.has(errorCode) &&
    !RUNNER_PROVIDER_FAILURE_CODES.has(errorCode)
  ) {
    return undefined;
  }
  const detail = [
    stringField(payload, "stderr"),
    stringField(payload, "stdout"),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim();
  if (!detail) return undefined;
  const boundedSource = RUNNER_PROVIDER_FAILURE_CODES.has(errorCode)
    ? detail
        .split(/\r?\n/u)
        .filter((line) => !UNSAFE_PROVIDER_FAILURE_DETAIL_LINE.test(line))
        .join("\n")
        .trim()
    : detail;
  if (!boundedSource) return undefined;
  const redacted = redactString(boundedSource, {
    redactedValue: "[redacted]",
  });
  return boundedRunnerFailureDetail(
    redacted,
    MAX_NORMALIZED_RUNNER_FAILURE_DETAIL_CHARS,
  );
}

function normalizedReleaseCommandFailureDetail(
  payload: Record<string, unknown>,
): string | undefined {
  const detail = [
    stringField(payload, "detail"),
    stringField(payload, "stderr"),
    stringField(payload, "stdout"),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim();
  if (!detail) return undefined;
  return boundedRunnerFailureDetail(
    redactString(detail, { redactedValue: "[redacted]" }),
    MAX_NORMALIZED_RUNNER_FAILURE_DETAIL_CHARS,
  );
}

function boundedRunnerFailureDetail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const omission = "\n... diagnostics omitted ...\n";
  if (maxLength <= omission.length) return text.slice(0, maxLength);
  const retainedLength = maxLength - omission.length;
  const headLength = Math.ceil(retainedLength / 2);
  const tailLength = retainedLength - headLength;
  return `${text.slice(0, headLength)}${omission}${text.slice(-tailLength)}`;
}

function finiteRunnerFailureCode(
  payload: Record<string, unknown>,
  phase?: string,
  releaseActionIds?: readonly string[],
):
  | typeof RUNNER_REJECTED_CODE
  | typeof RUNNER_MUTATION_INDETERMINATE_CODE
  | typeof RUNNER_RELEASE_COMMAND_FAILED_CODE
  | typeof RUNNER_PROVIDER_EXECUTION_FAILED_CODE
  | "apply_failed"
  | "runner_artifact_relay_ambiguous"
  | "runner_artifact_relay_failed"
  | "artifact_size_limit_exceeded"
  | "provider_source_invalid"
  | "provider_package_unavailable"
  | "provider_platform_binary_unavailable"
  | "provider_protocol_mismatch"
  | "provider_policy_denied"
  | "runner_capability_missing"
  | "provider_checksum_mismatch"
  | "opentofu_init_failed"
  | "source_build_failed"
  | "opentofu_plan_failed" {
  if (isTerminalReleaseCommandFailure(payload, phase, releaseActionIds)) {
    return RUNNER_RELEASE_COMMAND_FAILED_CODE;
  }
  const value = stringField(payload, "errorCode");
  const providerFailure = recordField(payload, "providerExecutionFailure");
  if (
    isRecord(providerFailure) &&
    stringField(providerFailure, "kind") === "provider_execution_failed"
  ) {
    return value && RUNNER_PROVIDER_FAILURE_CODES.has(value)
      ? (value as "apply_failed" | typeof RUNNER_PROVIDER_EXECUTION_FAILED_CODE)
      : RUNNER_PROVIDER_EXECUTION_FAILED_CODE;
  }
  switch (value) {
    case RUNNER_PROVIDER_EXECUTION_FAILED_CODE:
    case "apply_failed":
    case RUNNER_MUTATION_INDETERMINATE_CODE:
    case "runner_artifact_relay_ambiguous":
    case "runner_artifact_relay_failed":
    case "artifact_size_limit_exceeded":
      return value;
    default:
      return value && RUNNER_PLAN_EXECUTION_FAILURE_CODES.has(value)
        ? (value as
            | "provider_source_invalid"
            | "provider_package_unavailable"
            | "provider_platform_binary_unavailable"
            | "provider_protocol_mismatch"
            | "provider_policy_denied"
            | "runner_capability_missing"
            | "provider_checksum_mismatch"
            | "opentofu_init_failed"
            | "source_build_failed"
            | "opentofu_plan_failed")
        : RUNNER_REJECTED_CODE;
  }
}

function isTerminalReleaseCommandFailure(
  payload: Record<string, unknown>,
  phase: string | undefined,
  releaseActionIds?: readonly string[],
): boolean {
  const failedCommandId = stringField(payload, "failedCommandId");
  return (
    phase === "release" &&
    stringField(payload, "phase") === "release" &&
    stringField(payload, "status") === "failed" &&
    typeof payload.exitCode === "number" &&
    Number.isSafeInteger(payload.exitCode) &&
    payload.exitCode !== 0 &&
    failedCommandId !== undefined &&
    releaseActionIds !== undefined &&
    releaseActionIds.includes(failedCommandId)
  );
}

function runnerFailurePhase(phase: string | undefined): RunnerFailurePhase {
  switch (phase) {
    case "plan":
    case "apply":
    case "destroy":
    case "restore":
    case "source_sync":
    case "backup":
    case "release":
    case "stable_semver_tag":
    case "compatibility_check":
      return phase;
    default:
      return "plan";
  }
}

async function readRunnerFailureDetail(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const text = new TextDecoder().decode(
    await readBoundedResponseBytes(response, "failure_detail", maxBytes),
  );
  if (text.length === 0) return undefined;
  const redactedText = redactString(text, { redactedValue: "[redacted]" });
  try {
    const value = JSON.parse(text) as unknown;
    if (isRecord(value)) {
      const detail =
        stringField(value, "detail") ?? stringField(value, "error");
      if (detail) return redactString(detail, { redactedValue: "[redacted]" });
    }
  } catch {
    // Fall back to the redacted raw body below.
  }
  const trimmed = redactedText.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : undefined;
}

function jsonResponse(payload: unknown, status: number): Response {
  return Response.json(payload, { status });
}

function runnerKeepaliveSeconds(env: CloudflareWorkerEnv): number {
  const raw = optionalStringEnv(env.TAKOSUMI_RUNNER_KEEPALIVE_SECONDS);
  if (!raw) return DEFAULT_RUNNER_KEEPALIVE_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_RUNNER_KEEPALIVE_SECONDS;
  }
  return Math.min(Math.floor(parsed), MAX_RUNNER_KEEPALIVE_SECONDS);
}

function runnerActivityGraceSeconds(keepaliveSeconds: number): number {
  if (keepaliveSeconds > 0) {
    return Math.max(RUNNER_MIN_ACTIVITY_GRACE_SECONDS, keepaliveSeconds);
  }
  return RUNNER_MIN_ACTIVITY_GRACE_SECONDS;
}

function optionalEnvVars(
  input: Record<string, unknown>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const stringValue = optionalStringEnv(value);
    if (stringValue) output[name] = stringValue;
  }
  return output;
}

function optionalStringEnv(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function withRunnerStartupHeader(
  response: Response,
  seconds: number | undefined,
): Response {
  if (seconds === undefined) return response;
  const headers = new Headers(response.headers);
  headers.set(RUNNER_STARTUP_SECONDS_HEADER, String(seconds));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function runnerRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (RUNNER_REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  return headers;
}

function recordField(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function requiredStringField(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = stringField(value, key);
  if (!field) throw new Error(`${key} is required`);
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

// Copy a (possibly `SharedArrayBuffer`-backed) view into a fresh `ArrayBuffer`
// so it satisfies the DOM `BufferSource` / `BodyInit` typings under TS 5.7+
// typed-array generics. Mirrors `worker/src/state_crypto.ts#toArrayBuffer`.
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function digestText(text: string): Promise<string> {
  return await digestBytes(new TextEncoder().encode(text));
}
