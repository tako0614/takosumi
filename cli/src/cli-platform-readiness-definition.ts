import {
  createPlatformReadinessContributionRegistry,
  isPlatformReadinessContribution,
  platformReadinessContributionErrors,
  type PlatformReadinessContribution,
  type PlatformReadinessConsistencyRule,
  type PlatformReadinessEvidenceSchema,
} from "takosumi-contract";
import {
  platformReadinessDomainIds,
  platformReadinessConsistencyRules,
  platformReadinessRehearsalStepIds,
  platformReadinessRequiredEvidenceTypes,
  platformReadinessStructuredEvidenceRules,
  platformReadinessStructuredEvidenceRequirements,
} from "./cli-platform-readiness-constants.ts";

export interface PlatformReadinessDefinition {
  readonly contributions: readonly PlatformReadinessContribution[];
  readonly domainIds: readonly string[];
  readonly rehearsalStepIds: readonly string[];
  readonly requiredEvidenceTypes: {
    readonly domains: Readonly<Record<string, readonly string[]>>;
    readonly rehearsal: Readonly<Record<string, readonly string[]>>;
  };
  readonly evidenceSchemas: Readonly<
    Record<string, PlatformReadinessEvidenceSchema>
  >;
  readonly consistencyRules: {
    readonly domains: Readonly<
      Record<string, readonly PlatformReadinessConsistencyRule[]>
    >;
    readonly rehearsal: Readonly<
      Record<string, readonly PlatformReadinessConsistencyRule[]>
    >;
  };
  readonly forbiddenSummaryPatterns: readonly string[];
  readonly collectionClassHints: Readonly<Record<string, readonly string[]>>;
}

export const OSS_PLATFORM_READINESS_DEFINITION =
  composePlatformReadinessDefinition([]);

export function composePlatformReadinessDefinition(
  contributions: readonly PlatformReadinessContribution[],
): PlatformReadinessDefinition {
  const registry = createPlatformReadinessContributionRegistry(contributions);
  const domainIds = [...platformReadinessDomainIds] as string[];
  const rehearsalStepIds = [...platformReadinessRehearsalStepIds] as string[];
  const domains = cloneRequirements(
    platformReadinessRequiredEvidenceTypes.domains,
  );
  const rehearsal = cloneRequirements(
    platformReadinessRequiredEvidenceTypes.rehearsal,
  );
  const evidenceSchemas: Record<string, PlatformReadinessEvidenceSchema> =
    Object.fromEntries(
      Object.entries(platformReadinessStructuredEvidenceRequirements).map(
        ([type, schema]) => [
          type,
          cloneSchema(
            platformReadinessStructuredEvidenceRules[type]
              ? mergeSchema(
                  schema,
                  platformReadinessStructuredEvidenceRules[type]!,
                  type,
                )
              : schema,
          ),
        ],
      ),
    );
  const forbiddenSummaryPatterns: string[] = [];
  const collectionClassHints: Record<string, string[]> = {};
  const collectionClassByEvidenceType = new Map<string, string>();
  const domainConsistency = cloneConsistencyRules(
    platformReadinessConsistencyRules.domains,
  );
  const rehearsalConsistency: Record<
    string,
    PlatformReadinessConsistencyRule[]
  > = cloneConsistencyRules(platformReadinessConsistencyRules.rehearsal);

  for (const contribution of registry.contributions) {
    mergeGroups(
      domainIds,
      domains,
      domainConsistency,
      contribution.domains ?? [],
    );
    mergeGroups(
      rehearsalStepIds,
      rehearsal,
      rehearsalConsistency,
      contribution.rehearsalSteps ?? [],
    );
    for (const [type, schema] of Object.entries(
      contribution.evidenceSchemas ?? {},
    )) {
      evidenceSchemas[type] = mergeSchema(evidenceSchemas[type], schema, type);
    }
    for (const pattern of contribution.forbiddenSummaryPatterns ?? []) {
      if (!forbiddenSummaryPatterns.includes(pattern)) {
        forbiddenSummaryPatterns.push(pattern);
      }
    }
    for (const [classId, types] of Object.entries(
      contribution.collectionClassHints ?? {},
    )) {
      const mergedTypes = collectionClassHints[classId] ?? [];
      for (const type of types ?? []) {
        const existingClass = collectionClassByEvidenceType.get(type);
        if (existingClass && existingClass !== classId) {
          throw new TypeError(
            `platform readiness evidence ${type} has conflicting collection classes: ${existingClass}, ${classId}`,
          );
        }
        collectionClassByEvidenceType.set(type, classId);
        if (!mergedTypes.includes(type)) mergedTypes.push(type);
      }
      collectionClassHints[classId] = mergedTypes;
    }
  }

  for (const [scope, requirements] of Object.entries({ domains, rehearsal })) {
    for (const [id, types] of Object.entries(requirements)) {
      for (const type of types) {
        if (!evidenceSchemas[type]) {
          throw new TypeError(
            `platform readiness ${scope}.${id} requires evidence schema ${type}`,
          );
        }
      }
    }
  }

  return {
    contributions: registry.contributions,
    domainIds,
    rehearsalStepIds,
    requiredEvidenceTypes: { domains, rehearsal },
    evidenceSchemas,
    consistencyRules: {
      domains: domainConsistency,
      rehearsal: rehearsalConsistency,
    },
    forbiddenSummaryPatterns,
    collectionClassHints,
  };
}

export function readinessContributionsFromDocument(document: unknown): {
  readonly contributions: readonly PlatformReadinessContribution[];
  readonly errors: readonly string[];
} {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { contributions: [], errors: [] };
  }
  const raw = (document as Record<string, unknown>).contributions;
  if (!Array.isArray(raw)) {
    return {
      contributions: [],
      errors: ["contributions must be an array"],
    };
  }
  const errors: string[] = [];
  const contributions: PlatformReadinessContribution[] = [];
  raw.forEach((entry, index) => {
    if (!isPlatformReadinessContribution(entry)) {
      errors.push(
        ...platformReadinessContributionErrors(
          entry,
          `contributions[${index}]`,
        ),
      );
      return;
    }
    contributions.push(entry);
  });
  return { contributions, errors };
}

export function platformReadinessDefinitionFromDocument(document: unknown): {
  readonly definition: PlatformReadinessDefinition;
  readonly errors: readonly string[];
} {
  const result = readinessContributionsFromDocument(document);
  if (result.errors.length > 0) {
    return {
      definition: OSS_PLATFORM_READINESS_DEFINITION,
      errors: result.errors,
    };
  }
  try {
    return {
      definition: composePlatformReadinessDefinition(result.contributions),
      errors: [],
    };
  } catch (error) {
    return {
      definition: OSS_PLATFORM_READINESS_DEFINITION,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function cloneRequirements(
  source: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(source).map(([id, types]) => [id, [...types]]),
  );
}

function cloneConsistencyRules(
  source: Readonly<
    Record<string, readonly PlatformReadinessConsistencyRule[]>
  >,
): Record<string, PlatformReadinessConsistencyRule[]> {
  return Object.fromEntries(
    Object.entries(source).map(([id, rules]) => [
      id,
      rules.map((rule) => ({
        field: rule.field,
        evidenceTypes: [...rule.evidenceTypes],
      })),
    ]),
  );
}

function mergeGroups(
  ids: string[],
  target: Record<string, string[]>,
  consistencyTarget: Record<string, PlatformReadinessConsistencyRule[]>,
  groups: readonly {
    readonly id: string;
    readonly requiredEvidenceTypes: readonly string[];
    readonly consistentFields?: readonly PlatformReadinessConsistencyRule[];
  }[],
): void {
  for (const group of groups) {
    if (!ids.includes(group.id)) ids.push(group.id);
    const types = target[group.id] ?? [];
    for (const type of group.requiredEvidenceTypes) {
      if (!types.includes(type)) types.push(type);
    }
    target[group.id] = types;
    const rules = consistencyTarget[group.id] ?? [];
    for (const rule of group.consistentFields ?? []) {
      const unknownTypes = rule.evidenceTypes.filter(
        (type) => !types.includes(type),
      );
      if (unknownTypes.length > 0) {
        throw new TypeError(
          `platform readiness consistency rule ${group.id}.${rule.field} references evidence not required by the group: ${unknownTypes.join(", ")}`,
        );
      }
      const key = `${rule.field}:${rule.evidenceTypes.join(",")}`;
      if (
        !rules.some(
          (existing) =>
            `${existing.field}:${existing.evidenceTypes.join(",")}` === key,
        )
      ) {
        rules.push({
          field: rule.field,
          evidenceTypes: [...rule.evidenceTypes],
        });
      }
    }
    if (rules.length > 0) consistencyTarget[group.id] = rules;
  }
}

function cloneSchema(
  schema: PlatformReadinessEvidenceSchema,
): PlatformReadinessEvidenceSchema {
  return {
    ...(schema.fields ? { fields: [...schema.fields] } : {}),
    ...(schema.anyOf ? { anyOf: schema.anyOf.map((group) => [...group]) } : {}),
    ...(schema.values ? { values: { ...schema.values } } : {}),
    ...(schema.allowedValues
      ? {
          allowedValues: Object.fromEntries(
            Object.entries(schema.allowedValues).map(([field, values]) => [
              field,
              [...values],
            ]),
          ),
        }
      : {}),
    ...(schema.patterns ? { patterns: { ...schema.patterns } } : {}),
    ...(schema.formats ? { formats: { ...schema.formats } } : {}),
    ...(schema.numericBounds
      ? {
          numericBounds: Object.fromEntries(
            Object.entries(schema.numericBounds).map(([field, bound]) => [
              field,
              { ...bound },
            ]),
          ),
        }
      : {}),
    ...(schema.requiredItems
      ? {
          requiredItems: Object.fromEntries(
            Object.entries(schema.requiredItems).map(([field, items]) => [
              field,
              [...items],
            ]),
          ),
        }
      : {}),
    ...(schema.distinctFields
      ? { distinctFields: schema.distinctFields.map((group) => [...group]) }
      : {}),
    ...(schema.after ? { after: { ...schema.after } } : {}),
  };
}

function mergeSchema(
  baseline: PlatformReadinessEvidenceSchema | undefined,
  contribution: PlatformReadinessEvidenceSchema,
  type: string,
): PlatformReadinessEvidenceSchema {
  if (!baseline) return cloneSchema(contribution);
  const values = mergeExactRecord(
    baseline.values,
    contribution.values,
    `${type}.values`,
  );
  const patterns = mergeExactRecord(
    baseline.patterns,
    contribution.patterns,
    `${type}.patterns`,
  );
  const formats = mergeExactRecord(
    baseline.formats,
    contribution.formats,
    `${type}.formats`,
  );
  const numericBounds = mergeExactRecord(
    baseline.numericBounds,
    contribution.numericBounds,
    `${type}.numericBounds`,
  );
  const requiredItems: Record<string, readonly string[]> = {
    ...(baseline.requiredItems ?? {}),
  };
  for (const [field, contributed] of Object.entries(
    contribution.requiredItems ?? {},
  )) {
    requiredItems[field] = unique([
      ...(requiredItems[field] ?? []),
      ...contributed,
    ]);
  }
  const distinctFields = uniqueGroups([
    ...(baseline.distinctFields ?? []),
    ...(contribution.distinctFields ?? []),
  ]);
  const after = mergeExactRecord(
    baseline.after,
    contribution.after,
    `${type}.after`,
  );
  const allowedValues: Record<string, readonly string[]> = {
    ...(baseline.allowedValues ?? {}),
  };
  for (const [field, contributed] of Object.entries(
    contribution.allowedValues ?? {},
  )) {
    const existing = allowedValues[field];
    if (!existing) {
      allowedValues[field] = [...contributed];
      continue;
    }
    const intersection = existing.filter((value) =>
      contributed.includes(value),
    );
    if (intersection.length === 0) {
      throw new TypeError(
        `platform readiness schema conflict: ${type}.allowedValues.${field}`,
      );
    }
    allowedValues[field] = intersection;
  }
  return {
    fields: unique([
      ...(baseline.fields ?? []),
      ...(contribution.fields ?? []),
    ]),
    anyOf: uniqueGroups([
      ...(baseline.anyOf ?? []),
      ...(contribution.anyOf ?? []),
    ]),
    ...(Object.keys(values).length > 0 ? { values } : {}),
    ...(Object.keys(allowedValues).length > 0 ? { allowedValues } : {}),
    ...(Object.keys(patterns).length > 0 ? { patterns } : {}),
    ...(Object.keys(formats).length > 0 ? { formats } : {}),
    ...(Object.keys(numericBounds).length > 0 ? { numericBounds } : {}),
    ...(Object.keys(requiredItems).length > 0 ? { requiredItems } : {}),
    ...(distinctFields.length > 0 ? { distinctFields } : {}),
    ...(Object.keys(after).length > 0 ? { after } : {}),
  };
}

function mergeExactRecord<T>(
  baseline: Readonly<Record<string, T>> | undefined,
  contribution: Readonly<Record<string, T>> | undefined,
  label: string,
): Record<string, T> {
  const merged = { ...(baseline ?? {}) };
  for (const [field, value] of Object.entries(contribution ?? {}) as Array<
    [string, T]
  >) {
    if (
      merged[field] !== undefined &&
      JSON.stringify(merged[field]) !== JSON.stringify(value)
    ) {
      throw new TypeError(
        `platform readiness schema conflict: ${label}.${field}`,
      );
    }
    merged[field] = value;
  }
  return merged;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueGroups(values: readonly (readonly string[])[]): string[][] {
  const seen = new Set<string>();
  return values.flatMap((group) => {
    const key = JSON.stringify(group);
    if (seen.has(key)) return [];
    seen.add(key);
    return [[...group]];
  });
}
