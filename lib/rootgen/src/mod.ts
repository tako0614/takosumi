/**
 * Root-module generation (rootgen).
 *
 * Generates the optional child-module wrapper used when explicit provider
 * alias/configuration or an operator-owned Resource module requires a generated
 * root. Ordinary Git OpenTofu modules do not pass through rootgen.
 *
 * Generated files:
 *   - versions.tf : `terraform { required_providers { ... } }` from the exact
 *                   child-module requirements, preserving exact versions when
 *                   present without inferring version pins.
 *   - main.tf     : `module "child" { source = "./module"; <inputs> }`.
 *   - variables.tf : generated ONLY when a provider binding declares run-scoped
 *                   sensitive inputs. It declares one ephemeral, sensitive,
 *                   defaultless `map(string)` root variable per declaring
 *                   provider instance. Values never appear here, in the plan,
 *                   or in state; the runner supplies them to `tofu` out of
 *                   band, at plan and again at apply.
 *   - outputs.tf  : passthrough of the explicit output allowlist only:
 *                   `output "<public>" { value = module.child.<from> }`.
 *                   OpenTofu outputs are ordinary return values; rootgen never
 *                   adds Takosumi control declarations or reserved names.
 *   - main.tf also carries a `moved` block from the pre-v1 `module.app`
 *                   address to `module.child`, so this terminology cleanup does
 *                   not recreate resources already recorded in state.
 *
 * Inputs are emitted as escaped JSON-compatible HCL literals.
 *
 * Provider blocks contain only explicit, non-secret `providerConfig` values.
 * Every CredentialRecipe is materialized separately as run-scoped env/files;
 * rootgen never infers provider credential arguments.
 */

import type { DispatchGeneratedRoot } from "@takosumi/internal/deploy-control-api";
import type { JsonValue } from "takosumi-contract";
import type { OutputAllowlistEntry } from "takosumi-contract/install-configs";
import {
  canonicalProviderSource,
  isOpenTofuBuiltinProviderSource,
  isOpenTofuIdentifier,
} from "../../../contract/provider-env-rules.ts";

const CHILD_MODULE_SOURCE = "./module";

/** Public validation code translated by Core at the rootgen call boundary. */
export const ROOTGEN_VALIDATION_ERROR_CODE = "invalid_argument" as const;

export const ROOTGEN_VALIDATION_ERROR_REASONS = [
  "rootgen_invalid_identifier",
  "rootgen_provider_configuration_alias_override",
  "rootgen_conflicting_provider_bindings",
  "rootgen_conflicting_provider_local_names",
  "rootgen_provider_binding_outside_root_requirements",
  "rootgen_explicit_provider_source_required",
  "rootgen_non_finite_number_input",
  "rootgen_unsupported_json_input",
  "rootgen_runtime_input_nonce_invalid",
  "rootgen_runtime_input_argument_invalid",
  "rootgen_runtime_input_argument_conflict",
] as const;

export type RootgenValidationErrorCode = typeof ROOTGEN_VALIDATION_ERROR_CODE;
export type RootgenValidationErrorReason =
  (typeof ROOTGEN_VALIDATION_ERROR_REASONS)[number];

export interface RootgenValidationErrorDetails {
  readonly reason: RootgenValidationErrorReason;
}

/**
 * Layer-neutral root-module validation failure.
 *
 * Rootgen is a leaf library, so it must not throw Core controller errors.
 * Core translates this error exactly once at each runtime call boundary.
 */
export class RootgenValidationError extends Error {
  readonly code: RootgenValidationErrorCode = ROOTGEN_VALIDATION_ERROR_CODE;
  readonly details: RootgenValidationErrorDetails;

  constructor(reason: RootgenValidationErrorReason, message: string) {
    super(message);
    this.name = "RootgenValidationError";
    this.details = Object.freeze({ reason });
  }
}

export interface GeneratedRootModule extends DispatchGeneratedRoot {
  readonly files: Readonly<Record<string, string>>;
}

/** One OpenTofu provider binding emitted into the generated root. */
export interface RootProviderBinding {
  /** Explicit provider source (`namespace/type` or `hostname/namespace/type`). */
  readonly provider: string;
  /** Exact provider local name expected by the child module. */
  readonly moduleLocalName: string;
  /** Alias expected by the child module; absent means its default provider. */
  readonly childAlias?: string;
  /** Alias of the root provider block; absent means its default provider. */
  readonly rootAlias?: string;
  /** Non-secret provider-block arguments rendered as escaped HCL literals. */
  readonly configuration?: Readonly<Record<string, JsonValue>>;
  /**
   * Run-scoped sensitive provider inputs for THIS provider instance.
   *
   * Only the plan-stable `nonce` is rendered (it is not a secret). The map
   * argument is rendered as a bare `var.<name>` reference to an ephemeral,
   * sensitive root variable the runner supplies at plan and apply. No value is
   * ever written into the generated root, so nothing reaches the plan file,
   * `tfplan.json`, outputs, or state. A provider instance that does not declare
   * this receives neither argument.
   */
  readonly runtimeInputs?: RootProviderRuntimeInputs;
}

/** Value-free wiring for one provider instance's run-scoped sensitive inputs. */
export interface RootProviderRuntimeInputs {
  /** Plan-stable nonce; unpadded base64url, 22..128 characters. */
  readonly nonce: string;
  /** Provider-block argument receiving the nonce. */
  readonly nonceArgument: string;
  /** Provider-block argument receiving the ephemeral sensitive map. */
  readonly mapArgument: string;
}

/**
 * Reserved generated-root variable prefix. The generated root declares no other
 * root variables (child-module inputs are literal `module "child"` arguments),
 * so this namespace cannot collide with Capsule authorship.
 */
export const ROOT_RUNTIME_INPUTS_VARIABLE_PREFIX =
  "takosumi_runtime_inputs__" as const;

const RUNTIME_INPUT_NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const RUNTIME_INPUT_NONCE_MIN_BYTES = 16;

/**
 * A provider does not merely regex-match the nonce: it decodes it as unpadded
 * base64url, requires at least 16 decoded bytes, and re-encodes to check the
 * value is canonical. A nonce that passes the pattern but fails any of those
 * would be refused only after the reviewed root was already baked, so rootgen
 * applies the same three checks here.
 */
function isCanonicalRuntimeInputNonce(value: string): boolean {
  if (typeof value !== "string" || !RUNTIME_INPUT_NONCE_PATTERN.test(value)) {
    return false;
  }
  // Unpadded base64url encodes 4 characters per 3 bytes; a remainder of 1 is
  // not producible by any byte string.
  if (value.length % 4 === 1) return false;
  let decoded: Uint8Array;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return false;
  }
  // The 22-character minimum already implies 16 bytes; the check stays because
  // the provider applies it independently and the two must not drift.
  if (decoded.byteLength < RUNTIME_INPUT_NONCE_MIN_BYTES) return false;
  let binary = "";
  for (const byte of decoded) binary += String.fromCharCode(byte);
  const canonical = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return canonical === value;
}

/**
 * Exact generated-root variable name carrying one provider instance's Apply-only
 * sensitive map. Provider-instance identity is `(moduleLocalName, rootAlias)`,
 * the same tuple rootgen already uses for provider blocks and the child provider
 * map, so Core and the runner derive the same name from the same authority.
 */
export function rootRuntimeInputsVariableName(
  binding: Pick<RootProviderBinding, "moduleLocalName" | "rootAlias">,
): string {
  assertIdentifier(binding.moduleLocalName, "rootgen: provider local name");
  if (binding.rootAlias === undefined) {
    return `${ROOT_RUNTIME_INPUTS_VARIABLE_PREFIX}${binding.moduleLocalName}`;
  }
  assertIdentifier(binding.rootAlias, "rootgen: root provider alias");
  return `${ROOT_RUNTIME_INPUTS_VARIABLE_PREFIX}${binding.moduleLocalName}__${binding.rootAlias}`;
}

export interface RootProviderRequirement {
  /** Explicit provider source (`namespace/type` or `hostname/namespace/type`). */
  readonly source: string;
  /** Exact local name declared in the child module. */
  readonly moduleLocalName: string;
  /** Exact configuration alias declared by the selected root module. */
  readonly childAlias?: string;
  /** Exact literal version only when selected-root analysis proved one. */
  readonly version?: string;
}

export interface GenerateOpenTofuChildModuleRootInput {
  /** Exact provider identities declared or used by the selected root module. */
  readonly rootProviderRequirements: readonly RootProviderRequirement[];
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly providerBindings?: ReadonlyArray<RootProviderBinding>;
}

/**
 * Optional OpenTofu child-module wrapper. Takosumi owns only the provider-wiring
 * root. The runner copies the selected module to `./module`; this root wires
 * literal variable/dependency inputs, provider bindings, and output allowlist
 * passthroughs. The same function serves Capsule and first-class Resource runs.
 */
export function generateOpenTofuChildModuleRoot(
  input: GenerateOpenTofuChildModuleRootInput,
): GeneratedRootModule {
  // Built-in runtime capabilities (for example terraform.io/builtin/terraform)
  // are available from OpenTofu itself and must never be rendered as provider
  // packages, configurations, or child-module mappings.
  const providerBindings = (input.providerBindings ?? []).filter(
    (binding) => !isOpenTofuBuiltinProviderSource(binding.provider),
  );
  const rootProviderRequirements = input.rootProviderRequirements.filter(
    (requirement) => !isOpenTofuBuiltinProviderSource(requirement.source),
  );
  const runtimeInputVariables = runtimeInputVariableDeclarations(
    providerBindings,
  );
  return {
    files: {
      "versions.tf": renderProviderVersionsTf(rootProviderRequirements),
      // Emitted only for a root that actually declares run-scoped sensitive
      // provider inputs, so every existing Capsule keeps a byte-identical
      // generated root.
      ...(runtimeInputVariables.length > 0
        ? { "variables.tf": renderRuntimeInputVariablesTf(runtimeInputVariables) }
        : {}),
      "main.tf": renderGenericMainTf(
        input.inputs,
        providerBindings,
        rootProviderRequirements,
      ),
      "outputs.tf": renderGenericOutputsTf(input.outputAllowlist),
    },
  };
}

interface RuntimeInputVariableDeclaration {
  readonly variableName: string;
  readonly runtimeInputs: RootProviderRuntimeInputs;
}

/**
 * One declaration per declaring provider instance, keyed by the exact generated
 * variable name. Two bindings that resolve to the same provider instance must
 * agree byte-for-byte; disagreement is a wiring conflict, never a silent merge.
 *
 * The variable name flattens `(moduleLocalName, rootAlias)` with a `__`
 * separator, so two DIFFERENT instances can collide on one name — a local name
 * of `a__b` and the alias `b` of local name `a` both render
 * `takosumi_runtime_inputs__a__b`. That is refused outright: one ephemeral
 * variable can only carry one provider instance's map.
 */
function runtimeInputVariableDeclarations(
  providerBindings: ReadonlyArray<RootProviderBinding>,
): readonly RuntimeInputVariableDeclaration[] {
  const byVariableName = new Map<
    string,
    { readonly identity: string; readonly runtimeInputs: RootProviderRuntimeInputs }
  >();
  for (const binding of providerBindings) {
    const runtimeInputs = binding.runtimeInputs;
    if (!runtimeInputs) continue;
    assertRuntimeInputs(binding, runtimeInputs);
    const variableName = rootRuntimeInputsVariableName(binding);
    const identity = JSON.stringify([
      binding.moduleLocalName,
      binding.rootAlias ?? null,
    ]);
    const existing = byVariableName.get(variableName);
    if (
      existing &&
      (existing.identity !== identity ||
        existing.runtimeInputs.nonce !== runtimeInputs.nonce ||
        existing.runtimeInputs.nonceArgument !== runtimeInputs.nonceArgument ||
        existing.runtimeInputs.mapArgument !== runtimeInputs.mapArgument)
    ) {
      throw new RootgenValidationError(
        "rootgen_runtime_input_argument_conflict",
        `rootgen: conflicting run-scoped sensitive input wiring for ${variableName}`,
      );
    }
    byVariableName.set(variableName, { identity, runtimeInputs });
  }
  return Array.from(byVariableName.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([variableName, entry]) => ({
      variableName,
      runtimeInputs: entry.runtimeInputs,
    }));
}

function assertRuntimeInputs(
  binding: RootProviderBinding,
  runtimeInputs: RootProviderRuntimeInputs,
): void {
  if (!isCanonicalRuntimeInputNonce(runtimeInputs.nonce)) {
    throw new RootgenValidationError(
      "rootgen_runtime_input_nonce_invalid",
      "rootgen: run-scoped sensitive input nonce must be 22..128 canonical unpadded base64url characters decoding to at least 16 bytes",
    );
  }
  for (const name of [runtimeInputs.nonceArgument, runtimeInputs.mapArgument]) {
    if (!isOpenTofuIdentifier(name) || name === "alias") {
      throw new RootgenValidationError(
        "rootgen_runtime_input_argument_invalid",
        "rootgen: run-scoped sensitive input argument must be a provider-block identifier other than alias",
      );
    }
  }
  if (runtimeInputs.nonceArgument === runtimeInputs.mapArgument) {
    throw new RootgenValidationError(
      "rootgen_runtime_input_argument_conflict",
      "rootgen: run-scoped sensitive input nonce and map arguments must differ",
    );
  }
  const configuration = binding.configuration ?? {};
  for (const name of [runtimeInputs.nonceArgument, runtimeInputs.mapArgument]) {
    if (Object.hasOwn(configuration, name)) {
      throw new RootgenValidationError(
        "rootgen_runtime_input_argument_conflict",
        `rootgen: provider configuration cannot also set run-scoped sensitive input argument ${name}`,
      );
    }
  }
}

const RUNTIME_INPUT_VARIABLES_COMMENT = [
  "# Generated by Takosumi rootgen.",
  "# Apply-only sensitive provider inputs. The runner supplies these as",
  "# ephemeral variables; values never enter this file, the plan, or state.",
  "# They carry no default on purpose: OpenTofu then enforces that a variable",
  "# set at plan is SET again at apply, so a dropped map fails the run. It does",
  "# not enforce the contents — an apply may supply a narrower map than the",
  "# plan did — so the provider's own exact name-set check is what fences the",
  "# values themselves.",
].join("\n");

function renderRuntimeInputVariablesTf(
  declarations: readonly RuntimeInputVariableDeclaration[],
): string {
  const blocks = declarations.map((declaration) =>
    [
      `variable ${hclString(declaration.variableName)} {`,
      "  type      = map(string)",
      "  sensitive = true",
      "  ephemeral = true",
      "}",
    ].join("\n"),
  );
  return `${[RUNTIME_INPUT_VARIABLES_COMMENT, ...blocks].join("\n\n")}\n`;
}

function renderProviderVersionsTf(
  providers: readonly RootProviderRequirement[],
): string {
  if (providers.length === 0) {
    return ["terraform {}", ""].join("\n");
  }
  const byLocalName = new Map<
    string,
    { readonly source: string; readonly version?: string }
  >();
  for (const requirement of providers) {
    assertIdentifier(
      requirement.moduleLocalName,
      "rootgen: provider local name",
    );
    const source = normalizeProviderSource(requirement.source);
    const existing = byLocalName.get(requirement.moduleLocalName);
    if (existing && existing.source !== source) {
      throw new RootgenValidationError(
        "rootgen_conflicting_provider_local_names",
        `rootgen: provider local name ${requirement.moduleLocalName} maps to both ${existing.source} and ${source}`,
      );
    }
    const version = requirement.version ?? existing?.version;
    byLocalName.set(requirement.moduleLocalName, {
      source,
      ...(version === undefined ? {} : { version }),
    });
  }
  const entries = Array.from(byLocalName.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([localName, requirement]) => {
      const lines = [
        `    ${localName} = {`,
        `      source = ${hclString(requirement.source)}`,
        ...(requirement.version === undefined
          ? []
          : [`      version = ${hclString(`= ${requirement.version}`)}`]),
        `    }`,
      ];
      return lines.join("\n");
    });
  return [
    "terraform {",
    "  required_providers {",
    ...entries,
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Comment header for a provider-bound generated root. Credential material is
 * delivered by CredentialRecipe env/file injection and is never rendered here.
 */
const PROVIDER_BINDINGS_COMMENT = [
  "# Generated by Takosumi rootgen.",
  "# Provider blocks contain only explicit non-secret providerConfig values.",
  "# CredentialRecipe material reaches OpenTofu through run-scoped env/files.",
].join("\n");

function appendProviderSections(
  sections: string[],
  providerBindings: ReadonlyArray<RootProviderBinding>,
): void {
  // Provider blocks contain only explicit non-secret configuration.
  if (providerBindings.length > 0) {
    sections.push(PROVIDER_BINDINGS_COMMENT);
    for (const binding of providerBindings) {
      const localProvider = bindingLocalName(binding);
      const aliasLines = [`provider ${hclString(localProvider)} {`];
      const rootAlias = binding.rootAlias;
      if (rootAlias) {
        assertIdentifier(rootAlias, "rootgen: root provider alias");
        aliasLines.push(`  alias = ${hclString(rootAlias)}`);
      }
      for (const [name, value] of Object.entries(
        binding.configuration ?? {},
      ).sort(([left], [right]) => left.localeCompare(right))) {
        assertIdentifier(name, "rootgen: provider configuration argument");
        if (name === "alias") {
          throw new RootgenValidationError(
            "rootgen_provider_configuration_alias_override",
            `rootgen: provider configuration cannot override ${name}`,
          );
        }
        aliasLines.push(`  ${name} = ${hclJsonLiteral(value)}`);
      }
      const runtimeInputs = binding.runtimeInputs;
      if (runtimeInputs) {
        assertRuntimeInputs(binding, runtimeInputs);
        // The nonce is a non-secret, plan-stable identifier. The map is a bare
        // variable reference: rendering a literal here would put the values in
        // the generated root, the plan, and state.
        aliasLines.push(
          `  ${runtimeInputs.nonceArgument} = ${hclString(runtimeInputs.nonce)}`,
        );
        aliasLines.push(
          `  ${runtimeInputs.mapArgument} = var.${rootRuntimeInputsVariableName(binding)}`,
        );
      }
      aliasLines.push("}");
      sections.push(aliasLines.join("\n"));
    }
  }
}

function renderGenericMainTf(
  inputs: Readonly<Record<string, JsonValue>>,
  providerBindings: ReadonlyArray<RootProviderBinding>,
  rootProviderRequirements: readonly RootProviderRequirement[],
): string {
  const sections: string[] = [
    [
      "# Pre-v1 generated roots used the app-specific module label.",
      "# Keep this state migration declarative and independent of module type.",
      "moved {",
      "  from = module.app",
      "  to   = module.child",
      "}",
    ].join("\n"),
  ];
  appendProviderSections(sections, providerBindings);

  const moduleLines = [
    'module "child" {',
    `  source = ${hclString(CHILD_MODULE_SOURCE)}`,
  ];
  appendProviderMap(moduleLines, providerBindings, rootProviderRequirements);
  for (const name of Object.keys(inputs).sort()) {
    assertIdentifier(name, "rootgen: input name");
    moduleLines.push(`  ${name} = ${hclJsonLiteral(inputs[name]!)}`);
  }
  moduleLines.push("}", "");
  sections.push(moduleLines.join("\n"));
  return sections.join("\n\n");
}

function appendProviderMap(
  moduleLines: string[],
  providerBindings: ReadonlyArray<RootProviderBinding>,
  rootProviderRequirements: readonly RootProviderRequirement[],
): void {
  const entries = providerMapEntries(
    providerBindings,
    rootProviderRequirements,
  );
  if (entries.length === 0) return;
  moduleLines.push("", "  providers = {");
  for (const entry of entries) {
    moduleLines.push(`    ${entry.childRef} = ${entry.rootRef}`);
  }
  moduleLines.push("  }", "");
}

interface ProviderMapEntry {
  readonly childRef: string;
  readonly rootRef: string;
}

function providerMapEntries(
  providerBindings: ReadonlyArray<RootProviderBinding>,
  rootProviderRequirements: readonly RootProviderRequirement[],
): ProviderMapEntry[] {
  const byLocalProvider = new Map<string, RootProviderBinding[]>();
  for (const binding of providerBindings) {
    const localProvider = bindingLocalName(binding);
    byLocalProvider.set(localProvider, [
      ...(byLocalProvider.get(localProvider) ?? []),
      binding,
    ]);
  }
  const requirementsByChildRef = new Map<
    string,
    RootProviderRequirement
  >();
  const byChildRef = new Map<string, ProviderMapEntry>();
  const explicitRootRefByChildRef = new Map<string, string>();
  for (const requirement of rootProviderRequirements) {
    assertIdentifier(
      requirement.moduleLocalName,
      "rootgen: provider local name",
    );
    const childRef = childProviderRef(
      requirement.moduleLocalName,
      requirement.childAlias,
    );
    const normalized = normalizeProviderSource(requirement.source);
    const existing = requirementsByChildRef.get(childRef);
    if (
      existing &&
      normalizeProviderSource(existing.source) !== normalized
    ) {
      throw new RootgenValidationError(
        "rootgen_conflicting_provider_local_names",
        `rootgen: provider reference ${childRef} maps to both ${normalizeProviderSource(existing.source)} and ${normalized}`,
      );
    }
    requirementsByChildRef.set(childRef, requirement);
    byChildRef.set(childRef, {
      childRef,
      rootRef: requirement.moduleLocalName,
    });
  }
  for (const [localProvider, bindings] of byLocalProvider) {
    for (const binding of bindings) {
      const childRef = childProviderRef(localProvider, binding.childAlias);
      const requirement = requirementsByChildRef.get(childRef);
      if (
        !requirement ||
        normalizeProviderSource(requirement.source) !==
          normalizeProviderSource(binding.provider)
      ) {
        throw new RootgenValidationError(
          "rootgen_provider_binding_outside_root_requirements",
          `rootgen: provider binding ${childRef} is not an exact selected-root provider requirement`,
        );
      }
      const rootRef = rootProviderRef(localProvider, binding.rootAlias);
      const existingRootRef = explicitRootRefByChildRef.get(childRef);
      if (existingRootRef !== undefined && existingRootRef !== rootRef) {
        throw new RootgenValidationError(
          "rootgen_conflicting_provider_bindings",
          `rootgen: conflicting provider bindings for ${childRef}`,
        );
      }
      explicitRootRefByChildRef.set(childRef, rootRef);
      byChildRef.set(childRef, {
        childRef,
        rootRef,
      });
    }
  }
  return Array.from(byChildRef.values()).sort((left, right) =>
    left.childRef.localeCompare(right.childRef),
  );
}

function bindingLocalName(binding: RootProviderBinding): string {
  const localName = binding.moduleLocalName;
  assertIdentifier(localName, "rootgen: provider local name");
  return localName;
}

function childProviderRef(
  localProvider: string,
  alias: string | undefined,
): string {
  if (!alias) return localProvider;
  assertIdentifier(alias, "rootgen: provider alias");
  return `${localProvider}.${alias}`;
}

function rootProviderRef(
  localProvider: string,
  alias: string | undefined,
): string {
  if (!alias) return localProvider;
  assertIdentifier(alias, "rootgen: provider alias");
  return `${localProvider}.${alias}`;
}

function renderGenericOutputsTf(
  outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>,
): string {
  const blocks = Object.entries(outputAllowlist).map(([name, spec]) => {
    assertIdentifier(name, "rootgen: output name");
    assertOutputPath(spec.from);
    return [
      `output ${hclString(name)} {`,
      `  value = module.child.${spec.from}`,
      ...(spec.sensitive === true ? ["  sensitive = true"] : []),
      "}",
    ].join("\n");
  });
  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

function assertIdentifier(value: string, label: string): void {
  if (!isOpenTofuIdentifier(value)) {
    throw new RootgenValidationError(
      "rootgen_invalid_identifier",
      `${label} must be a valid OpenTofu identifier`,
    );
  }
}

function assertOutputPath(value: string): void {
  for (const part of value.split(".")) {
    assertIdentifier(part, "rootgen: output allowlist path");
  }
}

/**
 * Normalizes only an explicit provider source address. A two-segment
 * namespace/type source receives the OpenTofu default registry hostname; a
 * custom registry hostname is preserved. Bare provider names are ambiguous and
 * fail closed instead of selecting a vendor source from a built-in table.
 */
function normalizeProviderSource(rule: string): string {
  const normalized = rule.trim();
  if (!normalized.includes("/")) {
    throw new RootgenValidationError(
      "rootgen_explicit_provider_source_required",
      `rootgen: provider ${normalized} must declare an explicit namespace/type or hostname/namespace/type source`,
    );
  }
  return canonicalProviderSource(normalized);
}

function hclJsonLiteral(value: JsonValue): string {
  switch (typeof value) {
    case "string":
      return hclString(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new RootgenValidationError(
          "rootgen_non_finite_number_input",
          "rootgen: number input must be finite",
        );
      }
      return String(value);
    case "boolean":
      return value ? "true" : "false";
    case "object":
      if (value === null) return "null";
      return `jsondecode(${hclString(JSON.stringify(value))})`;
    default:
      throw new RootgenValidationError(
        "rootgen_unsupported_json_input",
        "rootgen: unsupported JSON input literal",
      );
  }
}

/**
 * Renders an HCL double-quoted string with the escapes the HCL grammar requires.
 * Critically escapes `\`, `"`, `${` and `%{` so an input value can never break
 * out of the quotes or open an interpolation / template directive.
 */
export function hclString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // Neutralize interpolation / template-directive openers: HCL escapes a
    // literal `${` as `$${` and `%{` as `%%{`. Use function replacements so the
    // `$` in the replacement string is never reinterpreted.
    .replace(/\$\{/g, () => "$${")
    .replace(/%\{/g, () => "%%{")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}
