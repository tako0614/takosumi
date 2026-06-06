import type { CloudflareWorkerEnv } from "./bindings.ts";

const DEFAULT_PLAN_ARTIFACT_BUCKET = "takos-artifacts";
const PLAN_ARTIFACT_CONTENT_TYPE = "application/vnd.opentofu.plan";
const STATE_ARTIFACT_CONTENT_TYPE = "application/json";
const SOURCE_ARCHIVE_CONTENT_TYPE = "application/zstd";

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

export class TakosumiOpenTofuRunner extends OpenTofuRunnerContainerBase<CloudflareWorkerEnv> {
  defaultPort = 8080;
  sleepAfter = "10m";
  pingEndpoint = "healthz";

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
    const stateKeys = await stateArtifactKeys(envelope.request);
    if (envelope.action === "apply" || envelope.action === "destroy") {
      await this.#restorePlanArtifact(runId, envelope.request, url);
    }
    if (stateKeys.length > 0) {
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
      runnerResponse.ok &&
      stateKeys.length > 0
    ) {
      await this.#persistStateArtifact(runId, stateKeys, url);
    }
    if (envelope.action !== "plan" || !runnerResponse.ok) {
      return runnerResponse;
    }
    return await this.#persistPlanArtifact(runId, runnerResponse, url);
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
    const stored = await this.env.TAKOS_ARTIFACTS.put(key, bytes, {
      httpMetadata: { contentType: PLAN_ARTIFACT_CONTENT_TYPE },
      customMetadata: {
        "takosumi-plan-run-id": runId,
        "takosumi-digest": digest,
      },
    });
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
    const object = await this.env.TAKOS_ARTIFACTS.get(key);
    if (!object) {
      throw new Error(`plan artifact object not found: ${key}`);
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const digest = await digestBytes(bytes);
    const expectedDigest = requiredStringField(artifact, "digest");
    if (digest !== expectedDigest) {
      throw new Error(`stored plan artifact digest mismatch: ${digest}`);
    }
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

  async #restoreStateArtifact(
    runId: string,
    keys: readonly string[],
    baseUrl: URL,
  ): Promise<void> {
    for (const key of keys) {
      const object = await this.env.TAKOS_ARTIFACTS.get(key);
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
      await this.env.TAKOS_ARTIFACTS.put(key, bytes, {
        httpMetadata: { contentType: STATE_ARTIFACT_CONTENT_TYPE },
        customMetadata: {
          "takosumi-run-id": runId,
          "takosumi-digest": digest,
        },
      });
    }
  }

  #planArtifactBucket(): string {
    const configured = this.env.TAKOS_ARTIFACTS_BUCKET_NAME;
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
