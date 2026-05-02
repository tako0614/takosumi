import { objectStorage, type source } from "takosumi-contract";

export interface CloudflareR2SourceFileInput {
  readonly path: string;
  readonly body: Uint8Array | string;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}

export interface CloudflareR2SourceSnapshotInput {
  readonly manifest: source.SourceSnapshot["manifest"];
  readonly sourceId?: string;
  readonly bucket?: string;
  readonly prefix?: string;
  readonly files?: readonly CloudflareR2SourceFileInput[];
  readonly metadata?: Record<string, unknown>;
}

export interface CloudflareR2SourceAdapterOptions {
  readonly objectStorage: objectStorage.ObjectStoragePort;
  readonly bucket: string;
  readonly prefix?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export class CloudflareR2SourceAdapter
  implements source.SourcePort<CloudflareR2SourceSnapshotInput> {
  readonly #objectStorage: objectStorage.ObjectStoragePort;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: CloudflareR2SourceAdapterOptions) {
    this.#objectStorage = options.objectStorage;
    this.#bucket = options.bucket;
    this.#prefix = trimSlashes(options.prefix ?? "sources");
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async snapshot(
    input: CloudflareR2SourceSnapshotInput,
  ): Promise<source.SourceSnapshot> {
    const sourceId = input.sourceId ?? `source_cf_${this.#idGenerator()}`;
    const bucket = input.bucket ?? this.#bucket;
    const prefix = trimSlashes(input.prefix ?? this.#prefix);
    const baseKey = prefix ? `${prefix}/${sourceId}` : sourceId;
    const manifestBody = JSON.stringify(input.manifest);
    const manifestHead = await this.#objectStorage.putObject({
      bucket,
      key: `${baseKey}/manifest.json`,
      body: manifestBody,
      contentType: "application/json",
      metadata: { sourceId, role: "manifest" },
    });

    const files: source.SourceFileSnapshot[] = [];
    for (const file of input.files ?? []) {
      const bytes = objectStorage.objectBodyBytes(file.body);
      const head = await this.#objectStorage.putObject({
        bucket,
        key: `${baseKey}/files/${normalizeRelativePath(file.path)}`,
        body: bytes,
        contentType: file.contentType,
        metadata: {
          ...(file.metadata ?? {}),
          sourceId,
          sourcePath: file.path,
        },
      });
      files.push({
        path: file.path,
        contentType: file.contentType,
        bytes,
        digest: head.digest,
      });
    }

    return deepFreeze({
      id: sourceId,
      kind: "manifest",
      manifest: structuredClone(input.manifest),
      files,
      metadata: {
        ...(input.metadata ?? {}),
        provider: "cloudflare",
        storage: "r2",
        bucket,
        prefix,
        manifestObjectKey: manifestHead.key,
        manifestDigest: manifestHead.digest,
        sourceDigest: manifestHead.digest,
      },
      createdAt: this.#clock().toISOString(),
      immutable: true,
    });
  }
}

function normalizeRelativePath(path: string): string {
  const normalized = path.split("/").filter((part) =>
    part.length > 0 && part !== "." && part !== ".."
  ).join("/");
  if (!normalized) throw new Error("source file path must not be empty");
  return normalized;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return value;
    }
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
