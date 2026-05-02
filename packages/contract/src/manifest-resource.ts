import type { JsonObject, JsonValue } from "./types.ts";

export interface ManifestResource {
  readonly shape: string;
  readonly name: string;
  readonly provider: string;
  readonly spec: JsonValue;
  readonly requires?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface ManifestTemplateInvocation {
  readonly template: string;
  readonly inputs?: JsonObject;
}

export type ResolvedRefKind = "ref" | "secret-ref";

export interface ResolvedRef {
  readonly kind: ResolvedRefKind;
  readonly source: string;
  readonly field: string;
}

const REF_NAME = "[A-Za-z_][\\w-]*";
const REF_FULL_PATTERN = new RegExp(
  `^\\$\\{(ref|secret-ref):(${REF_NAME})\\.(${REF_NAME})\\}$`,
);
const REF_GLOBAL_PATTERN = new RegExp(
  `\\$\\{(ref|secret-ref):(${REF_NAME})\\.(${REF_NAME})\\}`,
  "g",
);

export function parseRef(expression: string): ResolvedRef | undefined {
  const match = REF_FULL_PATTERN.exec(expression);
  if (!match) return undefined;
  return {
    kind: match[1] === "secret-ref" ? "secret-ref" : "ref",
    source: match[2],
    field: match[3],
  };
}

export function extractRefs(value: string): readonly ResolvedRef[] {
  const refs: ResolvedRef[] = [];
  let match: RegExpExecArray | null;
  REF_GLOBAL_PATTERN.lastIndex = 0;
  while ((match = REF_GLOBAL_PATTERN.exec(value)) !== null) {
    refs.push({
      kind: match[1] === "secret-ref" ? "secret-ref" : "ref",
      source: match[2],
      field: match[3],
    });
  }
  return refs;
}

export function extractRefsFromValue(value: JsonValue): readonly ResolvedRef[] {
  const refs: ResolvedRef[] = [];
  walkValue(value, refs);
  return refs;
}

function walkValue(value: JsonValue, refs: ResolvedRef[]): void {
  if (typeof value === "string") {
    for (const ref of extractRefs(value)) refs.push(ref);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) walkValue(entry, refs);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) walkValue(entry, refs);
  }
}
