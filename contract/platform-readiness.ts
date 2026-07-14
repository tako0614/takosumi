export const TAKOSUMI_PLATFORM_READINESS_CONTRIBUTION_KIND =
  "takosumi.platform-readiness-contribution@v1" as const;

export const platformReadinessCollectionClassIds = [
  "browser-user-e2e",
  "external-provider",
  "operator-review",
  "live-probe-sync",
  "operation-drill",
  "release-provenance",
] as const;

export type PlatformReadinessCollectionClassId =
  (typeof platformReadinessCollectionClassIds)[number];

/**
 * Provider-neutral readiness requirements contributed by an optional platform
 * extension. The OSS readiness baseline intentionally contains no commercial
 * provider, pricebook, payment, or hosted-service policy.
 */
export interface PlatformReadinessContribution {
  readonly kind: typeof TAKOSUMI_PLATFORM_READINESS_CONTRIBUTION_KIND;
  readonly id: string;
  /** Immutable contribution definition version. */
  readonly version: string;
  readonly capability: string;
  readonly domains?: readonly PlatformReadinessRequirementGroup[];
  readonly rehearsalSteps?: readonly PlatformReadinessRequirementGroup[];
  readonly evidenceSchemas?: Readonly<
    Record<string, PlatformReadinessEvidenceSchema>
  >;
  /** Data-only hints for routing extension evidence to existing collectors. */
  readonly collectionClassHints?: Readonly<
    Partial<Record<PlatformReadinessCollectionClassId, readonly string[]>>
  >;
  /**
   * Additional redaction patterns applied to private evidence summaries and
   * public summary artifacts. Patterns are data, so the generic OSS validator
   * can enforce extension-owned identifiers without importing extension code.
   */
  readonly forbiddenSummaryPatterns?: readonly string[];
}

export interface PlatformReadinessContributionIdentity {
  readonly id: string;
  readonly version: string;
  readonly capability: string;
}

export interface PlatformReadinessContributionRegistry {
  readonly contributions: readonly PlatformReadinessContribution[];
  get(id: string, version?: string): PlatformReadinessContribution | undefined;
  hasCapability(capability: string): boolean;
}

export interface PlatformReadinessRequirementGroup {
  readonly id: string;
  readonly requiredEvidenceTypes: readonly string[];
  readonly consistentFields?: readonly PlatformReadinessConsistencyRule[];
}

export interface PlatformReadinessConsistencyRule {
  readonly field: string;
  readonly evidenceTypes: readonly string[];
}

export interface PlatformReadinessEvidenceSchema {
  readonly fields?: readonly string[];
  readonly anyOf?: readonly (readonly string[])[];
  readonly values?: Readonly<Record<string, string>>;
  readonly allowedValues?: Readonly<Record<string, readonly string[]>>;
  readonly patterns?: Readonly<Record<string, string>>;
  /** Explicit field semantics; field names themselves never imply a format. */
  readonly formats?: Readonly<
    Record<string, PlatformReadinessEvidenceFieldFormat>
  >;
  /** Explicit finite-number lower bounds. */
  readonly numericBounds?: Readonly<
    Record<string, PlatformReadinessNumericBound>
  >;
  /** Items which must be present in an array or delimited string field. */
  readonly requiredItems?: Readonly<Record<string, readonly string[]>>;
  /** Fields whose present values must be pairwise distinct. */
  readonly distinctFields?: readonly (readonly string[])[];
  /** Maps a later timestamp field to the earlier timestamp field. */
  readonly after?: Readonly<Record<string, string>>;
}

export const platformReadinessEvidenceFieldFormats = [
  "evidence-ref",
  "git-commit-sha1",
  "git-object-id",
  "https-url",
  "sha256",
  "timestamp",
] as const;

export type PlatformReadinessEvidenceFieldFormat =
  (typeof platformReadinessEvidenceFieldFormats)[number];

export interface PlatformReadinessNumericBound {
  readonly minimum: number;
  readonly exclusiveMinimum?: boolean;
}

export function isPlatformReadinessContribution(
  value: unknown,
): value is PlatformReadinessContribution {
  return platformReadinessContributionErrors(value).length === 0;
}

export function platformReadinessContributionErrors(
  value: unknown,
  label = "contribution",
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${label} must be an object`];
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  if (record.kind !== TAKOSUMI_PLATFORM_READINESS_CONTRIBUTION_KIND) {
    errors.push(
      `${label}.kind must be ${TAKOSUMI_PLATFORM_READINESS_CONTRIBUTION_KIND}`,
    );
  }
  if (!token(record.id, /^[a-z0-9][a-z0-9._-]*$/u)) {
    errors.push(`${label}.id must be a lowercase namespaced token`);
  }
  if (!token(record.version, SEMANTIC_VERSION_PATTERN)) {
    errors.push(`${label}.version must be a semantic version`);
  }
  if (!token(record.capability, /^[a-z0-9][a-z0-9._-]*\.v[1-9]\d*$/u)) {
    errors.push(`${label}.capability must be a versioned capability token`);
  }
  if (!optionalRequirementGroups(record.domains)) {
    errors.push(`${label}.domains must contain valid requirement groups`);
  }
  if (!optionalRequirementGroups(record.rehearsalSteps)) {
    errors.push(
      `${label}.rehearsalSteps must contain valid requirement groups`,
    );
  }
  if (!optionalEvidenceSchemas(record.evidenceSchemas)) {
    errors.push(`${label}.evidenceSchemas must contain valid evidence schemas`);
  }
  errors.push(
    ...collectionClassHintErrors(
      record.collectionClassHints,
      record.evidenceSchemas,
      `${label}.collectionClassHints`,
    ),
  );
  if (!optionalRegexArray(record.forbiddenSummaryPatterns)) {
    errors.push(
      `${label}.forbiddenSummaryPatterns must contain valid regular expressions`,
    );
  }
  for (const field of ["domains", "rehearsalSteps"] as const) {
    const groups = record[field];
    if (!Array.isArray(groups)) continue;
    const ids = groups.flatMap((group) =>
      group &&
      typeof group === "object" &&
      !Array.isArray(group) &&
      nonEmptyString((group as Record<string, unknown>).id)
        ? [(group as Record<string, unknown>).id as string]
        : [],
    );
    for (const duplicate of duplicated(ids)) {
      errors.push(
        `${label}.${field} duplicates requirement group ${duplicate}`,
      );
    }
  }
  return errors;
}

export function createPlatformReadinessContributionRegistry(
  contributions: readonly unknown[],
): PlatformReadinessContributionRegistry {
  const checked: PlatformReadinessContribution[] = [];
  const byId = new Map<string, PlatformReadinessContribution>();
  const byCapability = new Map<string, PlatformReadinessContribution>();
  contributions.forEach((value, index) => {
    const errors = platformReadinessContributionErrors(
      value,
      `contributions[${index}]`,
    );
    if (errors.length > 0) throw new TypeError(errors.join("; "));
    const contribution = value as PlatformReadinessContribution;
    if (byId.has(contribution.id)) {
      throw new TypeError(
        `platform readiness contribution id is duplicated: ${contribution.id}`,
      );
    }
    if (byCapability.has(contribution.capability)) {
      throw new TypeError(
        `platform readiness contribution capability is duplicated: ${contribution.capability}`,
      );
    }
    byId.set(contribution.id, contribution);
    byCapability.set(contribution.capability, contribution);
    checked.push(contribution);
  });
  const frozen = Object.freeze([...checked]);
  return Object.freeze({
    contributions: frozen,
    get: (id: string, version?: string) => {
      const contribution = byId.get(id);
      return version === undefined || contribution?.version === version
        ? contribution
        : undefined;
    },
    hasCapability: (capability: string) => byCapability.has(capability),
  });
}

/**
 * Validate evidence using only the data carried by a contribution schema.
 * Provider- or host-specific validators are intentionally unnecessary.
 */
export function platformReadinessEvidenceSchemaErrors(
  schema: PlatformReadinessEvidenceSchema,
  evidence: unknown,
  label = "evidence",
): string[] {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return [`${label} must be an object`];
  }
  const record = evidence as Record<string, unknown>;
  const errors: string[] = [];
  for (const field of schema.fields ?? []) {
    if (!validEvidenceValue(record[field])) {
      errors.push(`${label}.${field} is required and must not be a placeholder`);
    }
  }
  for (const fields of schema.anyOf ?? []) {
    if (!fields.some((field) => validEvidenceValue(record[field]))) {
      errors.push(`${label} requires one of ${fields.join(", ")}`);
    }
  }
  for (const [field, expected] of Object.entries(schema.values ?? {})) {
    if (record[field] !== expected) {
      errors.push(`${label}.${field} must equal ${expected}`);
    }
  }
  for (const [field, allowed] of Object.entries(schema.allowedValues ?? {})) {
    if (!allowed.includes(String(record[field] ?? ""))) {
      errors.push(`${label}.${field} is not an allowed value`);
    }
  }
  for (const [field, pattern] of Object.entries(schema.patterns ?? {})) {
    if (
      record[field] !== undefined &&
      (typeof record[field] !== "string" ||
        !new RegExp(pattern, "u").test(record[field]))
    ) {
      errors.push(`${label}.${field} does not match its required pattern`);
    }
  }
  for (const [field, format] of Object.entries(schema.formats ?? {})) {
    if (
      record[field] !== undefined &&
      !matchesEvidenceFieldFormat(record[field], format)
    ) {
      errors.push(`${label}.${field} is not a valid ${format}`);
    }
  }
  for (const [field, bound] of Object.entries(schema.numericBounds ?? {})) {
    const value = record[field];
    if (
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        (bound.exclusiveMinimum === true
          ? value <= bound.minimum
          : value < bound.minimum))
    ) {
      errors.push(
        `${label}.${field} must be ${bound.exclusiveMinimum === true ? "greater than" : "at least"} ${bound.minimum}`,
      );
    }
  }
  for (const [field, required] of Object.entries(schema.requiredItems ?? {})) {
    if (
      record[field] !== undefined &&
      !containsRequiredItems(record[field], required)
    ) {
      errors.push(`${label}.${field} must include ${required.join(", ")}`);
    }
  }
  for (const fields of schema.distinctFields ?? []) {
    const values = fields.map((field) => record[field]);
    if (
      values.every(present) &&
      new Set(values.map((value) => JSON.stringify(value))).size !== values.length
    ) {
      errors.push(`${label}.${fields.join(",")} must be pairwise distinct`);
    }
  }
  for (const [laterField, earlierField] of Object.entries(schema.after ?? {})) {
    const later = strictUtcDate(record[laterField]);
    const earlier = strictUtcDate(record[earlierField]);
    if (!later || !earlier || later.getTime() <= earlier.getTime()) {
      errors.push(`${label}.${laterField} must be after ${earlierField}`);
    }
  }
  return errors;
}

function optionalRequirementGroups(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const record = entry as Record<string, unknown>;
      return (
        nonEmptyString(record.id) &&
        stringArray(record.requiredEvidenceTypes) &&
        optionalConsistencyRules(record.consistentFields)
      );
    })
  );
}

function optionalConsistencyRules(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        nonEmptyString((entry as Record<string, unknown>).field) &&
        stringArray((entry as Record<string, unknown>).evidenceTypes),
    )
  );
}

function optionalEvidenceSchemas(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([type, schema]) => {
    if (
      !type.trim() ||
      !schema ||
      typeof schema !== "object" ||
      Array.isArray(schema)
    ) {
      return false;
    }
    const record = schema as Record<string, unknown>;
    if (!(
      (record.fields === undefined || stringArray(record.fields)) &&
      (record.anyOf === undefined ||
        (Array.isArray(record.anyOf) && record.anyOf.every(stringArray))) &&
      optionalStringRecord(record.values, false) &&
      optionalStringRecord(record.allowedValues, true) &&
      optionalRegexRecord(record.patterns) &&
      optionalEnumRecord(record.formats, platformReadinessEvidenceFieldFormats) &&
      optionalNumericBounds(record.numericBounds) &&
      optionalStringRecord(record.requiredItems, true) &&
      optionalDistinctFieldGroups(record.distinctFields) &&
      optionalStringRecord(record.after, false)
    )) {
      return false;
    }
    const declaredFields = new Set<string>([
      ...(Array.isArray(record.fields)
        ? record.fields.filter(nonEmptyString)
        : []),
      ...(Array.isArray(record.anyOf)
        ? record.anyOf.flatMap((group) =>
            Array.isArray(group) ? group.filter(nonEmptyString) : [],
          )
        : []),
      ...Object.keys(isPlainRecord(record.values) ? record.values : {}),
    ]);
    const referencedFields = [
      ...Object.keys(isPlainRecord(record.allowedValues) ? record.allowedValues : {}),
      ...Object.keys(isPlainRecord(record.patterns) ? record.patterns : {}),
      ...Object.keys(isPlainRecord(record.formats) ? record.formats : {}),
      ...Object.keys(isPlainRecord(record.numericBounds) ? record.numericBounds : {}),
      ...Object.keys(isPlainRecord(record.requiredItems) ? record.requiredItems : {}),
      ...(Array.isArray(record.distinctFields)
        ? record.distinctFields.flatMap((group) =>
            Array.isArray(group) ? group.filter(nonEmptyString) : [],
          )
        : []),
    ];
    return (
      referencedFields.every((field) => declaredFields.has(field)) &&
      Object.entries(
      isPlainRecord(record.after) ? record.after : {},
      ).every(
        ([laterField, earlierField]) =>
          declaredFields.has(laterField) &&
          typeof earlierField === "string" &&
          declaredFields.has(earlierField),
      )
    );
  });
}

function optionalEnumRecord(
  value: unknown,
  allowed: readonly string[],
): boolean {
  if (value === undefined) return true;
  return (
    isPlainRecord(value) &&
    Object.entries(value).every(
      ([field, entry]) => field.trim().length > 0 && allowed.includes(String(entry)),
    )
  );
}

function optionalNumericBounds(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isPlainRecord(value) &&
    Object.entries(value).every(([field, entry]) => {
      if (!field.trim() || !isPlainRecord(entry)) return false;
      return (
        typeof entry.minimum === "number" &&
        Number.isFinite(entry.minimum) &&
        (entry.exclusiveMinimum === undefined ||
          typeof entry.exclusiveMinimum === "boolean") &&
        Object.keys(entry).every((key) =>
          ["minimum", "exclusiveMinimum"].includes(key),
        )
      );
    })
  );
}

function optionalDistinctFieldGroups(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (group) => stringArray(group) && new Set(group).size === group.length,
    )
  );
}

function optionalRegexArray(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length > 0 && value.every(validRegex);
}

function collectionClassHintErrors(
  value: unknown,
  evidenceSchemas: unknown,
  label: string,
): string[] {
  if (value === undefined) return [];
  if (!isPlainRecord(value)) return [`${label} must be an object`];
  const allowedClasses = new Set<string>(platformReadinessCollectionClassIds);
  const schemaTypes = new Set(
    isPlainRecord(evidenceSchemas) ? Object.keys(evidenceSchemas) : [],
  );
  const ownerByType = new Map<string, string>();
  const errors: string[] = [];
  for (const [classId, types] of Object.entries(value)) {
    if (!allowedClasses.has(classId)) {
      errors.push(`${label}.${classId} is not a supported collection class`);
      continue;
    }
    if (!stringArray(types)) {
      errors.push(`${label}.${classId} must be a non-empty string array`);
      continue;
    }
    for (const type of types) {
      if (!schemaTypes.has(type)) {
        errors.push(
          `${label}.${classId} references evidence schema not owned by the contribution: ${type}`,
        );
      }
      const existing = ownerByType.get(type);
      if (existing && existing !== classId) {
        errors.push(
          `${label} assigns ${type} to both ${existing} and ${classId}`,
        );
      } else {
        ownerByType.set(type, classId);
      }
    }
  }
  return errors;
}

function optionalRegexRecord(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) => key.trim().length > 0 && validRegex(entry),
  );
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

function optionalStringRecord(value: unknown, arrays: boolean): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      key.trim().length > 0 &&
      (arrays ? stringArray(entry) : nonEmptyString(entry)),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every(nonEmptyString)
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function token(value: unknown, pattern: RegExp): value is string {
  return nonEmptyString(value) && pattern.test(value);
}

function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function validEvidenceValue(value: unknown): boolean {
  return (
    present(value) &&
    !(typeof value === "string" && placeholderEvidenceValue(value))
  );
}

function matchesEvidenceFieldFormat(
  value: unknown,
  format: PlatformReadinessEvidenceFieldFormat,
): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const normalized = value.trim();
  switch (format) {
    case "sha256":
      return /^sha256:[a-fA-F0-9]{64}$/u.test(normalized);
    case "git-commit-sha1":
      return /^[a-fA-F0-9]{40}$/u.test(normalized);
    case "git-object-id":
      return /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u.test(normalized);
    case "https-url":
      try {
        return (
          new URL(normalized).protocol === "https:" &&
          !placeholderEvidenceValue(normalized)
        );
      } catch {
        return false;
      }
    case "evidence-ref":
      return !placeholderEvidenceValue(normalized);
    case "timestamp": {
      const parsed = strictUtcDate(normalized);
      return !!parsed && parsed.getTime() <= Date.now() + 5 * 60_000;
    }
  }
}

function placeholderEvidenceValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("evidence://") ||
    normalized.startsWith("topology://") ||
    [
      "todo",
      "tbd",
      "dummy",
      "fake",
      "changeme",
      "placeholder",
      "example.com",
      "example.test",
      "example.invalid",
      "<",
      ">",
    ].some((token) => normalized.includes(token))
  );
}

function containsRequiredItems(
  value: unknown,
  required: readonly string[],
): boolean {
  const items = Array.isArray(value)
    ? value.flatMap((entry) =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
      )
    : typeof value === "string"
      ? value
          .split(/[,\s/]+/u)
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
  const presentItems = new Set(items);
  return required.every((entry) => presentItems.has(entry));
}

function strictUtcDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u,
  );
  if (!match) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const canonical = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${(
    match[5] ?? ""
  ).padEnd(3, "0")}Z`;
  return parsed.toISOString() === canonical ? parsed : undefined;
}

function duplicated(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) result.add(value);
    seen.add(value);
  }
  return [...result].sort();
}

const SEMANTIC_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
