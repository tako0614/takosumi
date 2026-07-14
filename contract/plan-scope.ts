/**
 * Provider-neutral plan scope policy and projection contracts.
 *
 * A policy names the OpenTofu resource types it applies to with a glob and
 * declares each dimension explicitly. The selector is an RFC 6901 JSON Pointer
 * evaluated against a resource change's `after` value (or `before` when after
 * is absent). Runners project only these selected, non-sensitive scalar facts;
 * arbitrary plan values never cross the runner boundary.
 */

export type PlanScopeScalar = string | number | boolean;

export interface ScopeBoundaryDimension {
  /** RFC 6901 JSON Pointer relative to the resource value, e.g. `/region`. */
  readonly selector: string;
  /** Exact scalar values admitted for this dimension. */
  readonly allowedValues: readonly PlanScopeScalar[];
}

export interface ScopeBoundaryRule {
  /** OpenTofu resource type glob. `*` and `?` are supported. */
  readonly resourceTypePattern: string;
  readonly dimensions: Readonly<Record<string, ScopeBoundaryDimension>>;
}

export interface ScopeBoundaryPolicy {
  /**
   * `strict` fails closed when a matching rule's selected fact is unavailable.
   * `permissive` still rejects observed values outside the allowlist.
   */
  readonly mode?: "permissive" | "strict";
  readonly rules: readonly ScopeBoundaryRule[];
}

/** Sanitized, non-secret facts returned by the runner for one plan resource. */
export interface PlanResourceScope {
  readonly facts: Readonly<Record<string, PlanScopeScalar>>;
}

/** Selector-only runner input derived from policy. It contains no allowlist. */
export interface PlanScopeSelector {
  readonly resourceTypePattern: string;
  readonly dimensions: Readonly<Record<string, string>>;
}

/**
 * Derive the minimum selector set the runner needs. Allowed values remain in
 * the control plane and are deliberately not sent to the execution sandbox.
 */
export function planScopeSelectors(
  policy: ScopeBoundaryPolicy | undefined,
): readonly PlanScopeSelector[] {
  if (!policy) return [];
  const normalized = parseScopeBoundaryPolicy(policy);
  const selectors = new Map<string, PlanScopeSelector>();
  for (const rule of normalized.rules) {
    const dimensions = Object.fromEntries(
      Object.entries(rule.dimensions)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, dimension]) => [name, dimension.selector]),
    );
    const key = `${rule.resourceTypePattern}\0${JSON.stringify(dimensions)}`;
    selectors.set(key, {
      resourceTypePattern: rule.resourceTypePattern,
      dimensions,
    });
  }
  return [...selectors.values()];
}

/** Match an OpenTofu resource type against the policy's small glob language. */
export function resourceTypeMatchesPattern(
  resourceType: string,
  pattern: string,
): boolean {
  let expression = "^";
  for (const character of pattern) {
    if (character === "*") expression += ".*";
    else if (character === "?") expression += ".";
    else expression += escapeRegExp(character);
  }
  return new RegExp(`${expression}$`, "u").test(resourceType);
}

/**
 * Validate the current provider-neutral scope-policy form. This is also used
 * at the dispatch boundary so an unvalidated or corrupted stored policy fails
 * before any plan values are projected.
 */
export function parseScopeBoundaryPolicy(value: unknown): ScopeBoundaryPolicy {
  if (!isRecord(value)) {
    throw new TypeError("scopeBoundary must be an object");
  }
  if (
    value.mode !== undefined &&
    value.mode !== "strict" &&
    value.mode !== "permissive"
  ) {
    throw new TypeError("scopeBoundary.mode must be strict or permissive");
  }
  if (!Array.isArray(value.rules) || value.rules.length > 64) {
    throw new TypeError(
      "scopeBoundary.rules must be an array of at most 64 rules",
    );
  }
  return {
    ...(value.mode ? { mode: value.mode } : {}),
    rules: value.rules.map((rule, index) => normalizeRule(rule, index)),
  };
}

/** Validate the provider-neutral persisted scope policy, failing closed. */
export function normalizeScopeBoundaryPolicy(
  value: unknown,
): ScopeBoundaryPolicy | undefined {
  if (!isRecord(value)) return undefined;
  return parseScopeBoundaryPolicy(value);
}

/** Normalize one current provider-neutral plan scope projection. */
export function normalizePlanResourceScope(
  value: unknown,
): PlanResourceScope | undefined {
  if (!isRecord(value)) return undefined;
  const facts = record(value.facts);
  if (!facts) return undefined;
  const normalized = scalarRecord(facts);
  return Object.keys(normalized).length > 0 ? { facts: normalized } : undefined;
}

function normalizeRule(value: unknown, index: number): ScopeBoundaryRule {
  if (!isRecord(value)) {
    throw new TypeError(`scopeBoundary.rules[${index}] must be an object`);
  }
  const resourceTypePattern = text(value.resourceTypePattern);
  const rawDimensions = record(value.dimensions);
  if (
    !resourceTypePattern ||
    resourceTypePattern.length > 256 ||
    !/^[A-Za-z0-9_*?.:-]+$/u.test(resourceTypePattern)
  ) {
    throw new TypeError(
      `scopeBoundary.rules[${index}].resourceTypePattern is invalid`,
    );
  }
  if (!rawDimensions || Object.keys(rawDimensions).length > 32) {
    throw new TypeError(
      `scopeBoundary.rules[${index}].dimensions must contain at most 32 dimensions`,
    );
  }
  const dimensions: Record<string, ScopeBoundaryDimension> = {};
  for (const [name, raw] of Object.entries(rawDimensions)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(name) || !isRecord(raw)) {
      throw new TypeError(
        `scopeBoundary.rules[${index}].dimensions.${name} is invalid`,
      );
    }
    const selector = text(raw.selector);
    if (
      !selector ||
      selector.length > 512 ||
      !validJsonPointer(selector) ||
      !Array.isArray(raw.allowedValues) ||
      raw.allowedValues.length > 256 ||
      !raw.allowedValues.every(isScopeScalar)
    ) {
      throw new TypeError(
        `scopeBoundary.rules[${index}].dimensions.${name} must declare an RFC 6901 selector and at most 256 scalar allowedValues`,
      );
    }
    dimensions[name] = { selector, allowedValues: raw.allowedValues };
  }
  return { resourceTypePattern, dimensions };
}

function scalarRecord(
  value: Readonly<Record<string, unknown>>,
): Record<string, PlanScopeScalar> {
  const out: Record<string, PlanScopeScalar> = {};
  for (const [name, fact] of Object.entries(value)) {
    if (
      /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(name) &&
      isScopeScalar(fact)
    ) {
      out[name] = fact;
    }
  }
  return out;
}

function validJsonPointer(value: string): boolean {
  return value.startsWith("/") && !/~(?:[^01]|$)/u.test(value);
}

function isScopeScalar(value: unknown): value is PlanScopeScalar {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
