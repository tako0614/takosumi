import type { JsonObject, JsonValue } from "./types.ts";

/**
 * Pinned envelope identifier for every Takosumi manifest. The `apiVersion`
 * and `kind` fields are required from 0.13 onward — operators that omit
 * them are rejected at the deploy public route. The version is bumped when
 * a future manifest schema breaks compatibility (additive shape /
 * provider / template changes do NOT bump it).
 */
export const MANIFEST_API_VERSION = "1.0" as const;
export const MANIFEST_KIND = "Manifest" as const;

export interface ManifestMetadata {
  readonly name?: string;
  readonly labels?: { readonly [key: string]: string };
}

/**
 * Top-level shape of a Takosumi manifest. The wire representation is YAML
 * or JSON; the envelope must pin `apiVersion` and `kind` so the kernel can
 * route future schema versions to compatible validators.
 */
export interface Manifest {
  readonly apiVersion: typeof MANIFEST_API_VERSION;
  readonly kind: typeof MANIFEST_KIND;
  readonly metadata?: ManifestMetadata;
  readonly template?: ManifestTemplateInvocation;
  readonly resources?: readonly ManifestResource[];
}

export interface ManifestEnvelopeIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Validate the top-level apiVersion / kind of a manifest body. Returns
 * issues (empty == valid). Designed to run BEFORE template expansion or
 * resource resolution so misversioned manifests fail fast with an actionable
 * error.
 */
export function validateManifestEnvelope(
  body: unknown,
  issues: ManifestEnvelopeIssue[],
): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    issues.push({ path: "$", message: "manifest must be a JSON object" });
    return;
  }
  const m = body as Record<string, unknown>;
  if (m.apiVersion !== MANIFEST_API_VERSION) {
    issues.push({
      path: "$.apiVersion",
      message:
        `apiVersion must be "${MANIFEST_API_VERSION}" ` +
        `(got: ${JSON.stringify(m.apiVersion)})`,
    });
  }
  if (m.kind !== MANIFEST_KIND) {
    issues.push({
      path: "$.kind",
      message:
        `kind must be "${MANIFEST_KIND}" ` +
        `(got: ${JSON.stringify(m.kind)})`,
    });
  }
}

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
