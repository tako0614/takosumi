import type { JsonObject } from "takosumi-contract/reference/compat";
import { stableJsonDigest } from "./digest.ts";
import { freeze } from "../../shared/freeze.ts";
import type { SourcePort, SourceSnapshot } from "./types.ts";

export interface ImmutableSourceInput {
  readonly source: JsonObject;
  readonly sourceId?: string;
  readonly metadata?: Record<string, unknown>;
}

export class ImmutableSourceAdapter implements SourcePort<ImmutableSourceInput> {
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

  async snapshot(input: ImmutableSourceInput): Promise<SourceSnapshot> {
    const source = structuredClone(input.source);
    const sourceDigest = await stableJsonDigest(source);
    return freeze({
      id: input.sourceId ?? `source_${this.#idGenerator()}`,
      kind: "source",
      source,
      files: [],
      metadata: {
        ...(input.metadata ?? {}),
        sourceDigest,
      },
      createdAt: this.#clock().toISOString(),
      immutable: true,
    });
  }
}
