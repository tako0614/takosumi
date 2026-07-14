import type { JsonPrimitive } from "./types.ts";

export const TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTION_KIND =
  "takosumi.platform-hardening-contribution@v1" as const;
export const TAKOSUMI_PLATFORM_HARDENING_GATE_EVIDENCE_KIND =
  "takosumi.platform-hardening-gate-evidence@v1" as const;

/**
 * A host- or operator-owned set of production-hardening checks. Check
 * definitions are data so the OSS validator and platform gate can compose
 * arbitrary runner/provider/substrate checks without importing their
 * implementations.
 */
export interface PlatformHardeningContribution {
  readonly kind: typeof TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTION_KIND;
  readonly id: string;
  readonly capability: string;
  readonly checks: readonly PlatformHardeningCheckDefinition[];
}

export interface PlatformHardeningCheckDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly evidenceSchema: PlatformHardeningEvidenceSchema;
}

/**
 * Small, portable schema vocabulary for a private hardening-evidence
 * document. Extra fields remain allowed so an operator can retain richer
 * evidence without changing the OSS contract.
 */
export interface PlatformHardeningEvidenceSchema {
  readonly required?: readonly string[];
  readonly properties?: Readonly<
    Record<string, PlatformHardeningEvidenceFieldSchema>
  >;
}

export interface PlatformHardeningEvidenceFieldSchema {
  readonly type: "string" | "number" | "boolean" | "string-array";
  readonly example?: JsonPrimitive | readonly string[];
  readonly const?: JsonPrimitive;
  readonly enum?: readonly JsonPrimitive[];
  readonly pattern?: string;
  readonly minimum?: number;
  readonly contains?: readonly string[];
}

/**
 * Redacted runtime gate material generated from a validated private evidence
 * manifest. It contains only immutable references and digests; check-specific
 * evidence documents remain in the operator evidence store.
 */
export interface PlatformHardeningGateEvidence {
  readonly kind: typeof TAKOSUMI_PLATFORM_HARDENING_GATE_EVIDENCE_KIND;
  readonly contributions: readonly PlatformHardeningGateEvidenceContribution[];
}

export interface PlatformHardeningGateEvidenceContribution {
  readonly id: string;
  readonly capability: string;
  readonly checks: readonly PlatformHardeningGateEvidenceCheck[];
}

export interface PlatformHardeningGateEvidenceCheck {
  readonly id: string;
  readonly evidenceRef: string;
  readonly evidenceDigest: string;
}

export function isPlatformHardeningContribution(
  value: unknown,
): value is PlatformHardeningContribution {
  if (!isRecord(value)) return false;
  if (
    value.kind !== TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTION_KIND ||
    !token(value.id) ||
    !token(value.capability) ||
    !Array.isArray(value.checks) ||
    value.checks.length === 0
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const check of value.checks) {
    if (!isRecord(check) || !token(check.id) || ids.has(check.id)) return false;
    ids.add(check.id);
    if (
      !nonEmptyString(check.title) ||
      !nonEmptyString(check.description) ||
      !isPlatformHardeningEvidenceSchema(check.evidenceSchema)
    ) {
      return false;
    }
  }
  return true;
}

export function isPlatformHardeningEvidenceSchema(
  value: unknown,
): value is PlatformHardeningEvidenceSchema {
  if (!isRecord(value)) return false;
  const required = value.required;
  if (
    required !== undefined &&
    (!stringArray(required, true) || new Set(required).size !== required.length)
  ) {
    return false;
  }
  if (value.properties === undefined) return true;
  if (!isRecord(value.properties)) return false;
  for (const [name, field] of Object.entries(value.properties)) {
    if (!name.trim() || !isPlatformHardeningFieldSchema(field)) return false;
  }
  return true;
}

/** Validate one private evidence document against a contributed data schema. */
export function platformHardeningEvidenceDocumentErrors(
  document: unknown,
  schema: PlatformHardeningEvidenceSchema,
  label = "evidence document",
): readonly string[] {
  if (!isRecord(document)) return [`${label} must be an object`];
  const errors: string[] = [];
  for (const field of schema.required ?? []) {
    if (!present(document[field])) errors.push(`${label}.${field} is required`);
  }
  for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
    const value = document[field];
    if (value === undefined || value === null) continue;
    if (!matchesType(value, fieldSchema.type)) {
      errors.push(`${label}.${field} must be ${fieldSchema.type}`);
      continue;
    }
    if (fieldSchema.const !== undefined && value !== fieldSchema.const) {
      errors.push(`${label}.${field} must be ${String(fieldSchema.const)}`);
    }
    if (
      fieldSchema.enum &&
      !fieldSchema.enum.some((candidate) => candidate === value)
    ) {
      errors.push(`${label}.${field} is not an allowed value`);
    }
    if (
      fieldSchema.pattern &&
      typeof value === "string" &&
      !new RegExp(fieldSchema.pattern, "u").test(value)
    ) {
      errors.push(`${label}.${field} does not match its required pattern`);
    }
    if (
      fieldSchema.minimum !== undefined &&
      typeof value === "number" &&
      value < fieldSchema.minimum
    ) {
      errors.push(`${label}.${field} must be at least ${fieldSchema.minimum}`);
    }
    if (fieldSchema.contains && Array.isArray(value)) {
      for (const requiredValue of fieldSchema.contains) {
        if (!value.includes(requiredValue)) {
          errors.push(`${label}.${field} is missing ${requiredValue}`);
        }
      }
    }
  }
  return errors;
}

function isPlatformHardeningFieldSchema(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    value.type !== "string" &&
    value.type !== "number" &&
    value.type !== "boolean" &&
    value.type !== "string-array"
  ) {
    return false;
  }
  if (
    value.const !== undefined &&
    (!jsonPrimitive(value.const) ||
      !matchesType(
        value.const,
        value.type as PlatformHardeningEvidenceFieldSchema["type"],
      ))
  ) {
    return false;
  }
  if (
    value.example !== undefined &&
    !matchesType(
      value.example,
      value.type as PlatformHardeningEvidenceFieldSchema["type"],
    )
  ) {
    return false;
  }
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) ||
      value.enum.length === 0 ||
      !value.enum.every(
        (entry) =>
          jsonPrimitive(entry) &&
          matchesType(
            entry,
            value.type as PlatformHardeningEvidenceFieldSchema["type"],
          ),
      ))
  ) {
    return false;
  }
  if (value.pattern !== undefined) {
    if (value.type !== "string" || !validRegex(value.pattern)) return false;
  }
  if (value.minimum !== undefined) {
    if (
      value.type !== "number" ||
      typeof value.minimum !== "number" ||
      !Number.isFinite(value.minimum)
    ) {
      return false;
    }
  }
  if (value.contains !== undefined) {
    if (value.type !== "string-array" || !stringArray(value.contains, false)) {
      return false;
    }
  }
  return true;
}

function matchesType(
  value: unknown,
  type: PlatformHardeningEvidenceFieldSchema["type"],
): boolean {
  switch (type) {
    case "string":
      return nonEmptyString(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string-array":
      return stringArray(value, false);
  }
}

function validRegex(value: unknown): boolean {
  if (!nonEmptyString(value)) return false;
  try {
    new RegExp(value, "u");
    return true;
  } catch {
    return false;
  }
}

function token(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9._-]*(?:\.[a-z0-9][a-z0-9._-]*)*$/u.test(value)
  );
}

function stringArray(value: unknown, allowEmpty: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(nonEmptyString)
  );
}

function jsonPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
