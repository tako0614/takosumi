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
export const TAKOSUMI_MANIFEST_JSONLD_CONTEXT =
  "https://takosumi.com/contexts/manifest-v1.jsonld" as const;

export type ManifestJsonLdContext =
  | string
  | JsonObject
  | readonly (string | JsonObject)[];

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
  readonly "@context"?: ManifestJsonLdContext;
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

export interface ManifestEnvelopeValidationOptions {
  /**
   * CLI local compatibility for the friendlier shorthand
   * `template: { name: "id" }`. Canonical remote manifests must use
   * `template.template: "id@version"`.
   */
  readonly allowTemplateName?: boolean;
  /**
   * Backward compatibility for early v1 public deploy clients that used
   * `template.ref` as the pinned template reference.
   */
  readonly allowLegacyTemplateRef?: boolean;
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
  options: ManifestEnvelopeValidationOptions = {},
): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    issues.push({ path: "$", message: "manifest must be a JSON object" });
    return;
  }
  const m = body as Record<string, unknown>;
  pushUnknownKeys("$", m, [
    "@context",
    "apiVersion",
    "kind",
    "metadata",
    "template",
    "resources",
  ], issues);
  validateManifestJsonLdContext(m["@context"], issues);
  if (m.apiVersion !== MANIFEST_API_VERSION) {
    issues.push({
      path: "$.apiVersion",
      message: `apiVersion must be "${MANIFEST_API_VERSION}" ` +
        `(got: ${JSON.stringify(m.apiVersion)})`,
    });
  }
  if (m.kind !== MANIFEST_KIND) {
    issues.push({
      path: "$.kind",
      message: `kind must be "${MANIFEST_KIND}" ` +
        `(got: ${JSON.stringify(m.kind)})`,
    });
  }
  validateManifestMetadata(m.metadata, issues);
  validateManifestTemplateInvocation(m.template, issues, options);
  validateManifestResources(m.resources, issues);
}

function validateManifestJsonLdContext(
  context: unknown,
  issues: ManifestEnvelopeIssue[],
): void {
  if (context === undefined) return;
  if (isNonEmptyString(context)) return;
  if (isRecord(context) && isJsonValue(context)) return;
  if (Array.isArray(context) && context.length > 0) {
    const invalidIndex = context.findIndex((entry) =>
      !(isNonEmptyString(entry) || (isRecord(entry) && isJsonValue(entry)))
    );
    if (invalidIndex < 0) return;
    issues.push({
      path: `$["@context"][${invalidIndex}]`,
      message:
        "@context entries must be non-empty strings or JSON-LD context objects",
    });
    return;
  }
  issues.push({
    path: `$["@context"]`,
    message:
      "@context must be a non-empty string, JSON-LD context object, or non-empty array of those values",
  });
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

function validateManifestMetadata(
  metadata: unknown,
  issues: ManifestEnvelopeIssue[],
): void {
  if (metadata === undefined) return;
  if (!isRecord(metadata)) {
    issues.push({
      path: "$.metadata",
      message: "metadata must be a JSON object",
    });
    return;
  }
  pushUnknownKeys("$.metadata", metadata, ["name", "labels"], issues);
  if (metadata.name !== undefined && !isNonEmptyString(metadata.name)) {
    issues.push({
      path: "$.metadata.name",
      message: "metadata.name must be a non-empty string",
    });
  }
  if (metadata.labels !== undefined) {
    validateStringMap("$.metadata.labels", metadata.labels, issues);
  }
}

function validateManifestTemplateInvocation(
  template: unknown,
  issues: ManifestEnvelopeIssue[],
  options: ManifestEnvelopeValidationOptions,
): void {
  if (template === undefined) return;
  if (!isRecord(template)) {
    issues.push({
      path: "$.template",
      message: "template must be a JSON object",
    });
    return;
  }

  const allowed = ["template", "inputs"];
  if (options.allowLegacyTemplateRef !== false) allowed.push("ref");
  if (options.allowTemplateName === true) allowed.push("name");
  pushUnknownKeys("$.template", template, allowed, issues);

  for (const key of ["template", "ref", "name"]) {
    if (
      template[key] !== undefined &&
      !isNonEmptyString(template[key])
    ) {
      issues.push({
        path: `$.template.${key}`,
        message: `template.${key} must be a non-empty string`,
      });
    }
  }
  if (template.inputs !== undefined && !isRecord(template.inputs)) {
    issues.push({
      path: "$.template.inputs",
      message: "template.inputs must be a JSON object",
    });
  }
}

function validateManifestResources(
  resources: unknown,
  issues: ManifestEnvelopeIssue[],
): void {
  if (resources === undefined) return;
  if (!Array.isArray(resources)) {
    issues.push({
      path: "$.resources",
      message: "resources must be an array",
    });
    return;
  }
  resources.forEach((resource, index) => {
    const path = `$.resources[${index}]`;
    if (!isRecord(resource)) {
      issues.push({ path, message: "resource must be a JSON object" });
      return;
    }
    pushUnknownKeys(path, resource, [
      "shape",
      "name",
      "provider",
      "spec",
      "requires",
      "metadata",
    ], issues);
    for (const key of ["shape", "name", "provider"]) {
      if (!isNonEmptyString(resource[key])) {
        issues.push({
          path: `${path}.${key}`,
          message: `${key} must be a non-empty string`,
        });
      }
    }
    if (resource.spec === undefined) {
      issues.push({ path: `${path}.spec`, message: "spec is required" });
    } else if (!isJsonValue(resource.spec)) {
      issues.push({
        path: `${path}.spec`,
        message: "spec must be JSON-compatible",
      });
    }
    if (resource.requires !== undefined) {
      if (!Array.isArray(resource.requires)) {
        issues.push({
          path: `${path}.requires`,
          message: "requires must be an array of non-empty strings",
        });
      } else {
        resource.requires.forEach((required, requiredIndex) => {
          if (!isNonEmptyString(required)) {
            issues.push({
              path: `${path}.requires[${requiredIndex}]`,
              message: "requires entries must be non-empty strings",
            });
          }
        });
      }
    }
    if (resource.metadata !== undefined && !isRecord(resource.metadata)) {
      issues.push({
        path: `${path}.metadata`,
        message: "metadata must be a JSON object",
      });
    }
  });
}

function pushUnknownKeys(
  path: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
  issues: ManifestEnvelopeIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: `${key} is not a known field`,
      });
    }
  }
}

function validateStringMap(
  path: string,
  value: unknown,
  issues: ManifestEnvelopeIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be a JSON object of strings" });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      issues.push({
        path: `${path}.${key}`,
        message: "must be a string",
      });
    }
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null || typeof value === "string" ||
    typeof value === "number" || typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
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
