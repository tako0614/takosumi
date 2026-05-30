import type { PublicDeployManifest } from "../../domains/deploy/mod.ts";
import { deepFreeze, stableJsonDigest } from "./digest.ts";
import type { SourcePort, SourceSnapshot } from "./types.ts";

export interface ImmutableManifestSourceInput {
  readonly manifest: PublicDeployManifest;
  readonly sourceId?: string;
  readonly metadata?: Record<string, unknown>;
}

export class ImmutableManifestSourceAdapter
  implements SourcePort<ImmutableManifestSourceInput> {
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(
    options: {
      readonly clock?: () => Date;
      readonly idGenerator?: () => string;
    } = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async snapshot(input: ImmutableManifestSourceInput): Promise<SourceSnapshot> {
    const manifest = structuredClone(input.manifest);
    const manifestDigest = await stableJsonDigest(manifest);
    return deepFreeze({
      id: input.sourceId ?? `source_manifest_${this.#idGenerator()}`,
      kind: "manifest",
      manifest,
      files: [],
      metadata: {
        ...(input.metadata ?? {}),
        manifestDigest,
        sourceDigest: manifestDigest,
      },
      createdAt: this.#clock().toISOString(),
      immutable: true,
    });
  }
}
