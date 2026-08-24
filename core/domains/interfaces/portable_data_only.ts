import forbiddenVocabularyDocument from "./forbidden-vocabulary.v0.json" with { type: "json" };

type PortableDataValue =
  | null
  | boolean
  | number
  | string
  | readonly PortableDataValue[]
  | { readonly [key: string]: PortableDataValue };

/**
 * Validates the portable, data-only vocabulary used by Interface declarations.
 * This admission rule is intentionally independent from the signed Form
 * Package verifier: Interfaces remain a generic Git/OpenTofu handoff even
 * though the field-policy vocabulary is pinned to the external contract.
 */
export function assertPortableDataOnly(
  value: PortableDataValue,
  path = "$",
): void {
  rejectForbiddenDefinitionContent(value, path);
}

function rejectForbiddenDefinitionContent(
  value: PortableDataValue,
  path: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, position) =>
      rejectForbiddenDefinitionContent(entry, `${path}[${position}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenFieldName(key)) {
      throw new TypeError(`forbidden field ${key} at ${path}`);
    }
    rejectForbiddenDefinitionContent(child, `${path}.${key}`);
  }
}

interface ForbiddenVocabulary {
  readonly normalizedFields: ReadonlySet<string>;
  readonly tokens: ReadonlySet<string>;
  readonly pluralTokens: ReadonlySet<string>;
  readonly tokenSequences: readonly (readonly string[])[];
  readonly compoundBases: readonly string[];
  readonly compoundQualifiers: ReadonlySet<string>;
  readonly sequenceTokenPlurals: Readonly<Record<string, string>>;
}

const FORBIDDEN_VOCABULARY: ForbiddenVocabulary = loadForbiddenVocabulary(
  forbiddenVocabularyDocument,
);

function loadForbiddenVocabulary(document: {
  readonly format: string;
  readonly normalizedFields: readonly string[];
  readonly tokens: readonly string[];
  readonly pluralTokens: readonly string[];
  readonly tokenSequences: readonly (readonly string[])[];
  readonly compoundBases: readonly string[];
  readonly compoundQualifiers: readonly string[];
  readonly sequenceTokenPlurals: Readonly<Record<string, string>>;
}): ForbiddenVocabulary {
  if (document.format !== "takoform.forbidden-vocabulary@v0") {
    throw new TypeError(
      `embedded forbidden vocabulary has wrong format ${document.format}`,
    );
  }
  return {
    normalizedFields: new Set(document.normalizedFields),
    tokens: new Set(document.tokens),
    pluralTokens: new Set(document.pluralTokens),
    tokenSequences: document.tokenSequences,
    compoundBases: document.compoundBases,
    compoundQualifiers: new Set(document.compoundQualifiers),
    sequenceTokenPlurals: document.sequenceTokenPlurals,
  };
}

export function forbiddenFieldName(value: string): boolean {
  const normalized = normalizeFieldName(value);
  if (FORBIDDEN_VOCABULARY.normalizedFields.has(normalized)) return true;
  for (const singular of FORBIDDEN_VOCABULARY.compoundBases) {
    for (const base of [singular, `${singular}s`]) {
      if (normalized === base) return true;
      if (
        normalized.startsWith(base) &&
        FORBIDDEN_VOCABULARY.compoundQualifiers.has(
          normalized.slice(base.length),
        )
      ) {
        return true;
      }
    }
  }
  const tokens = splitFieldTokens(value);
  if (
    tokens.some(
      (token) =>
        FORBIDDEN_VOCABULARY.tokens.has(token) ||
        FORBIDDEN_VOCABULARY.pluralTokens.has(token),
    )
  ) {
    return true;
  }
  return FORBIDDEN_VOCABULARY.tokenSequences.some((sequence) =>
    containsTokenSequence(tokens, sequence),
  );
}

function containsTokenSequence(
  tokens: readonly string[],
  sequence: readonly string[],
): boolean {
  if (sequence.length === 0 || tokens.length < sequence.length) return false;
  for (let start = 0; start <= tokens.length - sequence.length; start++) {
    if (
      sequence.every((wanted, offset) =>
        matchesCompoundToken(tokens[start + offset] ?? "", wanted),
      )
    ) {
      return true;
    }
  }
  return false;
}

function matchesCompoundToken(actual: string, singular: string): boolean {
  if (actual === singular) return true;
  const plural = FORBIDDEN_VOCABULARY.sequenceTokenPlurals[singular];
  return plural !== undefined && actual === plural;
}

function normalizeFieldName(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

function splitFieldTokens(value: string): string[] {
  return value
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, "$1 $2")
    .replace(/([\p{L}])(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})([\p{L}])/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function isRecord(
  value: PortableDataValue,
): value is Readonly<Record<string, PortableDataValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
