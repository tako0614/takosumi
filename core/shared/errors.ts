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
  return error instanceof Error ? error.message : String(error);
}
