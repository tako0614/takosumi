export type DeployControlErrorCode =
  | "invalid_argument"
  | "unauthenticated"
  | "permission_denied"
  | "not_found"
  | "failed_precondition"
  | "resource_exhausted"
  | "not_implemented"
  | "internal_error";

export type DeployControlErrorHttpStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 500
  | 501;

export const DEPLOY_CONTROL_ERROR_CODES = [
  "invalid_argument",
  "unauthenticated",
  "permission_denied",
  "not_found",
  "failed_precondition",
  "resource_exhausted",
  "not_implemented",
  "internal_error",
] as const satisfies readonly DeployControlErrorCode[];

export const DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  failed_precondition: 409,
  resource_exhausted: 413,
  not_implemented: 501,
  internal_error: 500,
} as const satisfies Record<
  DeployControlErrorCode,
  DeployControlErrorHttpStatus
>;

export interface DeployControlErrorEnvelope {
  readonly error: {
    readonly code: DeployControlErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}

export type TakosumiApiErrorCode = DeployControlErrorCode;
export type TakosumiApiErrorHttpStatus = DeployControlErrorHttpStatus;
export type TakosumiApiErrorEnvelope = DeployControlErrorEnvelope;
