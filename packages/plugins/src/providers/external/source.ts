import type { source } from "takosumi-contract/reference/compat";
import {
  bytesFromBody,
  freezeClone,
  sha256Digest,
  stableJsonDigest,
} from "./common.ts";
import type { ExternalObjectClient } from "./object_storage.ts";

export interface ExternalSourceClient<TInput = unknown> {
  snapshot(input: TInput): Promise<ExternalSourceCapture>;
}

export interface ExternalSourceCapture {
  readonly id?: string;
  readonly kind?: source.SourceSnapshotKind;
  readonly manifest: source.SourceSnapshot["manifest"];
  readonly files?: readonly ExternalSourceFile[];
  readonly metadata?: Record<string, unknown>;
}

export interface ExternalSourceFile {
  readonly path: string;
  readonly bytes: Uint8Array | string;
  readonly contentType?: string;
}

export interface ExternalSourceAdapterOptions<TInput = unknown> {
  readonly client?: ExternalSourceClient<TInput>;
  readonly objectClient?: ExternalObjectClient;
  readonly artifactBucket?: string;
  readonly artifactPrefix?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export class ExternalSourceAdapter<TInput = unknown>
  implements source.SourcePort<TInput | ExternalSourceCapture> {
  readonly #client?: ExternalSourceClient<TInput>;
  readonly #objectClient?: ExternalObjectClient;
  readonly #artifactBucket?: string;
  readonly #artifactPrefix: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: ExternalSourceAdapterOptions<TInput> = {}) {
    this.#client = options.client;
    this.#objectClient = options.objectClient;
    this.#artifactBucket = options.artifactBucket;
    this.#artifactPrefix = options.artifactPrefix ?? "sources";
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async snapshot(
    input: TInput | ExternalSourceCapture,
  ): Promise<source.SourceSnapshot> {
    const capture = isCapture(input)
      ? input
      : await this.#requireClient().snapshot(input as TInput);
    const id = capture.id ?? `source_external_${this.#idGenerator()}`;
    const files = await Promise.all((capture.files ?? []).map(async (file) => {
      const bytes = bytesFromBody(file.bytes);
      const digest = await sha256Digest(bytes);
      if (this.#objectClient && this.#artifactBucket) {
        await this.#objectClient.putObject({
          bucket: this.#artifactBucket,
          key: `${this.#artifactPrefix}/${id}/${file.path}`,
          body: bytes,
          contentType: file.contentType,
          metadata: { sourceId: id, sourcePath: file.path },
          digest,
        });
      }
      return {
        path: file.path,
        contentType: file.contentType,
        bytes,
        digest,
      };
    }));
    const manifestDigest = await stableJsonDigest(capture.manifest);
    const sourceDigest = await stableJsonDigest({
      manifestDigest,
      files: files.map((file) => ({ path: file.path, digest: file.digest })),
    });
    return freezeClone({
      id,
      kind: capture.kind ?? "local_upload",
      manifest: capture.manifest,
      files,
      metadata: {
        ...(capture.metadata ?? {}),
        manifestDigest,
        sourceDigest,
        artifactBucket: this.#artifactBucket,
      },
      createdAt: this.#clock().toISOString(),
      immutable: true,
    });
  }

  #requireClient(): ExternalSourceClient<TInput> {
    if (!this.#client) {
      throw new Error("external source adapter requires a source client");
    }
    return this.#client;
  }
}

function isCapture(input: unknown): input is ExternalSourceCapture {
  return !!input && typeof input === "object" && "manifest" in input;
}
