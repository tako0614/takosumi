/**
 * Hand-rolled validation for official template definitions and their inputs.
 *
 * The repo avoids heavy deps (no zod here), matching the deploy-control domain's
 * hand-rolled guard style. Two surfaces are validated:
 *   - {@link assertValidTemplate}: structural invariants on a catalog entry,
 *     run once when the registry is built (fail fast on a bad catalog object).
 *   - {@link validateTemplateInputs}: per-request typed input validation against
 *     `template.inputs`, returning normalized literal values for rootgen.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  TemplateDefinition,
  TemplateInputSpec,
} from "takosumi-contract/deploy-control-api";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";

/** Literal input values accepted by rootgen (HCL scalars). */
export type TemplateInputValue = string | number | boolean;

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
// HCL identifier (used for input variable names, output names, and `from`
// references); keeps rootgen from emitting unquoted, injectable identifiers.
const HCL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
// In-image baked module path: absolute, no traversal.
const LOCAL_MODULE_PATH_RE = /^\/[A-Za-z0-9._\-/]+$/;
// Provider rule shape (`namespace/type` or `registry/namespace/type`).
const PROVIDER_RULE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;
const RESOURCE_TYPE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function fail(message: string): never {
  throw new OpenTofuControllerError("invalid_argument", message);
}

/**
 * Structurally validates a catalog `TemplateDefinition`. Throws on any
 * malformed field so a bad catalog object can never reach rootgen / dispatch.
 */
export function assertValidTemplate(template: TemplateDefinition): void {
  const where = `template ${template.id ?? "<unknown>"}`;
  if (typeof template.id !== "string" || !ID_RE.test(template.id)) {
    fail(`${where}: id must be a kebab-case slug`);
  }
  if (typeof template.name !== "string" || template.name.trim().length === 0) {
    fail(`${where}: name must be a non-empty string`);
  }
  if (typeof template.version !== "string" || !SEMVER_RE.test(template.version)) {
    fail(`${where}: version must be semver (major.minor.patch)`);
  }
  if (
    !template.source ||
    typeof template.source.localModulePath !== "string" ||
    !LOCAL_MODULE_PATH_RE.test(template.source.localModulePath) ||
    template.source.localModulePath.includes("..")
  ) {
    fail(`${where}: source.localModulePath must be an absolute in-image path without traversal`);
  }
  assertValidBuild(template, where);
  assertValidInputs(template, where);
  assertValidOutputs(template, where);
  assertValidPolicy(template, where);
}

function assertValidBuild(template: TemplateDefinition, where: string): void {
  const build = template.build;
  if (build === undefined) return;
  if (build.runtime !== "bun") fail(`${where}: build.runtime must be "bun"`);
  if (
    !Array.isArray(build.commands) ||
    build.commands.length === 0 ||
    build.commands.some((cmd) => typeof cmd !== "string" || cmd.trim().length === 0)
  ) {
    fail(`${where}: build.commands must be a non-empty array of non-empty strings`);
  }
  if (
    typeof build.artifactPath !== "string" ||
    build.artifactPath.trim().length === 0 ||
    build.artifactPath.startsWith("/") ||
    build.artifactPath.split(/[\\/]+/).some((part) => part === "..")
  ) {
    fail(`${where}: build.artifactPath must be a relative path inside the source root`);
  }
}

function assertValidInputs(template: TemplateDefinition, where: string): void {
  if (!template.inputs || typeof template.inputs !== "object") {
    fail(`${where}: inputs must be an object`);
  }
  const names = Object.keys(template.inputs);
  if (names.length === 0) fail(`${where}: inputs must declare at least one input`);
  for (const name of names) {
    if (!HCL_IDENT_RE.test(name)) {
      fail(`${where}: input name ${name} must be an HCL identifier`);
    }
    const spec = template.inputs[name]!;
    if (
      spec.type !== "string" && spec.type !== "number" && spec.type !== "boolean"
    ) {
      fail(`${where}: input ${name} type must be string|number|boolean`);
    }
    if (typeof spec.title !== "string" || spec.title.trim().length === 0) {
      fail(`${where}: input ${name} title must be a non-empty string`);
    }
    if (typeof spec.required !== "boolean") {
      fail(`${where}: input ${name} required must be a boolean`);
    }
    if (spec.default !== undefined && !matchesType(spec.default, spec.type)) {
      fail(`${where}: input ${name} default does not match type ${spec.type}`);
    }
  }
}

function assertValidOutputs(template: TemplateDefinition, where: string): void {
  if (!template.outputs || typeof template.outputs.public !== "object") {
    fail(`${where}: outputs.public must be an object`);
  }
  for (const [name, spec] of Object.entries(template.outputs.public)) {
    if (!HCL_IDENT_RE.test(name)) {
      fail(`${where}: public output name ${name} must be an HCL identifier`);
    }
    if (typeof spec.type !== "string" || spec.type.trim().length === 0) {
      fail(`${where}: public output ${name} type must be a non-empty string`);
    }
    if (typeof spec.from !== "string" || !HCL_IDENT_RE.test(spec.from)) {
      fail(`${where}: public output ${name} from must be an HCL identifier`);
    }
  }
}

function assertValidPolicy(template: TemplateDefinition, where: string): void {
  const policy = template.policy;
  if (!policy) fail(`${where}: policy is required`);
  if (
    !Array.isArray(policy.allowedProviders) ||
    policy.allowedProviders.length === 0 ||
    policy.allowedProviders.some((p) => typeof p !== "string" || !PROVIDER_RULE_RE.test(p))
  ) {
    fail(`${where}: policy.allowedProviders must be non-empty provider rules`);
  }
  if (
    !Array.isArray(policy.allowedResourceTypes) ||
    policy.allowedResourceTypes.length === 0 ||
    policy.allowedResourceTypes.some((t) => typeof t !== "string" || !RESOURCE_TYPE_RE.test(t))
  ) {
    fail(`${where}: policy.allowedResourceTypes must be non-empty resource type names`);
  }
  if (
    !policy.destructiveChanges ||
    typeof policy.destructiveChanges.requireExplicitConfirmation !== "boolean"
  ) {
    fail(`${where}: policy.destructiveChanges.requireExplicitConfirmation must be a boolean`);
  }
}

/**
 * Validates request `inputs` against a template's input specs and returns the
 * normalized literal values rootgen renders into HCL. Rejects unknown inputs,
 * missing required inputs, and type mismatches. Optional inputs with a declared
 * default are filled; optional inputs without a default are omitted.
 */
export function validateTemplateInputs(
  template: TemplateDefinition,
  inputs: Readonly<Record<string, JsonValue>> | undefined,
): Record<string, TemplateInputValue> {
  const provided = inputs ?? {};
  if (typeof provided !== "object" || Array.isArray(provided)) {
    fail(`template ${template.id}: inputs must be a JSON object`);
  }
  for (const key of Object.keys(provided)) {
    if (!(key in template.inputs)) {
      fail(`template ${template.id}: unknown input ${key}`);
    }
  }
  const normalized: Record<string, TemplateInputValue> = {};
  for (const [name, spec] of Object.entries(template.inputs)) {
    const value = provided[name];
    if (value === undefined || value === null) {
      if (spec.required) {
        fail(`template ${template.id}: input ${name} is required`);
      }
      if (spec.default !== undefined) normalized[name] = spec.default;
      continue;
    }
    normalized[name] = coerceInput(template.id, name, spec, value);
  }
  return normalized;
}

function coerceInput(
  templateId: string,
  name: string,
  spec: TemplateInputSpec,
  value: JsonValue,
): TemplateInputValue {
  if (!matchesType(value, spec.type)) {
    fail(`template ${templateId}: input ${name} must be a ${spec.type}`);
  }
  if (spec.type === "number" && !Number.isFinite(value as number)) {
    fail(`template ${templateId}: input ${name} must be a finite number`);
  }
  return value as TemplateInputValue;
}

function matchesType(value: unknown, type: TemplateInputSpec["type"]): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number";
  return typeof value === "boolean";
}
