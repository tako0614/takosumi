/**
 * Shared error primitive for the deploy-control domain.
 *
 * `OpenTofuControllerError` is thrown by the controller, validation, policy,
 * and projection concerns alike, so it lives in its own module to avoid a
 * cyclic dependency between those sibling files and `mod.ts`.
 */

import type { DeployControlErrorCode } from "@takosumi/internal/deploy-control-api";
import { ConnectionVaultError } from "../../adapters/vault/mod.ts";

// Re-exported from the shared guard home so deploy-control consumers can keep
// importing `isRecord` from this module while there is a single canonical
// (non-array) definition for the whole service.
export { isRecord } from "../../shared/mod.ts";

export type OpenTofuControllerErrorCode = DeployControlErrorCode;

/**
 * Stable semantic reasons carried in `OpenTofuControllerError.details.reason`.
 *
 * The HTTP-shaped controller error code deliberately stays coarse. Run
 * diagnostics and clients use these provider-neutral reasons for behavior and
 * keep `Error.message` as redacted display prose only.
 */
export const PROVIDER_CONNECTION_NOT_READY_REASON =
  "provider_connection_not_ready";
export const PROVIDER_CONNECTION_SETUP_REQUIRED_REASON =
  "provider_connection_setup_required";
export const PROVIDER_CONNECTION_CHANGED_REASON = "provider_connection_changed";
export const CREDENTIAL_SERVICE_UNAVAILABLE_REASON =
  "credential_service_unavailable";
export const CREDENTIAL_MINT_FAILED_REASON = "credential_mint_failed";
export const CREDENTIAL_POLICY_FAILED_REASON = "credential_policy_failed";

const STRUCTURED_ERROR_REASON_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;

export class OpenTofuControllerError extends Error {
  readonly code: OpenTofuControllerErrorCode;
  readonly details: unknown;

  constructor(
    code: OpenTofuControllerErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "OpenTofuControllerError";
    this.code = code;
    this.details = details;
  }
}

/**
 * A non-retryable runner failure with an adapter-supplied machine reason.
 * Runner transports translate their own response protocol into this boundary;
 * Core never recovers a reason by parsing stderr or an exception message.
 */
export class OpenTofuRunnerExecutionError extends Error {
  readonly reason?: string;
  readonly originalError?: unknown;

  constructor(
    message: string,
    options: {
      readonly reason?: string;
      readonly originalError?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "OpenTofuRunnerExecutionError";
    this.reason = options.reason;
    this.originalError = options.originalError;
  }
}

/** Stable reason used when a Run must wait for an immutable SourceSnapshot. */
export const SOURCE_SYNC_REQUIRED_REASON = "source_sync_required";

export function sourceSyncRequiredError(
  message: string,
): OpenTofuControllerError {
  return new OpenTofuControllerError("failed_precondition", message, {
    reason: SOURCE_SYNC_REQUIRED_REASON,
  });
}

/**
 * A runner adapter can use this error to tell the control plane that a dispatch
 * failed because the execution substrate was temporarily unavailable. Core
 * deliberately does not inspect provider/runtime error messages: translating a
 * substrate-specific failure into this open error contract belongs to the
 * adapter that owns that substrate.
 */
export class OpenTofuRunnerInfrastructureError extends Error {
  readonly retryable = true;
  readonly reason?: string;
  readonly originalError?: unknown;

  constructor(
    message: string,
    options: {
      readonly reason?: string;
      readonly originalError?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "OpenTofuRunnerInfrastructureError";
    this.reason = options.reason;
    this.originalError = options.originalError;
  }
}

export const RUNNER_INFRASTRUCTURE_REQUEUED_REASON =
  "runner_infrastructure_requeued";

/**
 * Reads the open machine-reason contract shared by controller and runner
 * errors. Human-readable messages are intentionally never inspected here.
 */
export function structuredErrorReason(error: unknown): string | undefined {
  const details =
    error instanceof OpenTofuControllerError
      ? error.details
      : isErrorRecord(error)
        ? error.details
        : undefined;
  const detailReason = isErrorRecord(details) ? details.reason : undefined;
  if (isStructuredErrorReason(detailReason)) return detailReason;

  if (
    error instanceof OpenTofuRunnerExecutionError ||
    error instanceof OpenTofuRunnerInfrastructureError
  ) {
    return isStructuredErrorReason(error.reason) ? error.reason : undefined;
  }
  return undefined;
}

/** Stable Run error code with an explicit phase-specific fallback. */
export function runErrorCode(error: unknown, fallback: string): string {
  return structuredErrorReason(error) ?? fallback;
}

function isStructuredErrorReason(value: unknown): value is string {
  return typeof value === "string" && STRUCTURED_ERROR_REASON_RE.test(value);
}

function isErrorRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True only for the controller's structured requeue signal. */
export function isRunnerInfrastructureRequeueError(
  error: unknown,
): error is OpenTofuControllerError {
  if (!(error instanceof OpenTofuControllerError)) return false;
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details) &&
    (details as { readonly reason?: unknown }).reason ===
      RUNNER_INFRASTRUCTURE_REQUEUED_REASON
  );
}

export function requireNonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field} must be a non-empty string`,
    );
  }
}

// Translate a Vault error into the controller error vocabulary. Missing env
// groups (no values) are appended to the message so callers can fix their
// registration without the Vault ever exposing secret material.
export function mapVaultError(error: unknown): unknown {
  if (!(error instanceof ConnectionVaultError)) return error;
  const groups = error.missingEnvGroups;
  const suffix =
    groups && groups.length > 0
      ? `: provide one of [${groups.map((group) => group.join("+")).join(", ")}]`
      : "";
  const details = {
    ...(error.reason ? { reason: error.reason } : {}),
    ...(groups && groups.length > 0 ? { missingEnvGroups: groups } : {}),
  };
  return new OpenTofuControllerError(
    error.code,
    `${error.message}${suffix}`,
    Object.keys(details).length > 0 ? details : undefined,
  );
}
