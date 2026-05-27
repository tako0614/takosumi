/**
 * Lint Takosumi JSON-LD files.
 *
 * Two file shapes are accepted:
 *
 * 1. **Vocabulary root** (= e.g. `spec/contexts/v1.jsonld`). Single
 *    top-level key `@context` whose value is a JSON-LD context object.
 *    `@id` / `@type` / `name` are NOT required.
 * 2. **Reference kind document** (= e.g.
 *    `packages/kind-worker/spec/kind.jsonld`).
 *    Must include a stable takosumi.com kind URI, a supported kind document
 *    type, `version`, `description`, suggested aliases, outputSlots, and
 *    capability terms. Portable kind documents own `spec` and `outputs`;
 *    native kind documents name their `family` and `portableBase`.
 *
 * This linter does not JSON-LD-expand documents. It pins the official
 * takosumi.com catalog envelope and vocabulary so descriptor drift is caught
 * before docs or package publication.
 */
import { walk } from "jsr:@std/fs@^1.0.5/walk";
import { fromFileUrl } from "jsr:@std/path@^1.0.6";
import {
  ACCESS_MODES as OFFICIAL_ACCESS_MODES,
  allowedProjectionFamiliesForMaterialKind,
  isOutputFieldTypeName,
  OFFICIAL_MATERIAL_KIND_NAMES,
  type OfficialMaterialKindName,
  type OutputFieldTypeDefinition,
  PROJECTION_FAMILY_NAMES,
  type ProjectionFamilyName,
  SAFE_DEFAULT_ACCESS_MODES as OFFICIAL_SAFE_DEFAULT_ACCESS_MODES,
  validateOfficialMaterialMapping,
  validateOfficialMaterialMappingOutputFields,
} from "takosumi-contract/catalog";

export interface LintIssue {
  readonly path: string;
  readonly message: string;
}

const ROOTS = [
  fromFileUrl(new URL("../spec/contexts", import.meta.url)),
  ...[
    "kind-worker",
    "kind-web-service",
    "kind-postgres",
    "kind-object-store",
    "kind-gateway",
    "kind-sqlite",
    "kind-kv-store",
    "kind-message-queue",
    "kind-vector-store",
  ].map((name) =>
    fromFileUrl(new URL(`../packages/${name}/spec`, import.meta.url))
  ),
] as const;

const KIND_ID_PREFIX = "https://takosumi.com/kinds/v1/";
const KIND_TYPES = new Set(["ComponentKind"]);
const OUTPUT_CONTRACTS = new Set<string>(OFFICIAL_MATERIAL_KIND_NAMES);
const PROJECTION_FAMILIES = new Set<string>(PROJECTION_FAMILY_NAMES);
const ACCESS_MODES = new Set<string>(OFFICIAL_ACCESS_MODES);
const SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "number",
  "object",
  "string",
]);
const SAFE_DEFAULT_ACCESS_MODES = new Set<string>(
  OFFICIAL_SAFE_DEFAULT_ACCESS_MODES.filter((mode) => mode !== null),
);

async function main(): Promise<void> {
  const issues: LintIssue[] = [];
  let fileCount = 0;
  for (const root of ROOTS) {
    try {
      const stat = await Deno.stat(root);
      if (!stat.isDirectory) {
        console.error(`[lint:json-ld] not a directory: ${root}`);
        Deno.exit(2);
      }
    } catch (_err) {
      console.error(`[lint:json-ld] missing directory: ${root}`);
      Deno.exit(2);
    }

    for await (
      const entry of walk(root, { includeDirs: false, exts: [".jsonld"] })
    ) {
      fileCount++;
      const text = await Deno.readTextFile(entry.path);
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        issues.push({ path: entry.path, message: `invalid JSON: ${cause}` });
        continue;
      }
      if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
        issues.push({
          path: entry.path,
          message: "top-level document must be an object",
        });
        continue;
      }
      const obj = doc as Record<string, unknown>;
      if (obj["@context"] === undefined) {
        issues.push({ path: entry.path, message: "missing @context" });
        continue;
      }
      if (isVocabularyRoot(obj)) continue;
      requireNonEmptyString(obj["@id"], "@id", entry.path, issues);
      requireNonEmptyString(obj["@type"], "@type", entry.path, issues);
      requireNonEmptyString(obj["name"], "name", entry.path, issues);
      checkKindIdentity(obj, entry.path, issues);
      requireNonEmptyString(obj["version"], "version", entry.path, issues);
      requireNonEmptyString(
        obj["description"],
        "description",
        entry.path,
        issues,
      );
      checkReferenceAliases(obj["referenceAliases"], entry.path, issues);
      checkOutputSlots(
        obj["outputSlots"],
        obj["outputs"],
        entry.path,
        issues,
      );
      checkSpecAndInheritance(obj, entry.path, issues);
      checkOutputs(obj["outputs"], obj["portableBase"], entry.path, issues);
      checkCapabilityTerms(obj["capabilityTerms"], entry.path, issues);
      checkNoLegacyAcceptedProjectionFamilies(
        obj["acceptedProjectionFamilies"],
        entry.path,
        issues,
      );
      checkListens(obj["listens"], entry.path, issues);
    }
  }

  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`[lint:json-ld] ${issue.path}: ${issue.message}`);
    }
    console.error(
      `[lint:json-ld] FAIL — ${issues.length} issue(s) across ${fileCount} file(s)`,
    );
    Deno.exit(1);
  }
  console.log(`[lint:json-ld] OK — ${fileCount} file(s) clean`);
}

function requireNonEmptyString(
  value: unknown,
  fieldName: string,
  path: string,
  issues: LintIssue[],
): void {
  if (typeof value !== "string" || value.length === 0) {
    issues.push({
      path,
      message: `${fieldName} must be a non-empty string`,
    });
  }
}

function checkKindIdentity(
  obj: Record<string, unknown>,
  path: string,
  issues: LintIssue[],
): void {
  if (
    typeof obj["@id"] === "string" && !obj["@id"].startsWith(KIND_ID_PREFIX)
  ) {
    issues.push({
      path,
      message: `@id must start with ${KIND_ID_PREFIX}`,
    });
  }
  if (typeof obj["@type"] === "string" && !KIND_TYPES.has(obj["@type"])) {
    issues.push({
      path,
      message: "@type must be ComponentKind",
    });
  }
  if (typeof obj["@id"] === "string" && typeof obj["name"] === "string") {
    const suffix = obj["@id"].slice(KIND_ID_PREFIX.length);
    if (suffix !== obj["name"]) {
      issues.push({
        path,
        message: "name must match the final segment of @id",
      });
    }
  }
}

function checkReferenceAliases(
  value: unknown,
  path: string,
  issues: LintIssue[],
): void {
  if (value === undefined) {
    issues.push({
      path,
      message:
        "missing `referenceAliases` (declare suggested short-name array, may be empty)",
    });
    return;
  }
  if (!Array.isArray(value)) {
    issues.push({
      path,
      message: "`referenceAliases` must be an array of strings",
    });
    return;
  }
  for (const [index, alias] of value.entries()) {
    if (typeof alias !== "string" || !isLocalName(alias)) {
      issues.push({
        path,
        message: `referenceAliases[${index}] must be a local name`,
      });
    }
  }
}

function checkOutputSlots(
  value: unknown,
  outputsValue: unknown,
  path: string,
  issues: LintIssue[],
): void {
  if (value === undefined) {
    issues.push({
      path,
      message:
        "missing `outputSlots` (declare local outputSlots this kind can emit)",
    });
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push({
      path,
      message:
        "`outputSlots` must be an object keyed by local output slot name",
    });
    return;
  }
  if (Object.keys(value).length === 0) {
    issues.push({
      path,
      message: "`outputSlots` must declare at least one local output slot",
    });
    return;
  }
  const outputDefinitions = outputDefinitionsForMapping(outputsValue);
  for (const [key, entry] of Object.entries(value)) {
    if (!isLocalName(key)) {
      issues.push({
        path,
        message: "output slot keys must be local names",
      });
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({
        path,
        message: `outputSlots[${key}] must be an object`,
      });
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e["contract"] !== "string" || e["contract"] === "") {
      issues.push({
        path,
        message: `outputSlots[${key}].contract must be a non-empty string`,
      });
    } else if (!OUTPUT_CONTRACTS.has(e["contract"])) {
      issues.push({
        path,
        message:
          `outputSlots[${key}].contract must be an official material kind`,
      });
    }
    if ("from" in e) {
      issues.push({
        path,
        message:
          `outputSlots[${key}].from is obsolete; use exampleMaterialMapping metadata`,
      });
    }
    if ("material" in e) {
      issues.push({
        path,
        message:
          `outputSlots[${key}].material is ambiguous; use exampleMaterialMapping`,
      });
    }
    const mapping = e["exampleMaterialMapping"];
    if (!isRecord(mapping)) {
      issues.push({
        path,
        message: `outputSlots[${key}].exampleMaterialMapping must be an object`,
      });
      continue;
    }
    if (
      typeof e["contract"] === "string" &&
      OUTPUT_CONTRACTS.has(e["contract"])
    ) {
      for (
        const issue of validateOfficialMaterialMapping(
          e["contract"] as OfficialMaterialKindName,
          mapping,
        )
      ) {
        issues.push({
          path,
          message: formatMaterialMappingIssue(
            `outputSlots[${key}].exampleMaterialMapping`,
            issue.path,
            issue.message,
          ),
        });
      }
      if (outputDefinitions) {
        for (
          const issue of validateOfficialMaterialMappingOutputFields(
            e["contract"] as OfficialMaterialKindName,
            mapping,
            outputDefinitions,
          )
        ) {
          issues.push({
            path,
            message: formatMaterialMappingIssue(
              `outputSlots[${key}].exampleMaterialMapping`,
              issue.path,
              issue.message,
            ),
          });
        }
      }
    }
  }
}

function formatMaterialMappingIssue(
  fieldName: string,
  issuePath: string,
  message: string,
): string {
  const suffix = issuePath === "$" ? "" : issuePath.slice(1);
  return `${fieldName}${suffix} ${message}`;
}

function checkSpecAndInheritance(
  obj: Record<string, unknown>,
  path: string,
  issues: LintIssue[],
): void {
  const type = obj["@type"];
  const spec = obj["spec"];
  const portableBase = obj["portableBase"];
  if (type !== "ComponentKind") {
    return;
  }
  if (portableBase === undefined) {
    if (obj["family"] !== undefined) {
      issues.push({
        path,
        message: "portable ComponentKind must not declare family",
      });
    }
  } else {
    requireNonEmptyString(obj["family"], "family", path, issues);
    requireKindUri(portableBase, "portableBase", path, issues);
  }
  checkSpecSchema(spec, path, issues, { required: true });
}

function checkSpecSchema(
  value: unknown,
  path: string,
  issues: LintIssue[],
  opts: { readonly required: boolean },
): void {
  if (value === undefined) {
    if (opts.required) {
      issues.push({ path, message: "missing `spec` schema" });
    }
    return;
  }
  if (!isRecord(value)) {
    issues.push({ path, message: "`spec` must be an object" });
    return;
  }
  if (value["type"] !== "object") {
    issues.push({ path, message: "`spec.type` must be object" });
  }
  if (
    value["properties"] !== undefined && !isRecord(value["properties"])
  ) {
    issues.push({ path, message: "`spec.properties` must be an object" });
  }
  if (value["required"] !== undefined) {
    checkStringArray(value["required"], "spec.required", path, issues);
  }
  checkJsonSchemaNode(value, "spec", path, issues);
}

export function checkSpecSchemaForTesting(
  value: unknown,
): readonly LintIssue[] {
  const issues: LintIssue[] = [];
  checkSpecSchema(value, "test.jsonld", issues, { required: true });
  return issues;
}

function checkJsonSchemaNode(
  schema: Record<string, unknown>,
  fieldName: string,
  path: string,
  issues: LintIssue[],
): void {
  const schemaType = schema["type"];
  if (
    schemaType !== undefined &&
    (typeof schemaType !== "string" || !SCHEMA_TYPES.has(schemaType))
  ) {
    issues.push({
      path,
      message: `${fieldName}.type must be a supported JSON Schema type`,
    });
  }

  if (schema["required"] !== undefined) {
    checkStringArray(schema["required"], `${fieldName}.required`, path, issues);
  }

  if (schema["enum"] !== undefined) {
    if (!Array.isArray(schema["enum"])) {
      issues.push({ path, message: `${fieldName}.enum must be an array` });
    } else if (schema["enum"].length === 0) {
      issues.push({
        path,
        message: `${fieldName}.enum must contain at least one value`,
      });
    } else {
      for (const [index, entry] of schema["enum"].entries()) {
        if (!isJsonScalar(entry)) {
          issues.push({
            path,
            message: `${fieldName}.enum[${index}] must be a JSON scalar`,
          });
        }
      }
    }
  }

  checkStringKeyword(schema["pattern"], `${fieldName}.pattern`, path, issues);
  checkStringKeyword(schema["title"], `${fieldName}.title`, path, issues);
  if (typeof schema["pattern"] === "string") {
    try {
      new RegExp(schema["pattern"]);
    } catch {
      issues.push({
        path,
        message: `${fieldName}.pattern must be a valid regular expression`,
      });
    }
  }
  checkFiniteNumberKeyword(
    schema["minimum"],
    `${fieldName}.minimum`,
    path,
    issues,
  );
  checkFiniteNumberKeyword(
    schema["maximum"],
    `${fieldName}.maximum`,
    path,
    issues,
  );
  checkNonNegativeIntegerKeyword(
    schema["minLength"],
    `${fieldName}.minLength`,
    path,
    issues,
  );
  checkNonNegativeIntegerKeyword(
    schema["maxLength"],
    `${fieldName}.maxLength`,
    path,
    issues,
  );
  checkNonNegativeIntegerKeyword(
    schema["minItems"],
    `${fieldName}.minItems`,
    path,
    issues,
  );

  const propertyNames = schema["propertyNames"];
  if (propertyNames !== undefined) {
    if (!isRecord(propertyNames)) {
      issues.push({
        path,
        message: `${fieldName}.propertyNames must be an object`,
      });
    } else {
      checkJsonSchemaNode(
        propertyNames,
        `${fieldName}.propertyNames`,
        path,
        issues,
      );
    }
  }

  const properties = schema["properties"];
  if (properties !== undefined) {
    if (!isRecord(properties)) {
      issues.push({
        path,
        message: `${fieldName}.properties must be an object`,
      });
    } else {
      for (const [key, value] of Object.entries(properties)) {
        if (!isLocalName(key)) {
          issues.push({
            path,
            message: `${fieldName}.properties keys must be local names`,
          });
          continue;
        }
        if (!isRecord(value)) {
          issues.push({
            path,
            message: `${fieldName}.properties.${key} must be an object`,
          });
          continue;
        }
        requireNonEmptyString(
          value["description"],
          `${fieldName}.properties.${key}.description`,
          path,
          issues,
        );
        checkJsonSchemaNode(
          value,
          `${fieldName}.properties.${key}`,
          path,
          issues,
        );
      }
    }
  }

  const additionalProperties = schema["additionalProperties"];
  if (
    schemaType === "object" &&
    isRecord(properties) &&
    Object.keys(properties).length > 0 &&
    additionalProperties !== false
  ) {
    issues.push({
      path,
      message:
        `${fieldName}.additionalProperties must be false for object schemas with fixed properties`,
    });
  }

  if (Array.isArray(schema["required"]) && isRecord(properties)) {
    for (const name of schema["required"]) {
      if (typeof name === "string" && properties[name] === undefined) {
        issues.push({
          path,
          message:
            `${fieldName}.required entry ${name} must refer to a property`,
        });
      }
    }
  }

  if (schemaType === "array") {
    if (!isRecord(schema["items"])) {
      issues.push({
        path,
        message: `${fieldName}.items must be an object for array schemas`,
      });
    } else {
      checkJsonSchemaNode(schema["items"], `${fieldName}.items`, path, issues);
    }
  }

  if (
    additionalProperties !== undefined &&
    typeof additionalProperties !== "boolean"
  ) {
    if (!isRecord(additionalProperties)) {
      issues.push({
        path,
        message: `${fieldName}.additionalProperties must be boolean or object`,
      });
    } else {
      checkJsonSchemaNode(
        additionalProperties,
        `${fieldName}.additionalProperties`,
        path,
        issues,
      );
    }
  }
}

function checkOutputs(
  value: unknown,
  portableBase: unknown,
  path: string,
  issues: LintIssue[],
): void {
  if (value === undefined) {
    if (portableBase === undefined) {
      issues.push({
        path,
        message: "portable kind document must declare `outputs`",
      });
    }
    return;
  }
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({
      path,
      message: "`outputs` must be a non-empty array",
    });
    return;
  }
  for (const [index, output] of value.entries()) {
    if (!isRecord(output)) {
      issues.push({ path, message: `outputs[${index}] must be an object` });
      continue;
    }
    if (typeof output["name"] !== "string" || !isLocalName(output["name"])) {
      issues.push({
        path,
        message: `outputs[${index}].name must be a local name`,
      });
    }
    if (
      typeof output["type"] !== "string" ||
      !isOutputFieldTypeName(output["type"])
    ) {
      issues.push({
        path,
        message: `outputs[${index}].type must be a supported output field type`,
      });
    }
    if (typeof output["required"] !== "boolean") {
      issues.push({
        path,
        message: `outputs[${index}].required must be a boolean`,
      });
    }
    requireNonEmptyString(
      output["meaning"],
      `outputs[${index}].meaning`,
      path,
      issues,
    );
    if (output["type"] === "object[]" && output["items"] !== undefined) {
      if (!isRecord(output["items"])) {
        issues.push({
          path,
          message: `outputs[${index}].items must be an object`,
        });
      } else {
        checkJsonSchemaNode(
          output["items"],
          `outputs[${index}].items`,
          path,
          issues,
        );
      }
    }
  }
}

function checkCapabilityTerms(
  value: unknown,
  path: string,
  issues: LintIssue[],
): void {
  if (value === undefined) {
    issues.push({ path, message: "missing `capabilityTerms`" });
    return;
  }
  if (!Array.isArray(value)) {
    issues.push({ path, message: "`capabilityTerms` must be an array" });
    return;
  }
  if (value.length === 0) {
    issues.push({
      path,
      message: "`capabilityTerms` must be a non-empty array",
    });
    return;
  }
  for (const [index, term] of value.entries()) {
    if (typeof term !== "string" || !isLocalName(term)) {
      issues.push({
        path,
        message: `capabilityTerms[${index}] must be a local name`,
      });
    }
  }
}

function outputDefinitionsForMapping(
  value: unknown,
): readonly OutputFieldTypeDefinition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const definitions: OutputFieldTypeDefinition[] = [];
  for (const output of value) {
    if (
      !isRecord(output) ||
      typeof output["name"] !== "string" ||
      typeof output["type"] !== "string" ||
      !isOutputFieldTypeName(output["type"])
    ) {
      return undefined;
    }
    definitions.push({
      name: output["name"],
      type: output["type"],
      ...(typeof output["required"] === "boolean"
        ? { required: output["required"] }
        : {}),
    });
  }
  return definitions;
}

function checkNoLegacyAcceptedProjectionFamilies(
  value: unknown,
  path: string,
  issues: LintIssue[],
): void {
  if (value === undefined) {
    return;
  }
  issues.push({
    path,
    message:
      "`acceptedProjectionFamilies` is obsolete; use slot-local `listens` metadata",
  });
}

function checkListens(
  value: unknown,
  path: string,
  issues: LintIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({
      path,
      message: "`listens` must be an object keyed by listen slot name",
    });
    return;
  }
  for (const [key, slot] of Object.entries(value)) {
    if (key !== "*" && !isLocalName(key)) {
      issues.push({ path, message: "listen slot keys must be local names" });
      continue;
    }
    if (!isRecord(slot)) {
      issues.push({ path, message: `listens[${key}] must be an object` });
      continue;
    }
    checkOutputContractArray(
      slot["accepts"],
      `listens[${key}].accepts`,
      path,
      issues,
    );
    checkProjectionFamilyArray(
      slot["projectionFamilies"],
      `listens[${key}].projectionFamilies`,
      path,
      issues,
    );
    checkListenProjectionCompatibility(
      slot["accepts"],
      slot["projectionFamilies"],
      slot["projectionMatrix"],
      `listens[${key}]`,
      path,
      issues,
    );
    if (slot["minimumAccess"] !== undefined) {
      checkAccessMode(
        slot["minimumAccess"],
        `listens[${key}].minimumAccess`,
        path,
        issues,
      );
    }
    if (slot["safeDefaultAccess"] !== undefined) {
      checkSafeDefaultAccessMode(
        slot["safeDefaultAccess"],
        `listens[${key}].safeDefaultAccess`,
        path,
        issues,
      );
    }
    if (slot["requiredWhenReferencedBy"] !== undefined) {
      requireNonEmptyString(
        slot["requiredWhenReferencedBy"],
        `listens[${key}].requiredWhenReferencedBy`,
        path,
        issues,
      );
    }
  }
}

function isLocalName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function requireKindUri(
  value: unknown,
  fieldName: string,
  path: string,
  issues: LintIssue[],
): void {
  requireNonEmptyString(value, fieldName, path, issues);
  if (typeof value === "string" && !value.startsWith(KIND_ID_PREFIX)) {
    issues.push({
      path,
      message: `${fieldName} must be a takosumi.com kind URI`,
    });
  }
}

function checkStringArray(
  value: unknown,
  fieldName: string,
  path: string,
  issues: LintIssue[],
): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: `${fieldName} must be an array of strings` });
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.length === 0) {
      issues.push({
        path,
        message: `${fieldName}[${index}] must be a non-empty string`,
      });
    }
  }
}

function checkStringKeyword(
  value: unknown,
  fieldName: string,
  path: string,
  issues: LintIssue[],
): void {
  if (value !== undefined && typeof value !== "string") {
    issues.push({ path, message: `${fieldName} must be a string` });
  }
}

function checkFiniteNumberKeyword(
  value: unknown,
  fieldName: string,
  path: string,
  issues: LintIssue[],
): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    issues.push({ path, message: `${fieldName} must be a finite number` });
  }
}

function checkNonNegativeIntegerKeyword(
  value: unknown,
  fieldName: string,
  path: string,
  issues: LintIssue[],
): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 0)
  ) {
    issues.push({
      path,
      message: `${fieldName} must be a non-negative integer`,
    });
  }
}

function isJsonScalar(value: unknown): boolean {
  return value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean";
}

function checkOutputContractArray(
  value: unknown,
  fieldName: string,
  path: string,
  issues: LintIssue[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: `${fieldName} must be a non-empty array` });
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !OUTPUT_CONTRACTS.has(entry)) {
      issues.push({
        path,
        message: `${fieldName}[${index}] must be an official material kind`,
      });
    }
  }
}

function checkProjectionFamilyArray(
  value: unknown,
  fieldName: string,
  path: string,
  issues: LintIssue[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: `${fieldName} must be a non-empty array` });
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !PROJECTION_FAMILIES.has(entry)) {
      issues.push({
        path,
        message: `${fieldName}[${index}] must be an official projection family`,
      });
    }
  }
}

function checkListenProjectionCompatibility(
  acceptsValue: unknown,
  projectionsValue: unknown,
  projectionMatrixValue: unknown,
  fieldName: string,
  path: string,
  issues: LintIssue[],
): void {
  const accepts = officialStringArray(acceptsValue, OUTPUT_CONTRACTS);
  const projections = officialStringArray(
    projectionsValue,
    PROJECTION_FAMILIES,
  );
  if (!accepts || !projections) return;
  const matrix = checkProjectionMatrix(
    projectionMatrixValue,
    accepts,
    projections,
    fieldName,
    path,
    issues,
  );
  for (const contract of accepts) {
    const allowed = allowedProjectionFamiliesForMaterialKind(
      contract as OfficialMaterialKindName,
    );
    const advertised = matrix?.[contract] ?? projections;
    if (
      !advertised.some((projection) =>
        allowed.includes(projection as ProjectionFamilyName)
      )
    ) {
      issues.push({
        path,
        message:
          `${fieldName} has no projection family compatible with ${contract}`,
      });
    }
  }
}

function checkProjectionMatrix(
  value: unknown,
  accepts: readonly string[],
  projections: readonly string[],
  fieldName: string,
  path: string,
  issues: LintIssue[],
): Record<string, string[]> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({
      path,
      message: `${fieldName}.projectionMatrix must be an object`,
    });
    return undefined;
  }
  const out: Record<string, string[]> = {};
  const acceptedSet = new Set(accepts);
  const projectionSet = new Set(projections);
  for (const [contract, entry] of Object.entries(value)) {
    if (!OUTPUT_CONTRACTS.has(contract) || !acceptedSet.has(contract)) {
      issues.push({
        path,
        message:
          `${fieldName}.projectionMatrix.${contract} must name an accepted material kind`,
      });
      continue;
    }
    const projectionList = officialStringArray(entry, PROJECTION_FAMILIES);
    if (!projectionList) {
      issues.push({
        path,
        message:
          `${fieldName}.projectionMatrix.${contract} must be a non-empty projection family array`,
      });
      continue;
    }
    for (const projection of projectionList) {
      if (!projectionSet.has(projection)) {
        issues.push({
          path,
          message:
            `${fieldName}.projectionMatrix.${contract} includes projection not listed in projectionFamilies`,
        });
      }
      if (
        !allowedProjectionFamiliesForMaterialKind(
          contract as OfficialMaterialKindName,
        ).includes(projection as ProjectionFamilyName)
      ) {
        issues.push({
          path,
          message:
            `${fieldName}.projectionMatrix.${contract} includes incompatible projection ${projection}`,
        });
      }
    }
    out[contract] = projectionList;
  }
  return out;
}

function officialStringArray(
  value: unknown,
  allowed: ReadonlySet<string>,
): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.has(entry)) return undefined;
    out.push(entry);
  }
  return out;
}

function checkAccessMode(
  value: unknown,
  fieldName: string,
  path: string,
  issues: LintIssue[],
): void {
  if (typeof value !== "string" || !ACCESS_MODES.has(value)) {
    issues.push({
      path,
      message: `${fieldName} must be an official access mode`,
    });
  }
}

function checkSafeDefaultAccessMode(
  value: unknown,
  fieldName: string,
  path: string,
  issues: LintIssue[],
): void {
  if (value === null) return;
  if (typeof value !== "string" || !SAFE_DEFAULT_ACCESS_MODES.has(value)) {
    issues.push({
      path,
      message: `${fieldName} must be null or a safe default access mode`,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A vocabulary root document declares term mappings only. It has a
 * single top-level key (`@context`) and no `@id` / `@type` / `name`.
 */
function isVocabularyRoot(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  return keys.length === 1 && keys[0] === "@context";
}

if (import.meta.main) {
  await main();
}
