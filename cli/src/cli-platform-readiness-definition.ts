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
import { canonicalJson } from "./cli-util.ts";

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
    readonly crossScope: readonly PlatformReadinessConsistencyRule[];
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
  const crossScopeConsistency: PlatformReadinessConsistencyRule[] = [];

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
    mergeCrossScopeConsistency(
      crossScopeConsistency,
      contribution.consistentFields ?? [],
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
  validateCrossScopeConsistencyRules(
    crossScopeConsistency,
    domains,
    rehearsal,
  );

  return {
    contributions: registry.contributions,
    domainIds,
    rehearsalStepIds,
    requiredEvidenceTypes: { domains, rehearsal },
    evidenceSchemas,
    consistencyRules: {
      domains: domainConsistency,
      rehearsal: rehearsalConsistency,
      crossScope: crossScopeConsistency,
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

export function platformReadinessDefinitionFromDocument(
  document: unknown,
  trustedContributions: readonly PlatformReadinessContribution[] = [],
): {
  readonly definition: PlatformReadinessDefinition;
  readonly errors: readonly string[];
} {
  const embedded = readinessContributionsFromDocument(document);
  let definition: PlatformReadinessDefinition;
  try {
    definition = composePlatformReadinessDefinition(trustedContributions);
  } catch (error) {
    return {
      definition: OSS_PLATFORM_READINESS_DEFINITION,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const errors = [...embedded.errors];
  if (embedded.errors.length === 0) {
    try {
      createPlatformReadinessContributionRegistry(embedded.contributions);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (embedded.contributions.length > 0 && trustedContributions.length === 0) {
    errors.push(
      "readiness document contributions require trusted --contribution-file input",
    );
    return { definition, errors };
  }

  const embeddedById = new Map(
    embedded.contributions.map((contribution) => [contribution.id, contribution]),
  );
  const trustedById = new Map(
    trustedContributions.map((contribution) => [contribution.id, contribution]),
  );
  for (const contribution of embedded.contributions) {
    const trusted = trustedById.get(contribution.id);
    if (!trusted) {
      errors.push(
        `readiness document contribution ${contribution.id}@${contribution.version} has no trusted contribution input`,
      );
      continue;
    }
    if (canonicalJson(contribution) !== canonicalJson(trusted)) {
      errors.push(
        `readiness document contribution ${contribution.id}@${contribution.version} does not exactly match trusted contribution content`,
      );
    }
  }
  for (const contribution of trustedContributions) {
    if (!embeddedById.has(contribution.id)) {
      errors.push(
        `readiness document is missing trusted contribution ${contribution.id}@${contribution.version}`,
      );
    }
  }
  return { definition, errors };
}

function mergeCrossScopeConsistency(
  target: PlatformReadinessConsistencyRule[],
  rules: readonly PlatformReadinessConsistencyRule[],
): void {
  for (const rule of rules) {
    const key = `${rule.field}:${[...rule.evidenceTypes].sort().join(",")}`;
    if (
      !target.some(
        (existing) =>
          `${existing.field}:${[...existing.evidenceTypes].sort().join(",")}` ===
          key,
      )
    ) {
      target.push({
        field: rule.field,
        evidenceTypes: [...rule.evidenceTypes],
      });
    }
  }
}

function validateCrossScopeConsistencyRules(
  rules: readonly PlatformReadinessConsistencyRule[],
  domains: Readonly<Record<string, readonly string[]>>,
  rehearsal: Readonly<Record<string, readonly string[]>>,
): void {
  const occurrenceCounts = new Map<string, number>();
  for (const requirements of [domains, rehearsal]) {
    for (const types of Object.values(requirements)) {
      for (const type of types) {
        occurrenceCounts.set(type, (occurrenceCounts.get(type) ?? 0) + 1);
      }
    }
  }
  for (const rule of rules) {
    if (rule.evidenceTypes.length < 2) {
      throw new TypeError(
        `platform readiness cross-scope consistency rule ${rule.field} must reference at least two evidence types`,
      );
    }
    for (const type of rule.evidenceTypes) {
      const count = occurrenceCounts.get(type) ?? 0;
      if (count !== 1) {
        throw new TypeError(
          `platform readiness cross-scope consistency rule ${rule.field} requires exactly one ${type} reference, found ${count}`,
        );
      }
    }
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
  source: Readonly<Record<string, readonly PlatformReadinessConsistencyRule[]>>,
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
    ...(schema.exactItems
      ? {
          exactItems: Object.fromEntries(
            Object.entries(schema.exactItems).map(([field, items]) => [
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
    ...(schema.notExpired ? { notExpired: [...schema.notExpired] } : {}),
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
  const exactItems = mergeExactRecord(
    baseline.exactItems,
    contribution.exactItems,
    `${type}.exactItems`,
  );
  const distinctFields = uniqueGroups([
    ...(baseline.distinctFields ?? []),
    ...(contribution.distinctFields ?? []),
  ]);
  const after = mergeExactRecord(
    baseline.after,
    contribution.after,
    `${type}.after`,
  );
  const notExpired = unique([
    ...(baseline.notExpired ?? []),
    ...(contribution.notExpired ?? []),
  ]);
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
    ...(Object.keys(exactItems).length > 0 ? { exactItems } : {}),
    ...(distinctFields.length > 0 ? { distinctFields } : {}),
    ...(Object.keys(after).length > 0 ? { after } : {}),
    ...(notExpired.length > 0 ? { notExpired } : {}),
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
