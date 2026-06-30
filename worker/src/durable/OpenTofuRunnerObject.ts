import type { CloudflareWorkerEnv } from "../bindings.ts";
import { StateArtifactCrypto } from "../state_crypto.ts";
import { redactString } from "takosumi-contract/redaction";

const DEFAULT_PLAN_ARTIFACT_BUCKET = "takos-artifacts";
const PLAN_ARTIFACT_CONTENT_TYPE = "application/vnd.opentofu.plan";
const STATE_ARTIFACT_CONTENT_TYPE = "application/json";
const SOURCE_ARCHIVE_CONTENT_TYPE = "application/zstd";
// At-rest content type for AES-GCM ciphertext blobs (state/plan .enc objects).
const ENCRYPTED_ARTIFACT_CONTENT_TYPE = "application/octet-stream";
const RUNNER_REQUEST_HEADER_ALLOWLIST = new Set(["content-type"]);

/**
 * Optional dispatch payload field locating the R2_STATE object for this run.
 * Present when the controller (other lane) carries installation context in the
 * job. When ABSENT the DO falls back to the legacy R2_ARTIFACTS
 * `opentofu-state/...` path so existing jobs/tests keep working (additive, no
 * flag-day). The `generation` is the 8-digit state generation the controller
 * owns; the DO only writes the object at the derived key and returns its digest.
 * Mirrors the contract `DispatchStateScope` ({ workspaceId, capsuleId,
 * environment, generation }); kept as a local interface so the DO does not pull
 * a contract import into the worker bundle. The dispatch wire is parsed
 * canonical-first with a deprecated `spaceId`/`installationId` fallback during
 * the noun rename; the PHYSICAL R2 key prefix (`spaces/.../installations/...`)
 * stays frozen in lockstep with the controller key formatters so existing state
 * objects are never orphaned.
 */
interface StateScope {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly generation: number;
}

/**
 * Optional dispatch payload field locating the source archive to restore into
 * the container workspace for build/plan phases. The DO fetches it from
 * R2_SOURCE, verifies the digest, and streams it to the container restore route.
 */
interface SourceArchiveRestore {
  readonly objectKey: string;
  readonly digest: string;
}

/**
 * Optional dispatch payload field locating a producer Installation's encrypted
 * state in R2_STATE for a `remote_state` dependency (spec §15). The DO fetches
 * the ciphertext at `objectKey`, decrypts + verifies the recorded plaintext
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
  readonly objectKey: string;
  readonly digest: string;
}

interface RestoreState {
  readonly objectKey: string;
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

  constructor(ctx: ContainerHostContext, env: CloudflareWorkerEnv) {
    super(ctx, env);
    const keepaliveSeconds = runnerKeepaliveSeconds(env);
    this.sleepAfter = `${Math.max(1, keepaliveSeconds)}s`;
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
    const shutdownAfterRun =
      runDispatch && runnerKeepaliveSeconds(this.env) === 0;
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
    const sourceArchive = parseSourceArchiveRestore(envelope.request);
    const depStates = parseDepStates(envelope.request);
    const stateKeys = stateScope
      ? []
      : await stateArtifactKeys(envelope.request);
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
  // archiveObjectKey the runner echoes back. Mirrors the tfplan pull-then-persist
  // protocol but writes to the dedicated source bucket and never touches state.
  async #fetchWithSourceArchive(
    runId: string,
    request: Request,
    bodyText: string,
  ): Promise<Response> {
    const url = new URL(request.url);
    const envelope = parseRunEnvelope(bodyText);
    const requestedArchiveObjectKey = sourceSyncArchiveObjectKey(
      envelope.request,
    );
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
    const archiveObjectKey = requiredStringField(archive, "archiveObjectKey");
    assertSafeSourceArchiveKey(archiveObjectKey);
    if (archiveObjectKey !== requestedArchiveObjectKey) {
      throw new Error("source archive object key does not match request");
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
    const stored = await bucket.put(archiveObjectKey, bytes, {
      httpMetadata: { contentType: SOURCE_ARCHIVE_CONTENT_TYPE },
      customMetadata: {
        "takosumi-run-id": runId,
        "takosumi-digest": digest,
      },
    });
    return jsonResponse(
      {
        ...payload,
        sourceArchive: {
          kind: "object-storage",
          archiveObjectKey,
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
    const archiveObjectKey = requiredStringField(archive, "archiveObjectKey");
    assertSafeSourceArchiveKey(archiveObjectKey);
    const digest = requiredStringField(archive, "digest");
    const sizeBytes = positiveIntegerField(archive, "sizeBytes");
    const reusedFromSnapshotId = requiredStringField(
      archive,
      "reusedFromSnapshotId",
    );
    if (
      reusedFromSnapshotId !== reuseSnapshot.id ||
      archiveObjectKey !== reuseSnapshot.archiveObjectKey ||
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
    const object = await bucket.get(archiveObjectKey);
    if (!object) {
      throw new Error(`source archive object not found: ${archiveObjectKey}`);
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
    assertSafeSourceArchiveKey(sourceArchive.objectKey);
    const bucket = this.env.R2_SOURCE;
    if (!bucket) {
      throw new Error(
        "R2_SOURCE binding is not configured for source archives",
      );
    }
    const object = await bucket.get(sourceArchive.objectKey);
    if (!object) {
      throw new Error(
        `source archive object not found: ${sourceArchive.objectKey}`,
      );
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
  // path-jails the objectKey to the producer env's state prefix (defense against
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
      assertDepStateObjectKey(depState);
      const object = await bucket.get(depState.objectKey);
      if (!object) {
        throw new Error(
          `dependency state object not found: ${depState.objectKey}`,
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
  ): Promise<void> {
    const bucket = this.#r2State();
    const current = await readCurrentState(
      bucket,
      scope,
      restoreMaxGeneration(scope, action),
    );
    if (!current) return;
    const object = await readCurrentStateObject(bucket, scope, current);
    const ciphertext = new Uint8Array(await object.arrayBuffer());
    const plaintext = await this.#stateCrypto().open(
      ciphertext,
      current.digest,
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
    const objectKey = stateObjectKey(scope);
    await bucket.put(objectKey, sealed.ciphertext, {
      httpMetadata: { contentType: ENCRYPTED_ARTIFACT_CONTENT_TYPE },
      customMetadata: {
        "takosumi-run-id": runId,
        "takosumi-content-digest": sealed.contentDigest,
        "takosumi-ciphertext-length": String(sealed.ciphertextLength),
        "takosumi-generation": String(scope.generation),
      },
    });
    // current.json is written AFTER the state object. If this write fails after
    // the object write, the next restore reconciles by finding the highest
    // sealed generation object with a digest metadata entry and rewrites
    // current.json before handing plaintext state to the container.
    const current = {
      generation: scope.generation,
      objectKey,
      digest: sealed.contentDigest,
    };
    await bucket.put(currentStateKey(scope), JSON.stringify(current), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { "takosumi-run-id": runId },
    });
    const payload = await readJsonObject(runnerResponse);
    // M7: an apply persists the raw `tofu output -json` envelope encrypted at
    // rest to R2_ARTIFACTS (spec §26) and echoes `rawOutputsKey` so the
    // controller records it on the OutputSnapshot. A destroy has no outputs.
    const rawOutputsKey =
      action === "apply"
        ? await this.#persistRawOutputs(runId, scope, payload)
        : undefined;
    return jsonResponse(
      {
        ...payload,
        state: {
          generation: scope.generation,
          objectKey,
          digest: sealed.contentDigest,
          ciphertextLength: sealed.ciphertextLength,
        },
        ...(rawOutputsKey ? { rawOutputsKey } : {}),
      },
      runnerResponse.status,
    );
  }

  // M7: seal the raw `tofu output -json` envelope (the runner's `outputs` field,
  // which carries the per-output sensitive flags) and write it encrypted at rest
  // to R2_ARTIFACTS under the spec §26 key. Returns the key for the controller
  // to record on the OutputSnapshot. No-op when the apply produced no outputs.
  async #persistRawOutputs(
    runId: string,
    scope: StateScope,
    payload: Record<string, unknown>,
  ): Promise<string | undefined> {
    const outputs = payload.outputs;
    if (outputs === undefined || outputs === null) return undefined;
    const key = rawOutputsKey(scope, runId);
    const plaintext = new TextEncoder().encode(JSON.stringify(outputs));
    const sealed = await this.#stateCrypto().seal(plaintext);
    await this.env.R2_ARTIFACTS.put(key, sealed.ciphertext, {
      httpMetadata: { contentType: ENCRYPTED_ARTIFACT_CONTENT_TYPE },
      customMetadata: {
        "takosumi-run-id": runId,
        "takosumi-content-digest": sealed.contentDigest,
        "takosumi-ciphertext-length": String(sealed.ciphertextLength),
      },
    });
    return key;
  }

  async #restoreStateGeneration(
    runId: string,
    scope: StateScope,
    restoreState: RestoreState,
  ): Promise<Response> {
    assertRestoreStateObjectKey(scope, restoreState.objectKey);
    const bucket = this.#r2State();
    const object = await bucket.get(restoreState.objectKey);
    if (!object) {
      throw new Error(
        `restore state object not found: ${restoreState.objectKey}`,
      );
    }
    const plaintext = await this.#stateCrypto().open(
      new Uint8Array(await object.arrayBuffer()),
      restoreState.digest,
    );
    const sealed = await this.#stateCrypto().seal(plaintext);
    const objectKey = stateObjectKey(scope);
    await bucket.put(objectKey, sealed.ciphertext, {
      httpMetadata: { contentType: ENCRYPTED_ARTIFACT_CONTENT_TYPE },
      customMetadata: {
        "takosumi-run-id": runId,
        "takosumi-content-digest": sealed.contentDigest,
        "takosumi-ciphertext-length": String(sealed.ciphertextLength),
        "takosumi-generation": String(scope.generation),
        "takosumi-restored-from-object": restoreState.objectKey,
      },
    });
    const current = {
      generation: scope.generation,
      objectKey,
      digest: sealed.contentDigest,
    };
    await bucket.put(currentStateKey(scope), JSON.stringify(current), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { "takosumi-run-id": runId },
    });
    return jsonResponse({ state: current }, 200);
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
    const stored = await this.env.R2_ARTIFACTS.put(
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
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = await digestBytes(bytes);
    const sealed = await this.#stateCrypto().seal(zstdCompressRaw(bytes));
    await this.env.R2_ARTIFACTS.put(
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
      await this.env.R2_ARTIFACTS.put(encryptedKey(key), sealed.ciphertext, {
        httpMetadata: { contentType: ENCRYPTED_ARTIFACT_CONTENT_TYPE },
        customMetadata: {
          "takosumi-run-id": runId,
          "takosumi-content-digest": sealed.contentDigest,
          "takosumi-ciphertext-length": String(sealed.ciphertextLength),
        },
      });
    }
  }

  #planArtifactBucket(): string {
    const configured = this.env.R2_ARTIFACTS_BUCKET_NAME;
    return typeof configured === "string" && configured.trim().length > 0
      ? configured.trim()
      : DEFAULT_PLAN_ARTIFACT_BUCKET;
  }
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
    error instanceof Error &&
    CONTAINER_NOT_RUNNING_PATTERN.test(error.message)
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

// ===========================================================================
// R2_STATE keys (spec §20 / §26). The PHYSICAL prefix is frozen at
// `spaces/.../installations/...` (logical Workspace/Capsule vocabulary, but the
// on-disk segments stay byte-identical with the controller key formatters so the
// rename never orphans existing state objects):
//   spaces/{workspaceId}/installations/{capsuleId}/envs/{environment}/states/{NNNNNNNN}.tfstate.enc
//   spaces/{workspaceId}/installations/{capsuleId}/envs/{environment}/states/current.json
// The generation is owned by the controller (other lane); the DO formats it as
// an 8-digit, zero-padded segment for the object key.
// ===========================================================================

function stateScopePrefix(scope: StateScope): string {
  return `spaces/${safeKeySegment(scope.workspaceId)}/installations/${safeKeySegment(
    scope.capsuleId,
  )}/envs/${safeKeySegment(scope.environment)}/states`;
}

function stateObjectKey(scope: StateScope): string {
  return `${stateScopePrefix(scope)}/${formatGeneration(scope.generation)}.tfstate.enc`;
}

function currentStateKey(scope: StateScope): string {
  return `${stateScopePrefix(scope)}/current.json`;
}

// R2_ARTIFACTS key for the encrypted raw `tofu output -json` envelope (spec §26).
// Physical prefix frozen at `spaces/.../installations/...`:
//   spaces/{workspaceId}/installations/{capsuleId}/runs/{runId}/outputs.raw.json.enc
// Kept in lockstep with the controller's `rawOutputArtifactKey` formatter so the
// recorded Output pointer matches the object the DO wrote.
function rawOutputsKey(scope: StateScope, runId: string): string {
  return `spaces/${safeKeySegment(scope.workspaceId)}/installations/${safeKeySegment(
    scope.capsuleId,
  )}/runs/${safeKeySegment(runId)}/outputs.raw.json.enc`;
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
}

async function readCurrentState(
  bucket: NonNullable<CloudflareWorkerEnv["R2_STATE"]>,
  scope: StateScope,
  maxGeneration: number,
): Promise<CurrentStatePointer | undefined> {
  const object = await bucket.get(currentStateKey(scope));
  if (!object) return await recoverCurrentState(bucket, scope, maxGeneration);
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
  if (!Number.isInteger(generation) || generation > maxGeneration) {
    throw new Error(
      `current.json generation is outside restore window: ${generation}`,
    );
  }
  return { generation, objectKey, digest };
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
      best = { generation, objectKey: object.key, digest };
    }
  }
  if (!best) return undefined;
  await bucket.put(currentStateKey(scope), JSON.stringify(best), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      "takosumi-reconciled": "true",
      "takosumi-recovered-generation": String(best.generation),
    },
  });
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
  // Canonical-first, deprecated fallback during the noun rename (the controller
  // emit side still populates spaceId/installationId on some dispatch paths).
  const workspaceId =
    stringField(scope, "workspaceId") ?? stringField(scope, "spaceId");
  const capsuleId =
    stringField(scope, "capsuleId") ?? stringField(scope, "installationId");
  const environment = stringField(scope, "environment");
  const generation = scope.generation;
  if (
    !workspaceId ||
    !capsuleId ||
    !environment ||
    typeof generation !== "number"
  ) {
    throw new Error(
      "stateScope requires workspaceId, capsuleId, environment, and a numeric generation",
    );
  }
  return { workspaceId, capsuleId, environment, generation };
}

function parseSourceArchiveRestore(
  requestPayload: unknown,
): SourceArchiveRestore | undefined {
  const archive = recordField(requestPayload, "sourceArchive");
  if (!archive) return undefined;
  // The run dispatch may carry either a restore descriptor { objectKey, digest }
  // or, on a source_sync response, an { archiveObjectKey, digest } persisted
  // descriptor. Accept objectKey or archiveObjectKey so plan/apply dispatch can
  // reuse the snapshot record verbatim.
  const objectKey =
    stringField(archive, "objectKey") ??
    stringField(archive, "archiveObjectKey");
  const digest = stringField(archive, "digest");
  if (!objectKey || !digest) return undefined;
  return { objectKey, digest };
}

// Parse the optional remote_state dependency descriptors off the dispatch
// request. Each entry must carry a name, objectKey, digest, environment,
// capsuleId (deprecated installationId accepted during the rename), and a
// numeric generation; a malformed entry fails the run closed (a remote_state
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
    const capsuleId =
      stringField(entry, "capsuleId") ?? stringField(entry, "installationId");
    const environment = stringField(entry, "environment");
    const objectKey = stringField(entry, "objectKey");
    const digest = stringField(entry, "digest");
    const generation = entry.generation;
    if (
      !name ||
      !capsuleId ||
      !environment ||
      !objectKey ||
      !digest ||
      typeof generation !== "number"
    ) {
      throw new Error(
        "depStates entry requires name, capsuleId, environment, " +
          "objectKey, digest, and a numeric generation",
      );
    }
    return { name, capsuleId, environment, generation, objectKey, digest };
  });
}

function parseRestoreState(requestPayload: unknown): RestoreState | undefined {
  const restoreState = recordField(requestPayload, "restoreState");
  if (!restoreState) return undefined;
  const objectKey = stringField(restoreState, "objectKey");
  const digest = stringField(restoreState, "digest");
  if (!objectKey || !digest) return undefined;
  return { objectKey, digest };
}

function assertRestoreStateObjectKey(scope: StateScope, key: string): void {
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("..") ||
    key.includes("\0") ||
    key.includes("\\") ||
    !key.startsWith("spaces/") ||
    !key.endsWith(".tfstate.enc")
  ) {
    throw new Error(`unsafe restore state object key: ${key}`);
  }
  if (!key.startsWith(`${stateScopePrefix(scope)}/`)) {
    throw new Error(`restore state object key escapes target prefix: ${key}`);
  }
}

// Re-assert a dependency state objectKey is a traversal-free R2_STATE key inside
// the producer env's state prefix (defense in depth against a crafted descriptor
// pointing at another tenant's object). It must match the spec §20 state key
// layout AND name the descriptor's own capsuleId + environment. The physical
// key prefix stays frozen at `spaces/.../installations/...`.
function assertDepStateObjectKey(depState: DepState): void {
  const key = depState.objectKey;
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("..") ||
    key.includes("\0") ||
    key.includes("\\") ||
    !key.startsWith("spaces/") ||
    !key.endsWith(".tfstate.enc")
  ) {
    throw new Error(`unsafe dependency state object key: ${key}`);
  }
  const expectedSuffix = `/installations/${safeKeySegment(
    depState.capsuleId,
  )}/envs/${safeKeySegment(depState.environment)}/states/`;
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
  readonly archiveObjectKey: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
}

function parseReusableSourceSnapshot(
  requestPayload: unknown,
): ReusableSourceSnapshot | undefined {
  const snapshot = recordField(requestPayload, "reuseSnapshot");
  if (!snapshot) return undefined;
  const archiveObjectKey = requiredStringField(snapshot, "archiveObjectKey");
  assertSafeSourceArchiveKey(archiveObjectKey);
  return {
    id: requiredStringField(snapshot, "id"),
    archiveObjectKey,
    archiveDigest: requiredSha256DigestField(snapshot, "archiveDigest"),
    archiveSizeBytes: positiveIntegerField(snapshot, "archiveSizeBytes"),
  };
}

function sourceSyncArchiveObjectKey(requestPayload: unknown): string {
  if (!isRecord(requestPayload)) {
    throw new Error("source_sync request is required");
  }
  const source = recordField(requestPayload, "source");
  const archiveObjectKey =
    stringField(requestPayload, "archiveObjectKey") ??
    (source ? stringField(source, "archiveObjectKey") : undefined);
  if (!archiveObjectKey) {
    throw new Error("source_sync archiveObjectKey is required");
  }
  assertSafeSourceArchiveKey(archiveObjectKey);
  return archiveObjectKey;
}

// Re-assert the R2_SOURCE archive key (agreed layout
// spaces/{spaceId}/sources/{sourceId}/snapshots/{snapshotId}/source.tar.zst) is
// a safe, traversal-free relative key before writing to the bucket.
function assertSafeSourceArchiveKey(key: string): void {
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("..") ||
    key.includes("\0") ||
    key.includes("\\") ||
    !key.startsWith("spaces/")
  ) {
    throw new Error(`unsafe source archive object key: ${key}`);
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
  if (
    typeof field !== "number" ||
    !Number.isSafeInteger(field) ||
    field <= 0
  ) {
    throw new Error(`${key} must be a positive integer`);
  }
  return field;
}

function planArtifactKey(runId: string, scope?: StateScope): string {
  if (scope) {
    return `spaces/${safeKeySegment(scope.workspaceId)}/installations/${safeKeySegment(
      scope.capsuleId,
    )}/runs/${safeKeySegment(runId)}/plan.bin`;
  }
  return `opentofu-plan-runs/${runId.replace(/[^a-zA-Z0-9._-]+/g, "_")}/tfplan`;
}

function planJsonArtifactKey(runId: string, scope?: StateScope): string {
  if (scope) {
    return `spaces/${safeKeySegment(scope.workspaceId)}/installations/${safeKeySegment(
      scope.capsuleId,
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
    /^spaces\/[^/]+\/installations\/[^/]+\/runs\/[^/]+\/plan\.bin$/.test(key);
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
  const capsuleId =
    stringField(planRun, "capsuleId") ?? stringField(planRun, "installationId");
  if (capsuleId) {
    keys.push(
      `${backendKey}/installations/${safeKeySegment(capsuleId)}/terraform.tfstate`,
    );
  }
  const source = recordField(planRun, "source");
  const sourceKey = await sourceStateKey({
    backendKey,
    // `spaceId` here is the frozen `sourceIdentity` digest field; only the read
    // value is canonical-first (the value is the same workspace id either way).
    spaceId:
      stringField(planRun, "workspaceId") ?? stringField(planRun, "spaceId"),
    runnerProfileId: stringField(planRun, "runnerProfileId"),
    source,
  });
  if (sourceKey) keys.push(sourceKey);
  return Array.from(new Set(keys));
}

async function sourceStateKey(input: {
  readonly backendKey: string;
  readonly spaceId: string | undefined;
  readonly runnerProfileId: string | undefined;
  readonly source: Record<string, unknown> | undefined;
}): Promise<string | undefined> {
  if (!input.spaceId || !input.runnerProfileId || !input.source)
    return undefined;
  const sourceIdentity = {
    spaceId: input.spaceId,
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
