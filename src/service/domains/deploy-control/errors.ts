/**
 * Shared error primitive for the deploy-control domain.
 *
 * `OpenTofuControllerError` is thrown by the controller, validation, policy,
 * and projection concerns alike, so it lives in its own module to avoid a
 * cyclic dependency between those sibling files and `mod.ts`.
 */

import type { DeployControlErrorCode } from "takosumi-contract/deploy-control-api";

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
