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
} from "takosumi-contract/provider-env-rules";

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
  return {
    files: {
      "versions.tf": renderProviderVersionsTf(rootProviderRequirements),
      "main.tf": renderGenericMainTf(
        input.inputs,
        providerBindings,
        rootProviderRequirements,
      ),
      "outputs.tf": renderGenericOutputsTf(input.outputAllowlist),
    },
  };
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
