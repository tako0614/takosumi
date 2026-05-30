import type {
  LocalOperatorConfigInputValue,
  OperatorConfigPort,
  OperatorConfigSnapshot,
  OperatorConfigSource,
  OperatorConfigValue,
} from "./types.ts";

export interface LocalOperatorConfigOptions {
  readonly values?: Record<string, LocalOperatorConfigInputValue>;
  readonly source?: OperatorConfigSource;
  readonly clock?: () => Date;
}

export class LocalOperatorConfig implements OperatorConfigPort {
  readonly #values: ReadonlyMap<string, OperatorConfigValue>;
  readonly #clock: () => Date;

  constructor(options: LocalOperatorConfigOptions = {}) {
    const source = options.source ?? "local";
    this.#clock = options.clock ?? (() => new Date());
    this.#values = new Map(
      Object.entries(options.values ?? {}).map(([key, value]) => [
        key,
        normalizeValue(key, value, source),
      ]),
    );
  }

  get(key: string): Promise<OperatorConfigValue | undefined> {
    return Promise.resolve(cloneValue(this.#values.get(key)));
  }

  async require(key: string): Promise<OperatorConfigValue> {
    const value = await this.get(key);
    if (!value) {
      throw new Error(`operator config value not found: ${key}`);
    }
    return value;
  }

  snapshot(): Promise<OperatorConfigSnapshot> {
    return Promise.resolve(Object.freeze({
      generatedAt: this.#clock().toISOString(),
      values: [...this.#values.values()].map(cloneValue),
    }));
  }
}

export function normalizeValue(
  key: string,
  value: LocalOperatorConfigInputValue,
  source: OperatorConfigSource,
): OperatorConfigValue {
  if (typeof value === "string") {
    return Object.freeze({ kind: "plain", key, source, value });
  }
  return Object.freeze({
    kind: "secret-ref",
    key,
    source,
    ref: Object.freeze({ ...value }),
    redacted: true,
  });
}

export function cloneValue<T extends OperatorConfigValue | undefined>(
  value: T,
): T {
  return value ? Object.freeze(structuredClone(value)) as T : value;
}
