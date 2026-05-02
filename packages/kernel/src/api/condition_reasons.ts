import { isCoreConditionReason } from "takosumi-contract";

export interface ConditionReasonValidationError {
  readonly path: string;
  readonly reason: string;
}

export function findNonCatalogConditionReasons(
  value: unknown,
): readonly ConditionReasonValidationError[] {
  const errors: ConditionReasonValidationError[] = [];
  visit(value, "$", errors);
  return errors;
}

export function hasOnlyCatalogConditionReasons(value: unknown): boolean {
  return findNonCatalogConditionReasons(value).length === 0;
}

function visit(
  value: unknown,
  path: string,
  errors: ConditionReasonValidationError[],
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`, errors));
    return;
  }

  const record = value as Record<string, unknown>;
  const conditions = record.conditions;
  if (Array.isArray(conditions)) {
    conditions.forEach((condition, index) => {
      if (!condition || typeof condition !== "object") return;
      const reason = (condition as Record<string, unknown>).reason;
      if (reason === undefined) return;
      if (isCoreConditionReason(reason)) return;
      errors.push({
        path: `${path}.conditions[${index}].reason`,
        reason: String(reason),
      });
    });
  }

  for (const [key, nested] of Object.entries(record)) {
    if (key === "conditions") continue;
    visit(nested, `${path}.${key}`, errors);
  }
}
