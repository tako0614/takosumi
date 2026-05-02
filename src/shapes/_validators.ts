import type { ShapeValidationIssue } from "takosumi-contract";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
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

export function optionalPositiveInteger(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isPositiveInteger(value)) {
    issues.push({ path, message: "must be a positive integer" });
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

export function optionalRecord(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
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
