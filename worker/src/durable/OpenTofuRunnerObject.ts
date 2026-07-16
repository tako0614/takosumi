import type {
  CloudflareWorkerEnv,
  R2Bucket,
  R2Object,
  R2PutOptions,
} from "../bindings.ts";
import { StateArtifactCrypto } from "../state_crypto.ts";
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

export class OpenTofuRunnerObject extends OpenTofuRunnerContainerBase<CloudflareWorkerEnv> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "30s";
  pingEndpoint = "localhost/healthz";
  entrypoint = ["/app/runner/start.sh"];

  #stateCryptoInstance: StateArtifactCrypto | undefined;
  #lastStartupSeconds: number | undefined;
  readonly #localRunnerProxyUrl: URL | undefined;

  constructor(ctx: ContainerHostContext, env: CloudflareWorkerEnv) {
    super(ctx, env);
    this.#localRunnerProxyUrl = localOpenTofuRunnerProxyUrl(env);
    if (env.LOCAL_SUBSTRATE_TEST_BED === "1") {
      console.log("OpenTofu runner local proxy composition", {
        configured: Boolean(this.#localRunnerProxyUrl),
        target: this.#localRunnerProxyUrl?.origin,
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
    console.error("OpenTofu runner container failed", error);
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
    console.error("OpenTofu runner container stopped", params);
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
    const runAction = runDispatch
      ? await readRunDispatchAction(request.clone())
      : undefined;
    const shutdownAfterRun =
      runDispatch &&
      runnerShouldShutdownAfterRun(runAction, runnerKeepaliveSeconds(this.env));
    let runSucceeded = false;
    try {
      this.#lastStartupSeconds = undefined;
      const response = await this.#fetchWithDurablePlanArtifacts(request);
      runSucceeded = response.ok;
      const output = runDispatch ? await bufferedResponse(response) : response;
      return withRunnerStartupHeader(output, this.#lastStartupSeconds);
    } catch (error) {
      const url = new URL(request.url);
      console.error("OpenTofu runner artifact relay failed", {
        method: request.method,
        path: url.pathname,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack
          ? { stack: error.stack }
          : {}),
      });
      return Response.json(
        {
          error: "OpenTofu runner artifact relay failed",
          detail: redactedErrorMessage(error, "run artifact relay failed"),
        },
        { status: 500 },
      );
    } finally {
      if (runDispatch && (!runSucceeded || shutdownAfterRun)) {
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
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
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
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
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
          const failure = await readRunnerFailureDetail(response);
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
    if (stateAdoption && !stateScope) {
      throw new Error("stateAdoption requires a Resource stateScope");
    }
    const sourceArchive = parseSourceArchiveRestore(envelope.request);
    const depStates = parseDepStates(envelope.request);
    const stateKeys = stateScope
      ? []
      : await stateArtifactKeys(envelope.request);
    if (envelope.action === "apply" && stateScope) {
      if (!rawOutputRef) {
        throw new Error("apply with stateScope requires rawOutputRef");
      }
      assertRawOutputRefForScope(
        stateScope,
        parseApplyRunId(envelope.request) ?? runId,
        rawOutputRef,
      );
      const adopted = await this.#adoptCompletedApplyFromR2State(
        runId,
        stateScope,
        rawOutputRef,
      );
      if (adopted) return adopted;
    }
    // M2: restore the snapshotted source tree into the container before any
    // build/plan phase (mirrors the plan-artifact restore protocol).
    if (sourceArchive) {
      await this.#restoreSourceArchive(runId, sourceArchive, url);
    }
    // remote_state dependencies (spec §15): fetch + decrypt each producer state
    // and stream it to the container's dep-state restore route BEFORE init/plan/
    // apply, so the consumer's `terraform_remote_state` data sources resolve.
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
    const runnerResponse = await this.#containerFetchAfterReady(
      () =>
        new Request(request.url, {
          method: request.method,
          headers: runnerRequestHeaders(request),
          body: bodyText,
        }),
      url,
    );
    if (
      (envelope.action === "apply" || envelope.action === "destroy") &&
      runnerResponse.ok
    ) {
      if (stateScope) {
        return await this.#persistStateToR2State(
          runId,
          stateScope,
          url,
          runnerResponse,
          envelope.action,
          rawOutputRef,
        );
      }
      if (stateKeys.length > 0) {
        await this.#persistStateArtifact(runId, stateKeys, url);
      }
    }
    if (envelope.action !== "plan" || !runnerResponse.ok) {
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
        }),
      url,
    );
    if (!runnerResponse.ok) return runnerResponse;
    const payload = await readJsonObject(runnerResponse);
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
    const bytes = new Uint8Array(await archiveResponse.arrayBuffer());
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
    const bytes = new Uint8Array(await object.arrayBuffer());
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
    assertSafeSourceArchiveKey(sourceArchive.ref);
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
    const bytes = new Uint8Array(await object.arrayBuffer());
    const digest = await digestBytes(bytes);
    if (digest !== sourceArchive.digest) {
      throw new Error(`source archive digest mismatch on restore: ${digest}`);
    }
    await this.#ensureContainerReady(baseUrl);
    const response = await this.#containerFetch(
      new Request(sourceArchiveRestoreUrl(baseUrl, runId), {
        method: "PUT",
        headers: { "content-type": SOURCE_ARCHIVE_CONTENT_TYPE },
        body: bytes,
      }),
    );
    if (!response.ok) {
      const failure = await readRunnerFailureDetail(response);
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
      const ciphertext = new Uint8Array(await object.arrayBuffer());
      const plaintext = await this.#stateCrypto().open(
        ciphertext,
        depState.digest,
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

  // M2 state restore: read current.json under the env's R2_STATE prefix, fetch
  // the current encrypted state object, decrypt + verify the recorded plaintext
  // digest (tamper check), and stream the plaintext to the container. The
  // container never sees the passphrase or the ciphertext. First-create plans
  // have no current.json yet, in which case there is nothing to restore.
  async #restoreStateFromR2State(
    runId: string,
    scope: StateScope,
    baseUrl: URL,
    action: string | undefined,
    adoption: StateAdoption | undefined,
  ): Promise<void> {
    const bucket = this.#r2State();
    const current = await readCurrentState(
      bucket,
      scope,
      restoreMaxGeneration(scope, action),
    );
    if (current && adoption) {
      throw new Error(
        "state adoption refused: canonical Resource state already exists",
      );
    }
    const adopted =
      !current && adoption
        ? await readConfirmedStateAdoption(
            bucket,
            scope,
            adoption,
            restoreMaxGeneration(scope, action),
          )
        : undefined;
    const pointer = current ?? adopted?.pointer;
    if (!pointer) return;
    const object =
      adopted?.object ?? (await readCurrentStateObject(bucket, scope, pointer));
    const ciphertext = new Uint8Array(await object.arrayBuffer());
    const plaintext = await this.#stateCrypto().open(
      ciphertext,
      pointer.digest,
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
  // (8-digit), then atomically write current.json AFTER the state object. The DO
  // returns the recorded digest in the run payload so the controller can update
  // its ledger; generation arithmetic stays with the controller.
  async #persistStateToR2State(
    runId: string,
    scope: StateScope,
    baseUrl: URL,
    runnerResponse: Response,
    action: string | undefined,
    rawOutputRef: string | undefined,
  ): Promise<Response> {
    const stateResponse = await this.#containerFetch(
      new Request(stateArtifactUrl(baseUrl, runId), { method: "GET" }),
    );
    if (stateResponse.status === 404) return runnerResponse;
    if (!stateResponse.ok) {
      throw new Error(
        `container state artifact fetch failed: ${stateResponse.status}`,
      );
    }
    const plaintext = new Uint8Array(await stateResponse.arrayBuffer());
    const sealed = await this.#stateCrypto().seal(plaintext);
    const bucket = this.#r2State();
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
          "takosumi-generation": String(scope.generation),
        },
      },
      "state object",
    );
    // current.json is written AFTER the state object. If this write fails after
    // the object write, the next restore reconciles by finding the highest
    // sealed generation object with a digest metadata entry and rewrites
    // current.json before handing plaintext state to the container.
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
      "state pointer",
    );
    const payload = await readJsonObject(runnerResponse);
    // M7: an apply persists the raw `tofu output -json` envelope encrypted at
    // rest to R2_ARTIFACTS and echoes `rawOutputRef` so the
    // controller records it on the Output. A destroy has no outputs.
    const persistedRawOutputRef =
      action === "apply"
        ? await this.#persistRawOutputs(runId, rawOutputRef!, payload)
        : undefined;
    return jsonResponse(
      {
        ...payload,
        state: {
          generation: scope.generation,
          stateRef: objectKey,
          digest: sealed.contentDigest,
          ciphertextLength: sealed.ciphertextLength,
        },
        ...(persistedRawOutputRef
          ? { rawOutputRef: persistedRawOutputRef }
          : {}),
      },
      runnerResponse.status,
    );
  }

  // M7: seal the raw `tofu output -json` envelope (the runner's `outputs` field,
  // which carries the per-output sensitive flags) and write it encrypted at rest
  // to R2_ARTIFACTS at the host-allocated ref. Returns the ref for the controller
  // to record on the Output. No-op when the apply produced no outputs.
  async #persistRawOutputs(
    runId: string,
    rawOutputRef: string,
    payload: Record<string, unknown>,
  ): Promise<string | undefined> {
    const outputs = payload.outputs;
    if (outputs === undefined || outputs === null) return undefined;
    assertSafeArtifactObjectKey(rawOutputRef, "raw output");
    const key = rawOutputRef;
    const plaintext = new TextEncoder().encode(JSON.stringify(outputs));
    const sealed = await this.#stateCrypto().seal(plaintext);
    await putR2ObjectWithRetry(
      this.env.R2_ARTIFACTS,
      key,
      sealed.ciphertext,
      {
        httpMetadata: { contentType: ENCRYPTED_ARTIFACT_CONTENT_TYPE },
        customMetadata: {
          "takosumi-run-id": runId,
          "takosumi-content-digest": sealed.contentDigest,
          "takosumi-ciphertext-length": String(sealed.ciphertextLength),
        },
      },
      "raw outputs",
    );
    return key;
  }

  async #adoptCompletedApplyFromR2State(
    runId: string,
    scope: StateScope,
    rawOutputRef: string,
  ): Promise<Response | undefined> {
    const bucket = this.#r2State();
    const current = await readCurrentStatePointer(bucket, scope);
    if (!current || current.generation !== scope.generation) return undefined;
    const object = await bucket.get(current.objectKey);
    if (!object) return undefined;
    const persistedRunId =
      object.customMetadata?.["takosumi-run-id"] ?? current.runId;
    if (persistedRunId !== runId) return undefined;
    const metadataDigest =
      object.customMetadata?.["takosumi-content-digest"] ??
      object.customMetadata?.["takosumi-digest"];
    if (metadataDigest && metadataDigest !== current.digest) {
      throw new Error(
        `completed apply state digest mismatch for ${current.objectKey}`,
      );
    }
    await this.#stateCrypto().open(
      new Uint8Array(await object.arrayBuffer()),
      current.digest,
    );
    const rawOutputs = await this.#readPersistedRawOutputs(runId, rawOutputRef);
    const ciphertextLength =
      current.ciphertextLength ??
      Number(object.customMetadata?.["takosumi-ciphertext-length"]);
    return jsonResponse(
      {
        status: "succeeded",
        exitCode: 0,
        state: {
          generation: current.generation,
          stateRef: current.objectKey,
          digest: current.digest,
          ...(Number.isFinite(ciphertextLength) ? { ciphertextLength } : {}),
        },
        ...(rawOutputs
          ? { outputs: rawOutputs.outputs, rawOutputRef: rawOutputs.ref }
          : {}),
      },
      200,
    );
  }

  async #readPersistedRawOutputs(
    runId: string,
    rawOutputRef: string,
  ): Promise<
    | { readonly ref: string; readonly outputs: Record<string, unknown> }
    | undefined
  > {
    assertSafeArtifactObjectKey(rawOutputRef, "raw output");
    const key = rawOutputRef;
    const object = await this.env.R2_ARTIFACTS.get(key);
    if (!object) return undefined;
    const plaintext = await this.#stateCrypto().open(
      new Uint8Array(await object.arrayBuffer()),
      object.customMetadata?.["takosumi-content-digest"],
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
      new Uint8Array(await object.arrayBuffer()),
      restoreState.digest,
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
    const payload = await readJsonObject(runnerResponse);
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
    const bytes = new Uint8Array(await artifactResponse.arrayBuffer());
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
    const contentLength = response.headers.get("content-length");
    const sizeBytes = contentLength ? Number(contentLength) : NaN;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes > maxBytes) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {
          // Best-effort cancellation only; the artifact is optional review data.
        }
      }
      console.warn("skipping oversized OpenTofu plan JSON artifact", {
        runId,
        sizeBytes: Number.isSafeInteger(sizeBytes) ? sizeBytes : undefined,
        maxBytes,
      });
      return;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
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
    const ciphertext = new Uint8Array(await encrypted.arrayBuffer());
    return await this.#stateCrypto().open(ciphertext, expectedDigest);
  }

  async #restoreStateArtifact(
    runId: string,
    keys: readonly string[],
    baseUrl: URL,
  ): Promise<void> {
    for (const key of keys) {
      const object = await this.env.R2_ARTIFACTS.get(encryptedKey(key));
      if (!object) continue;
      const ciphertext = new Uint8Array(await object.arrayBuffer());
      const bytes = await this.#stateCrypto().open(
        ciphertext,
        object.customMetadata?.["takosumi-content-digest"],
      );
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
  ): Promise<void> {
    const response = await this.#containerFetch(
      new Request(stateArtifactUrl(baseUrl, runId), { method: "GET" }),
    );
    if (response.status === 404) return;
    if (!response.ok) {
      throw new Error(
        `container state artifact fetch failed: ${response.status}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
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
          },
        },
        "state artifact",
      );
    }
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
  let lastError: unknown;
  for (let attempt = 1; attempt <= R2_PUT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await bucket.put(key, value, options);
    } catch (error) {
      lastError = error;
      if (attempt >= R2_PUT_RETRY_ATTEMPTS || !isRetryableR2PutError(error)) {
        throw new Error(
          `${context} R2 put failed after ${attempt} attempt${
            attempt === 1 ? "" : "s"
          }: ${redactedErrorMessage(error, "r2 put failed")}`,
        );
      }
      console.warn("OpenTofu runner R2 put failed; retrying", {
        context,
        key,
        attempt,
        maxAttempts: R2_PUT_RETRY_ATTEMPTS,
        error: redactedErrorMessage(error, "r2 put failed"),
      });
      await sleep(
        Math.min(
          R2_PUT_RETRY_MAX_MS,
          R2_PUT_RETRY_BASE_MS * 2 ** (attempt - 1),
        ),
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

async function readRunDispatchAction(
  request: Request,
): Promise<string | undefined> {
  try {
    return parseRunEnvelope(await request.text()).action;
  } catch {
    return undefined;
  }
}

function runnerShouldShutdownAfterRun(
  action: string | undefined,
  keepaliveSeconds: number,
): boolean {
  if (keepaliveSeconds <= 0) return true;
  return action !== "plan";
}

async function bufferedResponse(response: Response): Promise<Response> {
  const body = await response.arrayBuffer();
  return new Response(body, {
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
    ? parsed
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
  readonly digest: string;
  readonly runId?: string;
  readonly ciphertextLength?: number;
}

async function readCurrentState(
  bucket: NonNullable<CloudflareWorkerEnv["R2_STATE"]>,
  scope: StateScope,
  maxGeneration: number,
): Promise<CurrentStatePointer | undefined> {
  const current = await readCurrentStatePointer(bucket, scope);
  if (!current) return await recoverCurrentState(bucket, scope, maxGeneration);
  if (
    !Number.isInteger(current.generation) ||
    current.generation > maxGeneration
  ) {
    throw new Error(
      `current.json generation is outside restore window: ${current.generation}`,
    );
  }
  return current;
}

async function readCurrentStatePointer(
  bucket: NonNullable<CloudflareWorkerEnv["R2_STATE"]>,
  scope: StateScope,
): Promise<CurrentStatePointer | undefined> {
  const object = await bucket.get(currentStateKey(scope));
  if (!object) return undefined;
  const text = new TextDecoder().decode(
    new Uint8Array(await object.arrayBuffer()),
  );
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("current.json is not a JSON object");
  }
  const objectKey = stringField(parsed, "objectKey");
  const digest = stringField(parsed, "digest");
  const generation = parsed.generation;
  const ciphertextLength = parsed.ciphertextLength;
  if (!objectKey || !digest || typeof generation !== "number") {
    throw new Error("current.json is missing generation/objectKey/digest");
  }
  // The pointer must stay inside this env's state prefix (defense in depth
  // against a crafted current.json pointing at another tenant's object).
  if (!objectKey.startsWith(`${stateScopePrefix(scope)}/`)) {
    throw new Error(
      `current.json objectKey escapes state prefix: ${objectKey}`,
    );
  }
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error(
      `current.json generation is outside restore window: ${generation}`,
    );
  }
  return {
    generation,
    objectKey,
    digest,
    ...(stringField(parsed, "runId")
      ? { runId: stringField(parsed, "runId") }
      : object.customMetadata?.["takosumi-run-id"]
        ? { runId: object.customMetadata["takosumi-run-id"] }
        : {}),
    ...(typeof ciphertextLength === "number" &&
    Number.isFinite(ciphertextLength)
      ? { ciphertextLength }
      : {}),
  };
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

async function readCurrentStateObject(
  bucket: NonNullable<CloudflareWorkerEnv["R2_STATE"]>,
  scope: StateScope,
  current: CurrentStatePointer,
): Promise<NonNullable<Awaited<ReturnType<typeof bucket.get>>>> {
  const object = await bucket.get(current.objectKey);
  if (object) return object;
  const recovered = await recoverCurrentState(
    bucket,
    scope,
    current.generation,
  );
  if (!recovered) {
    throw new Error(`current state object not found: ${current.objectKey}`);
  }
  const recoveredObject = await bucket.get(recovered.objectKey);
  if (!recoveredObject) {
    throw new Error(`recovered state object not found: ${recovered.objectKey}`);
  }
  return recoveredObject;
}

async function recoverCurrentState(
  bucket: NonNullable<CloudflareWorkerEnv["R2_STATE"]>,
  scope: StateScope,
  maxGeneration: number,
): Promise<CurrentStatePointer | undefined> {
  if (maxGeneration < 0) return undefined;
  const prefix = `${stateScopePrefix(scope)}/`;
  const objects = await bucket.list({ prefix });
  let best: CurrentStatePointer | undefined;
  for (const object of objects.objects) {
    const generation = generationFromStateObjectKey(prefix, object.key);
    if (generation === undefined || generation > maxGeneration) continue;
    const digest =
      object.customMetadata?.["takosumi-content-digest"] ??
      object.customMetadata?.["takosumi-digest"];
    if (!digest) continue;
    if (!best || generation > best.generation) {
      const ciphertextLength = Number(
        object.customMetadata?.["takosumi-ciphertext-length"],
      );
      best = {
        generation,
        objectKey: object.key,
        digest,
        ...(object.customMetadata?.["takosumi-run-id"]
          ? { runId: object.customMetadata["takosumi-run-id"] }
          : {}),
        ...(Number.isFinite(ciphertextLength) ? { ciphertextLength } : {}),
      };
    }
  }
  if (!best) return undefined;
  await putR2ObjectWithRetry(
    bucket,
    currentStateKey(scope),
    JSON.stringify(best),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        "takosumi-reconciled": "true",
        "takosumi-recovered-generation": String(best.generation),
      },
    },
    "state pointer recovery",
  );
  return best;
}

function generationFromStateObjectKey(
  prefix: string,
  key: string,
): number | undefined {
  if (!key.startsWith(prefix) || !key.endsWith(".tfstate.enc")) {
    return undefined;
  }
  const segment = key.slice(prefix.length, -".tfstate.enc".length);
  if (!/^[0-9]{8}$/.test(segment)) return undefined;
  return Number(segment);
}

function restoreMaxGeneration(
  scope: StateScope,
  action: string | undefined,
): number {
  if (action === "apply" || action === "destroy") {
    return scope.generation - 1;
  }
  return scope.generation;
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

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  const value = text.length > 0 ? (JSON.parse(text) as unknown) : {};
  if (isRecord(value)) return value;
  throw new Error("OpenTofu runner response must be a JSON object");
}

async function readRunnerFailureDetail(
  response: Response,
): Promise<string | undefined> {
  const text = await response.text();
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

function redactedErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const text = message && message.trim().length > 0 ? message : fallback;
  return redactString(text, { redactedValue: "[redacted]" });
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
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function digestText(text: string): Promise<string> {
  return await digestBytes(new TextEncoder().encode(text));
}
