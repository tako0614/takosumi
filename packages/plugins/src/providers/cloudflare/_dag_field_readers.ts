/**
 * Field readers for runtime DAG entries (resources / workloads / routes).
 *
 * The kernel passes `RuntimeDesiredState` instances whose resource / workload
 * / route entries are contract-typed with a narrow common shape; individual
 * shape providers (KV namespaces, Vectorize indexes, custom hostnames, …)
 * receive extra provider-specific fields that the contract does not declare.
 * Each provider used to reach into those extras via
 * `entry as unknown as { provider-specific shape }`, which both bypassed
 * runtime validation and would have silently produced wrongly-typed metadata
 * when an upstream component shipped a malformed entry.
 *
 * These readers narrow a single field on an `unknown`-typed entry into a
 * concrete primitive at runtime, returning `undefined` for missing or
 * mis-typed values so the caller can fall back to defaults without a
 * landmine cast.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function readStringField(
  source: unknown,
  key: string,
): string | undefined {
  const record = asRecord(source);
  if (!record) return undefined;
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function readNumberField(
  source: unknown,
  key: string,
): number | undefined {
  const record = asRecord(source);
  if (!record) return undefined;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function readBooleanField(
  source: unknown,
  key: string,
): boolean | undefined {
  const record = asRecord(source);
  if (!record) return undefined;
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Read a field that may carry either a `string` or a `Uint8Array`. Used by
 * worker / workflow extractors where the script payload can arrive in
 * either form.
 */
export function readStringOrBytesField(
  source: unknown,
  key: string,
): string | Uint8Array | undefined {
  const record = asRecord(source);
  if (!record) return undefined;
  const value = record[key];
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  return undefined;
}

/**
 * Read a field whose value should be a `Record<string, unknown>` (e.g. a
 * `bindings` map). Returns `undefined` for missing, null, array, or
 * primitive values.
 */
export function readRecordField(
  source: unknown,
  key: string,
): Record<string, unknown> | undefined {
  const record = asRecord(source);
  if (!record) return undefined;
  return asRecord(record[key]);
}

/**
 * Read a field whose value should be a readonly array of strings.
 * Mis-typed elements are filtered out so the caller never receives a
 * non-string in the array.
 */
export function readStringArrayField(
  source: unknown,
  key: string,
): readonly string[] | undefined {
  const record = asRecord(source);
  if (!record) return undefined;
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((item): item is string =>
    typeof item === "string"
  );
  return filtered.length === value.length ? filtered : undefined;
}

/**
 * Read a string field constrained to a known finite set of literal values.
 * Returns `undefined` for missing or out-of-set values; callers must apply
 * their own default.
 */
export function readEnumField<T extends string>(
  source: unknown,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = readStringField(source, key);
  if (value === undefined) return undefined;
  return (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}
