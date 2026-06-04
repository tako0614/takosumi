export function readNested(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function readNestedString(
  value: unknown,
  path: readonly string[],
): string | undefined {
  const result = readNested(value, path);
  return typeof result === "string" ? result : undefined;
}

export function readNestedRecord(
  value: unknown,
  path: readonly string[],
): Record<string, unknown> | undefined {
  const result = readNested(value, path);
  return typeof result === "object" && result !== null && !Array.isArray(result)
    ? result as Record<string, unknown>
    : undefined;
}

export function readNestedArray(
  value: unknown,
  path: readonly string[],
): readonly unknown[] {
  const result = readNested(value, path);
  return Array.isArray(result) ? result : [];
}
