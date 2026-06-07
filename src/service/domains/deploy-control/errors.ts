/**
 * Shared error primitive for the deploy-control domain.
 *
 * `OpenTofuControllerError` is thrown by the controller, validation, policy,
 * and projection concerns alike, so it lives in its own module to avoid a
 * cyclic dependency between those sibling files and `mod.ts`.
 */

import type { DeployControlErrorCode } from "takosumi-contract/deploy-control-api";
import { ConnectionVaultError } from "../../adapters/vault/mod.ts";

// Re-exported from the shared guard home so deploy-control consumers can keep
// importing `isRecord` from this module while there is a single canonical
// (non-array) definition for the whole service.
export { isRecord } from "../../shared/mod.ts";

export type OpenTofuControllerErrorCode = DeployControlErrorCode;

export class OpenTofuControllerError extends Error {
  readonly code: OpenTofuControllerErrorCode;

  constructor(code: OpenTofuControllerErrorCode, message: string) {
    super(message);
    this.name = "OpenTofuControllerError";
    this.code = code;
  }
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
  const suffix = groups && groups.length > 0
    ? `: provide one of [${groups.map((group) => group.join("+")).join(", ")}]`
    : "";
  return new OpenTofuControllerError(error.code, `${error.message}${suffix}`);
}
