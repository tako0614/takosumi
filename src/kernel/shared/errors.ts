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
