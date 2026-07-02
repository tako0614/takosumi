export interface MobileNumberOptions {
  readonly acceptString?: boolean;
  readonly integer?: boolean;
  readonly min?: number;
}

export function mobileRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function mobileNumber(
  value: unknown,
  options: MobileNumberOptions = {},
): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : options.acceptString && typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  const number = options.integer ? Math.trunc(parsed) : parsed;
  if (typeof options.min === "number" && number < options.min) {
    return undefined;
  }
  return number;
}
