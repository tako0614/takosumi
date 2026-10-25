export type DomainErrorCode =
  | "invalid_argument"
  | "not_found"
  | "conflict"
  | "permission_denied"
  | "not_implemented";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function invalidArgument(
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return new DomainError("invalid_argument", message, details);
}

export function notFound(
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return new DomainError("not_found", message, details);
}

export function conflict(
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return new DomainError("conflict", message, details);
}

export function permissionDenied(
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return new DomainError("permission_denied", message, details);
}

export function notImplemented(
  message: string,
  details?: Record<string, unknown>,
): DomainError {
  return new DomainError("not_implemented", message, details);
}

/**
 * Extract a human-readable message from an unknown thrown value, falling back
 * to a string coercion for non-`Error` throwables. Shared so service-side
 * call sites do not each re-declare the same one-liner.
 */
export function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      return readErrorDataString(error, "message") ??
        "[unprintable thrown value]";
    }
    return String(error);
  } catch {
    return "[unprintable thrown value]";
  }
}

/** Read an Error diagnostic without invoking an accessor on its prototype chain. */
export function readErrorDataString(
  error: Error,
  key: "name" | "message" | "stack",
): string | undefined {
  try {
    let owner: object | null = error;
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) {
        return "value" in descriptor && typeof descriptor.value === "string"
          ? descriptor.value
          : undefined;
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch {
    // A Proxy may reject even descriptor inspection. It has no safe diagnostic.
  }
  return undefined;
}
