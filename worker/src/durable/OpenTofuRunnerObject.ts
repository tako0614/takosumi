import type { CloudflareWorkerEnv } from "../bindings.ts";
import { StateArtifactCrypto } from "../state_crypto.ts";

const DEFAULT_PLAN_ARTIFACT_BUCKET = "takos-artifacts";
const PLAN_ARTIFACT_CONTENT_TYPE = "application/vnd.opentofu.plan";
const STATE_ARTIFACT_CONTENT_TYPE = "application/json";
const SOURCE_ARCHIVE_CONTENT_TYPE = "application/zstd";
// At-rest content type for AES-GCM ciphertext blobs (state/plan .enc objects).
const ENCRYPTED_ARTIFACT_CONTENT_TYPE = "application/octet-stream";

/**
 * Optional dispatch payload field locating the R2_STATE object for this run.
 * Present from M2 when the controller (other lane) carries environment context
 * in the job. When ABSENT the DO falls back to the legacy R2_ARTIFACTS
 * `opentofu-state/...` path so existing jobs/tests keep working (additive, no
 * flag-day). The `generation` is the 8-digit state generation the controller
 * owns; the DO only writes the object at the derived key and returns its digest.
 */
interface StateScope {
  readonly spaceId: string;
  readonly appId: string;
  readonly envId: string;
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

export interface ContainerRequestFetcher {
  containerFetch(request: Request, port?: number): Promise<Response>;
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
    const runtime = (await import("@cloudflare/containers")) as ContainerRuntimeModule;
    return runtime.Container ?? LocalContainerRuntime;
  } catch {
    return LocalContainerRuntime;
  }
}

const OpenTofuRunnerContainerBase = await loadContainerRuntime();
const containerRuntimeAvailable = OpenTofuRunnerContainerBase !==
  LocalContainerRuntime;

export class OpenTofuRunnerObject extends OpenTofuRunnerContainerBase<CloudflareWorkerEnv> {
  defaultPort = 8080;
  sleepAfter = "10m";
  pingEndpoint = "healthz";

  #stateCryptoInstance: StateArtifactCrypto | undefined;

  constructor(ctx: ContainerHostContext, env: CloudflareWorkerEnv) {
    super(ctx, env);
    this.envVars = {
      TAKOSUMI_OPENTOFU_RUNNER: "cloudflare-container",
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#containerRuntimeUnavailable()) {
      return Response.json(
        {
          error: "OpenTofu runner container runtime is unavailable",
          detail: "Cloudflare Containers runtime is unavailable in this environment",
        },
        { status: 501 },
      );
    }
    try {
      return await this.#fetchWithDurablePlanArtifacts(request);
    } catch (error) {
      return Response.json(
        {
          error: "OpenTofu runner artifact relay failed",
          detail: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
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

  async #fetchWithDurablePlanArtifacts(
    request: Request,
  ): Promise<Response> {
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
      return await this.#fetchWithSourceArchive(runId, request, bodyText);
    }
    // M2: when the dispatch carries an environment-scoped state location, route
    // state through R2_STATE (encrypted at rest, spec keys); otherwise fall back
    // to the legacy R2_ARTIFACTS state path so older jobs/tests keep working.
    const stateScope = parseStateScope(envelope.request);
    const sourceArchive = parseSourceArchiveRestore(envelope.request);
    const stateKeys = stateScope ? [] : await stateArtifactKeys(envelope.request);
    // M2: restore the snapshotted source tree into the container before any
    // build/plan phase (mirrors the plan-artifact restore protocol).
    if (sourceArchive) {
      await this.#restoreSourceArchive(runId, sourceArchive, url);
    }
    if (envelope.action === "apply" || envelope.action === "destroy") {
      await this.#restorePlanArtifact(runId, envelope.request, url);
    }
    if (stateScope) {
      await this.#restoreStateFromR2State(runId, stateScope, url);
    } else if (stateKeys.length > 0) {
      await this.#restoreStateArtifact(runId, stateKeys, url);
    }
    const runnerResponse = await this.#containerFetch(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: bodyText,
      }),
    );
    if (
      (envelope.action === "apply" || envelope.action === "destroy") &&
      runnerResponse.ok
    ) {
      if (stateScope) {
        return await this.#persistStateToR2State(runId, stateScope, url, runnerResponse);
      }
      if (stateKeys.length > 0) {
        await this.#persistStateArtifact(runId, stateKeys, url);
      }
    }
    if (envelope.action !== "plan" || !runnerResponse.ok) {
      return runnerResponse;
    }
    return await this.#persistPlanArtifact(runId, runnerResponse, url);
  }

  #stateCrypto(): StateArtifactCrypto {
    this.#stateCryptoInstance ??= StateArtifactCrypto.fromEnv(
      this.env as unknown as Record<string, string | undefined>,
    );
    return this.#stateCryptoInstance;
  }

  #r2State(): CloudflareWorkerEnv["R2_STATE"] {
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
    const runnerResponse = await this.#containerFetch(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: bodyText,
      }),
    );
    if (!runnerResponse.ok) return runnerResponse;
    const payload = await readJsonObject(runnerResponse);
    const archive = recordField(payload, "sourceArchive");
    if (!archive || stringField(archive, "kind") !== "runner-local") {
      return jsonResponse(payload, runnerResponse.status);
    }
    const archiveObjectKey = requiredStringField(archive, "archiveObjectKey");
    assertSafeSourceArchiveKey(archiveObjectKey);
    const bucket = this.env.R2_SOURCE;
    if (!bucket) {
      throw new Error("R2_SOURCE binding is not configured for source archives");
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
    return jsonResponse({
      ...payload,
      sourceArchive: {
        kind: "object-storage",
        archiveObjectKey,
        digest,
        contentType: SOURCE_ARCHIVE_CONTENT_TYPE,
        sizeBytes: stored.size,
        createdAt: Date.now(),
      },
    }, runnerResponse.status);
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
      throw new Error("R2_SOURCE binding is not configured for source archives");
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
    const response = await this.#containerFetch(
      new Request(sourceArchiveRestoreUrl(baseUrl, runId), {
        method: "PUT",
        headers: { "content-type": SOURCE_ARCHIVE_CONTENT_TYPE },
        body: bytes,
      }),
    );
    if (!response.ok) {
      throw new Error(`container source archive restore failed: ${response.status}`);
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
  ): Promise<void> {
    const bucket = this.#r2State();
    const current = await readCurrentState(bucket, scope);
    if (!current) return;
    const object = await bucket.get(current.objectKey);
    if (!object) {
      throw new Error(`current state object not found: ${current.objectKey}`);
    }
    const ciphertext = new Uint8Array(await object.arrayBuffer());
    const plaintext = await this.#stateCrypto().open(ciphertext, current.digest);
    const response = await this.#containerFetch(
      new Request(stateArtifactUrl(baseUrl, runId), {
        method: "PUT",
        headers: { "content-type": STATE_ARTIFACT_CONTENT_TYPE },
        body: plaintext,
      }),
    );
    if (!response.ok) {
      throw new Error(`container state artifact restore failed: ${response.status}`);
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
  ): Promise<Response> {
    const stateResponse = await this.#containerFetch(
      new Request(stateArtifactUrl(baseUrl, runId), { method: "GET" }),
    );
    if (stateResponse.status === 404) return runnerResponse;
    if (!stateResponse.ok) {
      throw new Error(`container state artifact fetch failed: ${stateResponse.status}`);
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
    // current.json is written AFTER the state object so a partial failure never
    // leaves current.json pointing at a missing/half-written object.
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
    return jsonResponse({
      ...payload,
      state: {
        generation: scope.generation,
        objectKey,
        digest: sealed.contentDigest,
        ciphertextLength: sealed.ciphertextLength,
      },
    }, runnerResponse.status);
  }

  async #persistPlanArtifact(
    runId: string,
    runnerResponse: Response,
    baseUrl: URL,
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
    const key = planArtifactKey(runId);
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
    await this.#persistPlanJsonArtifact(runId, baseUrl);
    return jsonResponse({
      ...payload,
      planArtifact: {
        kind: "object-storage",
        ref: planArtifactRef(bucket, key),
        digest,
        contentType: PLAN_ARTIFACT_CONTENT_TYPE,
        sizeBytes: stored.size,
        createdAt: Date.now(),
      },
    }, runnerResponse.status);
  }

  // Pull the `tofu show -json tfplan` JSON from the container (when present) and
  // persist it encrypted alongside the plan binary under `<runId>/tfplan.json.enc`.
  async #persistPlanJsonArtifact(runId: string, baseUrl: URL): Promise<void> {
    const response = await this.#containerFetch(
      new Request(planJsonArtifactUrl(baseUrl, runId), { method: "GET" }),
    );
    if (response.status === 404) return;
    if (!response.ok) {
      throw new Error(`container plan-json artifact fetch failed: ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = await digestBytes(bytes);
    const sealed = await this.#stateCrypto().seal(bytes);
    await this.env.R2_ARTIFACTS.put(
      encryptedKey(planJsonArtifactKey(runId)),
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
    // The plan binary is stored encrypted at `<key>.enc` (M2). Prefer the
    // encrypted object; fall back to a legacy plaintext object so plans persisted
    // before M2 still restore. Either way verify the PLAINTEXT digest.
    const bytes = await this.#readPlanArtifactPlaintext(key, expectedDigest);
    const response = await this.#containerFetch(
      new Request(artifactUrl(baseUrl, runId), {
        method: "PUT",
        headers: { "content-type": PLAN_ARTIFACT_CONTENT_TYPE },
        body: bytes,
      }),
    );
    if (!response.ok) {
      throw new Error(`container plan artifact restore failed: ${response.status}`);
    }
  }

  async #readPlanArtifactPlaintext(
    key: string,
    expectedDigest: string,
  ): Promise<Uint8Array> {
    const encrypted = await this.env.R2_ARTIFACTS.get(encryptedKey(key));
    if (encrypted) {
      const ciphertext = new Uint8Array(await encrypted.arrayBuffer());
      return await this.#stateCrypto().open(ciphertext, expectedDigest);
    }
    const object = await this.env.R2_ARTIFACTS.get(key);
    if (!object) {
      throw new Error(`plan artifact object not found: ${key}`);
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const digest = await digestBytes(bytes);
    if (digest !== expectedDigest) {
      throw new Error(`stored plan artifact digest mismatch: ${digest}`);
    }
    return bytes;
  }

  async #restoreStateArtifact(
    runId: string,
    keys: readonly string[],
    baseUrl: URL,
  ): Promise<void> {
    for (const key of keys) {
      const object = await this.env.R2_ARTIFACTS.get(key);
      if (!object) continue;
      const bytes = new Uint8Array(await object.arrayBuffer());
      const response = await this.#containerFetch(
        new Request(stateArtifactUrl(baseUrl, runId), {
          method: "PUT",
          headers: { "content-type": STATE_ARTIFACT_CONTENT_TYPE },
          body: bytes,
        }),
      );
      if (!response.ok) {
        throw new Error(`container state artifact restore failed: ${response.status}`);
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
      throw new Error(`container state artifact fetch failed: ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = await digestBytes(bytes);
    for (const key of keys) {
      await this.env.R2_ARTIFACTS.put(key, bytes, {
        httpMetadata: { contentType: STATE_ARTIFACT_CONTENT_TYPE },
        customMetadata: {
          "takosumi-run-id": runId,
          "takosumi-digest": digest,
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

function planJsonArtifactUrl(baseUrl: URL, runId: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/runs/${encodeURIComponent(runId)}/artifacts/tfplan-json`;
  url.search = "";
  return url.toString();
}

// ===========================================================================
// R2_STATE keys (spec §11.3):
//   spaces/{spaceId}/apps/{appId}/envs/{envId}/states/{NNNNNNNN}.tfstate.enc
//   spaces/{spaceId}/apps/{appId}/envs/{envId}/states/current.json
// The generation is owned by the controller (other lane); the DO formats it as
// an 8-digit, zero-padded segment for the object key.
// ===========================================================================

function stateScopePrefix(scope: StateScope): string {
  return `spaces/${safeKeySegment(scope.spaceId)}/apps/${
    safeKeySegment(scope.appId)
  }/envs/${safeKeySegment(scope.envId)}/states`;
}

function stateObjectKey(scope: StateScope): string {
  return `${stateScopePrefix(scope)}/${formatGeneration(scope.generation)}.tfstate.enc`;
}

function currentStateKey(scope: StateScope): string {
  return `${stateScopePrefix(scope)}/current.json`;
}

function formatGeneration(generation: number): string {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error(`state generation must be a non-negative integer: ${generation}`);
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
): Promise<CurrentStatePointer | undefined> {
  const object = await bucket.get(currentStateKey(scope));
  if (!object) return undefined;
  const text = new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()));
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
    throw new Error(`current.json objectKey escapes state prefix: ${objectKey}`);
  }
  return { generation, objectKey, digest };
}

// The R2 key for the encrypted form of an artifact key (spec keys gain `.enc`).
function encryptedKey(key: string): string {
  return `${key}.enc`;
}

function parseStateScope(requestPayload: unknown): StateScope | undefined {
  const scope = recordField(requestPayload, "stateScope");
  if (!scope) return undefined;
  const spaceId = stringField(scope, "spaceId");
  const appId = stringField(scope, "appId");
  const envId = stringField(scope, "envId");
  const generation = scope.generation;
  if (!spaceId || !appId || !envId || typeof generation !== "number") {
    throw new Error(
      "stateScope requires spaceId, appId, envId, and a numeric generation",
    );
  }
  return { spaceId, appId, envId, generation };
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
  const objectKey = stringField(archive, "objectKey") ??
    stringField(archive, "archiveObjectKey");
  const digest = stringField(archive, "digest");
  if (!objectKey || !digest) return undefined;
  return { objectKey, digest };
}

function isSourceSyncEnvelope(envelope: {
  readonly action: string | undefined;
  readonly request: unknown;
}): boolean {
  if (envelope.action === "source_sync") return true;
  const request = envelope.request;
  return isRecord(request) && stringField(request, "action") === "source_sync";
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

function planArtifactKey(runId: string): string {
  return `opentofu-plan-runs/${runId.replace(/[^a-zA-Z0-9._-]+/g, "_")}/tfplan`;
}

function planJsonArtifactKey(runId: string): string {
  return `opentofu-plan-runs/${
    runId.replace(/[^a-zA-Z0-9._-]+/g, "_")
  }/tfplan.json`;
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
  if (!key.startsWith("opentofu-plan-runs/") || key.includes("..")) {
    throw new Error(`unsafe plan artifact key: ${key}`);
  }
  return key;
}

async function stateArtifactKeys(requestPayload: unknown): Promise<readonly string[]> {
  const planRun = recordField(requestPayload, "planRun");
  if (!planRun) return [];
  const backendKey = await stateBackendKey(requestPayload);
  const keys: string[] = [];
  const installationId = stringField(planRun, "installationId");
  if (installationId) {
    keys.push(`${backendKey}/installations/${safeKeySegment(installationId)}/terraform.tfstate`);
  }
  const source = recordField(planRun, "source");
  const sourceKey = await sourceStateKey({
    backendKey,
    spaceId: stringField(planRun, "spaceId"),
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
  if (!input.spaceId || !input.runnerProfileId || !input.source) return undefined;
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
    ? stringField(stateBackend, "ref") ?? stringField(stateBackend, "kind")
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

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const value = text.length > 0 ? JSON.parse(text) as unknown : {};
  if (isRecord(value)) return value;
  throw new Error("OpenTofu runner response must be a JSON object");
}

function jsonResponse(payload: unknown, status: number): Response {
  return Response.json(payload, { status });
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
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

function requiredStringField(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key);
  if (!field) throw new Error(`${key} is required`);
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${
    Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
}

async function digestText(text: string): Promise<string> {
  return await digestBytes(new TextEncoder().encode(text));
}
