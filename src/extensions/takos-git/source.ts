/**
 * Takos-Git source snapshot adapter.
 *
 * Operators that run a Takos-Git server and want PaaS deployments to source
 * their manifests from a Takos-Git repository inject an instance of
 * `TakosGitSourceSnapshotAdapter` as the kernel's `source` port. The adapter
 * speaks the Takos internal RPC contract via an injected `TakosInternalRpcClient`.
 *
 * This file is intentionally NOT imported by any default Takosumi profile.
 */

export interface TakosGitSourceFileSnapshot {
  readonly path: string;
  readonly contentType?: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export interface TakosGitSourceManifest {
  readonly name: string;
  readonly [key: string]: unknown;
}

export interface TakosGitSourceSnapshot {
  readonly id: string;
  readonly kind: "git";
  readonly manifest: TakosGitSourceManifest;
  readonly files: readonly TakosGitSourceFileSnapshot[];
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly immutable: true;
}

export interface TakosGitSourcePort<TInput = TakosGitSourceSnapshotInput> {
  snapshot(input: TInput): Promise<TakosGitSourceSnapshot>;
}

export interface TakosGitSourceSnapshotInput {
  readonly actor: TakosGitActorContext;
  readonly repository_id: string;
  readonly ref: string;
  readonly path?: string;
  readonly manifest_path?: string;
}

export interface TakosGitActorContext {
  readonly subject: string;
  readonly capabilities?: readonly string[];
  readonly tenantId?: string;
  readonly groupId?: string;
}

export interface TakosGitInternalRpcRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
  readonly actor: TakosGitActorContext;
  readonly capabilities?: readonly string[];
}

export interface TakosGitInternalRpcResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface TakosGitInternalRpcClient {
  request(
    input: TakosGitInternalRpcRequest,
  ): Promise<TakosGitInternalRpcResponse>;
}

export interface TakosGitSourceExtensionOptions {
  readonly client: TakosGitInternalRpcClient;
  readonly snapshotPath?: string;
  readonly capability?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

const DEFAULT_SNAPSHOT_PATH = "/internal/git/source-snapshot";
const DEFAULT_CAPABILITY = "takos-git.source.snapshot";

/**
 * Factory the Takos-Git operator calls when wiring up the kernel. Returns the
 * adapter ready to be registered as the kernel's `source` port. Generic
 * Takosumi consumers never construct this.
 */
export function createTakosGitSourceExtension(
  options: TakosGitSourceExtensionOptions,
): TakosGitSourceSnapshotAdapter {
  return new TakosGitSourceSnapshotAdapter(options);
}

export class TakosGitSourceSnapshotAdapter
  implements TakosGitSourcePort<TakosGitSourceSnapshotInput> {
  readonly #client: TakosGitInternalRpcClient;
  readonly #snapshotPath: string;
  readonly #capability: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: TakosGitSourceExtensionOptions) {
    this.#client = options.client;
    this.#snapshotPath = options.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
    this.#capability = options.capability ?? DEFAULT_CAPABILITY;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async snapshot(
    input: TakosGitSourceSnapshotInput,
  ): Promise<TakosGitSourceSnapshot> {
    const body = JSON.stringify({
      repositoryId: input.repository_id,
      sourceRef: input.ref,
      path: input.path,
      manifestPath: input.manifest_path,
    });
    const response = await this.#client.request({
      method: "POST",
      path: this.#snapshotPath,
      body,
      actor: input.actor,
      capabilities: [this.#capability],
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `takos-git source snapshot failed: ${response.status}${
          detail ? ` ${detail}` : ""
        }`,
      );
    }
    const payload = await response.json() as TakosGitSnapshotPayload;
    const manifest = parseManifestFromSnapshot(payload);
    const manifestDigest = await stableJsonDigest(manifest);
    const sourceDigest = normalizeDigest(payload.digest ?? payload.sha256) ??
      manifestDigest;
    const commitSha = optionalString(payload.commitSha) ??
      optionalString(payload.commit_sha);
    const immutableSourceRef = optionalString(payload.source_ref) ??
      optionalString(payload.immutable_ref) ??
      buildImmutableSourceRef({ ...input, commitSha });
    const files = await normalizeFiles(payload);
    return Object.freeze({
      id: optionalString(payload.id) ?? optionalString(payload.snapshot_id) ??
        `source_git_${this.#idGenerator()}`,
      kind: "git" as const,
      manifest,
      files,
      metadata: {
        ...(payload.metadata ?? {}),
        repository_id: optionalString(payload.repositoryId) ??
          optionalString(payload.repository_id) ?? input.repository_id,
        ref: optionalString(payload.ref) ?? input.ref,
        path: optionalString(payload.path) ?? input.path,
        manifest_path: optionalString(payload.manifestPath) ??
          optionalString(payload.manifest_path) ?? input.manifest_path,
        commit_sha: commitSha,
        manifestDigest,
        sourceDigest,
        source_ref: immutableSourceRef,
      },
      createdAt: optionalString(payload.createdAt) ??
        optionalString(payload.created_at) ??
        optionalString(payload.captured_at) ?? this.#clock().toISOString(),
      immutable: true as const,
    });
  }
}

interface TakosGitSnapshotPayload {
  readonly id?: string;
  readonly snapshot_id?: string;
  readonly files?: readonly TakosGitFilePayload[];
  readonly digest?: string;
  readonly sha256?: string;
  readonly source_ref?: string;
  readonly immutable_ref?: string;
  readonly commit_sha?: string;
  readonly commitSha?: string;
  readonly repository_id?: string;
  readonly repositoryId?: string;
  readonly ref?: string;
  readonly path?: string;
  readonly manifest_path?: string;
  readonly manifestPath?: string;
  readonly captured_at?: string;
  readonly created_at?: string;
  readonly createdAt?: string;
  readonly metadata?: Record<string, unknown>;
  readonly manifest?: unknown;
}

interface TakosGitFilePayload {
  readonly path: string;
  readonly contentType?: string;
  readonly content_type?: string;
  readonly digest?: string;
  readonly bytes?: Uint8Array | string;
  readonly body?: Uint8Array | string;
  readonly base64?: string;
}

function parseManifestFromSnapshot(
  payload: TakosGitSnapshotPayload,
): TakosGitSourceManifest {
  const directManifest = payload.manifest;
  if (isManifestObject(directManifest)) {
    return structuredClone(directManifest) as TakosGitSourceManifest;
  }
  const content = typeof directManifest === "object" && directManifest !== null
    ? optionalString((directManifest as { content?: unknown }).content)
    : undefined;
  if (!content) {
    throw new Error("takos-git source snapshot response missing manifest");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      "takos-git source snapshot manifest must be JSON (YAML support requires the parser to be injected)",
    );
  }
  if (!isManifestObject(parsed)) {
    throw new Error("takos-git source snapshot manifest is invalid");
  }
  return structuredClone(parsed) as TakosGitSourceManifest;
}

function isManifestObject(
  value: unknown,
): value is TakosGitSourceManifest {
  return Boolean(
    value && typeof value === "object" &&
      typeof (value as { name?: unknown }).name === "string",
  );
}

async function normalizeFiles(
  payload: TakosGitSnapshotPayload,
): Promise<TakosGitSourceFileSnapshot[]> {
  const normalized = await Promise.all(
    (payload.files ?? []).map((file) => normalizeFile(file)),
  );
  const manifest = payload.manifest;
  if (
    typeof manifest === "object" && manifest !== null &&
    "content" in manifest &&
    typeof (manifest as { content?: unknown }).content === "string" &&
    typeof (manifest as { path?: unknown }).path === "string"
  ) {
    const bytes = new TextEncoder().encode(
      (manifest as { content: string }).content,
    );
    const file: TakosGitSourceFileSnapshot = {
      path: (manifest as unknown as { path: string }).path,
      bytes,
      digest: normalizeDigest(
        (manifest as unknown as { digest?: unknown }).digest,
      ) ?? await sha256DigestBytes(bytes),
    };
    const index = normalized.findIndex((entry) => entry.path === file.path);
    if (index >= 0 && normalized[index].bytes.byteLength === 0) {
      normalized[index] = file;
    } else if (index < 0) {
      normalized.push(file);
    }
  }
  return normalized;
}

async function normalizeFile(
  file: TakosGitFilePayload,
): Promise<TakosGitSourceFileSnapshot> {
  const bytes = file.base64
    ? base64ToBytes(file.base64)
    : toBytes(file.bytes ?? file.body ?? "");
  return {
    path: file.path,
    contentType: file.contentType ?? file.content_type,
    bytes,
    digest: normalizeDigest(file.digest) ?? await sha256DigestBytes(bytes),
  };
}

function normalizeDigest(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  return raw.startsWith("sha256:") ? raw : `sha256:${raw}`;
}

function toBytes(value: Uint8Array | string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return new TextEncoder().encode(value);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildImmutableSourceRef(input: {
  readonly repository_id: string;
  readonly ref: string;
  readonly path?: string;
  readonly manifest_path?: string;
  readonly commitSha?: string;
}): string {
  const commit = input.commitSha ?? input.ref;
  const path = input.path ? `/${encodeURIComponent(input.path)}` : "";
  const query = new URLSearchParams();
  query.set("requested_ref", input.ref);
  if (input.manifest_path) query.set("manifest_path", input.manifest_path);
  return `takos-git://repositories/${
    encodeURIComponent(input.repository_id)
  }/tree/${encodeURIComponent(commit)}${path}?${query.toString()}`;
}

async function stableJsonDigest(value: unknown): Promise<string> {
  const json = stableJsonStringify(value);
  return await sha256DigestBytes(new TextEncoder().encode(json));
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${
    entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJsonStringify(v)}`)
      .join(",")
  }}`;
}

async function sha256DigestBytes(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return `sha256:${
    Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")
  }`;
}
