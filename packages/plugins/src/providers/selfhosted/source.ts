import type { source } from "takosumi-contract";
import {
  bytesFromBody,
  freezeClone,
  sha256Digest,
  stableJsonDigest,
} from "./common.ts";
import type { SelfHostedObjectClient } from "./object_storage.ts";

export interface SelfHostedSourceClient<TInput = unknown> {
  snapshot(input: TInput): Promise<SelfHostedSourceCapture>;
}

export interface SelfHostedSourceCapture {
  readonly id?: string;
  readonly kind?: source.SourceSnapshotKind;
  readonly manifest: source.SourceSnapshot["manifest"];
  readonly files?: readonly SelfHostedSourceFile[];
  readonly metadata?: Record<string, unknown>;
}

export interface SelfHostedSourceFile {
  readonly path: string;
  readonly bytes: Uint8Array | string;
  readonly contentType?: string;
}

export interface SelfHostedSourceAdapterOptions<TInput = unknown> {
  readonly client?: SelfHostedSourceClient<TInput>;
  readonly objectClient?: SelfHostedObjectClient;
  readonly artifactBucket?: string;
  readonly artifactPrefix?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export class SelfHostedSourceAdapter<TInput = unknown>
  implements source.SourcePort<TInput | SelfHostedSourceCapture> {
  readonly #client?: SelfHostedSourceClient<TInput>;
  readonly #objectClient?: SelfHostedObjectClient;
  readonly #artifactBucket?: string;
  readonly #artifactPrefix: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: SelfHostedSourceAdapterOptions<TInput> = {}) {
    this.#client = options.client;
    this.#objectClient = options.objectClient;
    this.#artifactBucket = options.artifactBucket;
    this.#artifactPrefix = options.artifactPrefix ?? "sources";
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async snapshot(
    input: TInput | SelfHostedSourceCapture,
  ): Promise<source.SourceSnapshot> {
    const capture = isCapture(input)
      ? input
      : await this.#requireClient().snapshot(input as TInput);
    const id = capture.id ?? `source_selfhosted_${this.#idGenerator()}`;
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

  #requireClient(): SelfHostedSourceClient<TInput> {
    if (!this.#client) {
      throw new Error("selfhosted source adapter requires a source client");
    }
    return this.#client;
  }
}

function isCapture(input: unknown): input is SelfHostedSourceCapture {
  return !!input && typeof input === "object" && "manifest" in input;
}
