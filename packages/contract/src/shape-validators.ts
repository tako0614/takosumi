/**
 * Shared shape-validation primitives for portable kind packages.
 *
 * Every `@takos/takosumi-kind-*` package validates its component `spec` and
 * `outputs` with the same small set of predicates and issue-pushers. These
 * helpers used to be copy-pasted into a per-package `src/_validators.ts`
 * (nine near-identical copies that had already drifted, including the
 * security-relevant credential checks). They now live here, in the
 * `@takos/takosumi-contract` package that every kind package already depends
 * on for {@link ShapeValidationIssue}, so a single change reaches all kinds
 * and the copies cannot diverge.
 *
 * Only helpers with at least one consumer are exported. Kind-specific
 * validation that is not shared (for example gateway route grammar or the
 * postgres size-class enum) stays in the owning package.
 */
import type { ShapeValidationIssue } from "./shape.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isPort(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65535;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

export function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (!isNonEmptyString(value)) {
    issues.push({ path, message: "must be a non-empty string" });
  }
}

export function optionalNonEmptyString(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isNonEmptyString(value)) {
    issues.push({ path, message: "must be a non-empty string" });
  }
}

export function requirePositiveInteger(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (!isPositiveInteger(value)) {
    issues.push({ path, message: "must be a positive integer" });
  }
}

export function requirePort(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (!isPort(value)) {
    issues.push({ path, message: "must be an integer from 1 to 65535" });
  }
}

export function requireHttpUrl(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (!isNonEmptyString(value)) {
    issues.push({ path, message: "must be an absolute http(s) URL" });
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      issues.push({ path, message: "must be an absolute http(s) URL" });
    }
    if (url.username || url.password) {
      issues.push({ path, message: "must not contain embedded credentials" });
    }
  } catch {
    issues.push({ path, message: "must be an absolute http(s) URL" });
  }
}

export function optionalNonNegativeInteger(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isNonNegativeInteger(value)) {
    issues.push({ path, message: "must be a non-negative integer" });
  }
}

export function optionalBoolean(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    issues.push({ path, message: "must be a boolean" });
  }
}

export function optionalStringRecord(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isStringRecord(value)) {
    issues.push({ path, message: "must be a string-to-string record" });
  }
}

/**
 * Optional absolute URI that must not carry an embedded password. Empty,
 * non-string, or unparsable values are reported as `must be an absolute URI`;
 * an `undefined` value is accepted (the field is optional).
 *
 * Required URI fields should validate non-emptiness with
 * {@link requireNonEmptyString} first; this helper then only adds the
 * password check for already-present strings.
 */
export function optionalPasswordlessAbsoluteUri(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path, message: "must be an absolute URI" });
    return;
  }
  try {
    const url = new URL(value);
    if (url.password) {
      issues.push({ path, message: "must not contain an embedded password" });
    }
  } catch {
    issues.push({ path, message: "must be an absolute URI" });
  }
}

export function requireRoot(
  value: unknown,
  issues: ShapeValidationIssue[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    issues.push({ path: "$", message: "must be an object" });
    return false;
  }
  return true;
}

export function rejectUnknownFields(
  value: Record<string, unknown>,
  path: string,
  allowedFields: readonly string[],
  issues: ShapeValidationIssue[],
): void {
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push({
        path: path === "$" ? `$.${key}` : `${path}.${key}`,
        message: "unknown field",
      });
    }
  }
}

export function requireEnum<T extends string>(
  value: unknown,
  path: string,
  allowedValues: readonly T[],
  issues: ShapeValidationIssue[],
): void {
  if (
    typeof value !== "string" ||
    !(allowedValues as readonly string[]).includes(value)
  ) {
    issues.push({
      path,
      message: `must be one of: ${allowedValues.join(", ")}`,
    });
  }
}

export function optionalEnum<T extends string>(
  value: unknown,
  path: string,
  allowedValues: readonly T[],
  issues: ShapeValidationIssue[],
): void {
  if (value === undefined) return;
  requireEnum(value, path, allowedValues, issues);
}
