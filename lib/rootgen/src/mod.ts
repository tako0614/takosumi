/**
 * Root-module generation (rootgen).
 *
 * Generates the optional child-module wrapper used when explicit provider
 * alias/configuration or an operator-owned Resource module requires a generated
 * root. Ordinary Git OpenTofu modules do not pass through rootgen.
 *
 * Generated files:
 *   - versions.tf : `terraform { required_providers { ... } }` from the exact
 *                   child-module requirements, without inferred version pins.
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
import { canonicalProviderSource } from "takosumi-contract/provider-env-rules";

const CHILD_MODULE_SOURCE = "./module";

/** Public validation code translated by Core at the rootgen call boundary. */
export const ROOTGEN_VALIDATION_ERROR_CODE = "invalid_argument" as const;

export const ROOTGEN_VALIDATION_ERROR_REASONS = [
  "rootgen_invalid_identifier",
  "rootgen_provider_configuration_alias_override",
  "rootgen_conflicting_provider_bindings",
  "rootgen_conflicting_provider_local_names",
  "rootgen_invalid_provider_local_name",
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
  readonly moduleLocalName?: string;
  /** Alias expected by the child module; absent means its default provider. */
  readonly childAlias?: string;
  /** Alias of the root provider block; absent means its default provider. */
  readonly rootAlias?: string;
  /**
   * @deprecated Ambiguous pre-v1 root alias. New callers must provide the
   * independent child/root identity fields above.
   */
  readonly alias?: string;
  /** Non-secret provider-block arguments rendered as escaped HCL literals. */
  readonly configuration?: Readonly<Record<string, JsonValue>>;
}

export interface RootProviderRequirement {
  /** Explicit provider source (`namespace/type` or `hostname/namespace/type`). */
  readonly provider: string;
  /** Exact local name declared in the child module. */
  readonly localName: string;
}

export interface GenerateOpenTofuChildModuleRootInput {
  readonly requiredProviders: readonly string[];
  /**
   * Identity-preserving provider requirements discovered from the child
   * module. Older callers may omit this and use the source-tail fallback.
   */
  readonly providerRequirements?: readonly RootProviderRequirement[];
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
  const providerBindings = input.providerBindings ?? [];
  const providerRequirements =
    input.providerRequirements ??
    input.requiredProviders.map((provider) => ({
      provider,
      localName: providerLocalName(provider),
    }));
  return {
    files: {
      "versions.tf": renderProviderVersionsTf(providerRequirements),
      "main.tf": renderGenericMainTf(
        input.inputs,
        providerBindings,
        providerRequirements,
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
  const byLocalName = new Map<string, string>();
  for (const requirement of providers) {
    assertIdentifier(requirement.localName, "rootgen: provider local name");
    const source = normalizeProviderSource(requirement.provider);
    const existing = byLocalName.get(requirement.localName);
    if (existing && existing !== source) {
      throw new RootgenValidationError(
        "rootgen_conflicting_provider_local_names",
        `rootgen: provider local name ${requirement.localName} maps to both ${existing} and ${source}`,
      );
    }
    byLocalName.set(requirement.localName, source);
  }
  const entries = Array.from(byLocalName.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([localName, source]) => {
      const lines = [
        `    ${localName} = {`,
        `      source = ${hclString(source)}`,
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
      const rootAlias = bindingRootAlias(binding);
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
  providerRequirements: readonly RootProviderRequirement[],
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
  appendProviderMap(moduleLines, providerBindings, providerRequirements);
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
  providerRequirements: readonly RootProviderRequirement[],
): void {
  const entries = providerMapEntries(providerBindings, providerRequirements);
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
  providerRequirements: readonly RootProviderRequirement[],
): ProviderMapEntry[] {
  const byLocalProvider = new Map<string, RootProviderBinding[]>();
  for (const binding of providerBindings) {
    const localProvider = bindingLocalName(binding);
    byLocalProvider.set(localProvider, [
      ...(byLocalProvider.get(localProvider) ?? []),
      binding,
    ]);
  }
  const explicitByChildRef = new Map<string, ProviderMapEntry>();
  for (const [localProvider, bindings] of byLocalProvider) {
    // Compatibility only for pre-v1 bindings whose one `alias` field could not
    // distinguish a root alias from a child alias. New bindings never take this
    // path.
    const singleAliasDefault =
      bindings.length === 1 &&
      bindings[0]?.alias !== undefined &&
      !hasExplicitProviderIdentity(bindings[0]);
    for (const binding of bindings) {
      const childRef = singleAliasDefault
        ? localProvider
        : childProviderRef(localProvider, bindingChildAlias(binding));
      const rootRef = rootProviderRef(localProvider, bindingRootAlias(binding));
      const existing = explicitByChildRef.get(childRef);
      if (existing) {
        if (existing.rootRef === rootRef) continue;
        throw new RootgenValidationError(
          "rootgen_conflicting_provider_bindings",
          `rootgen: conflicting provider bindings for ${childRef}`,
        );
      }
      explicitByChildRef.set(childRef, {
        childRef,
        rootRef,
      });
    }
  }
  const byChildRef = new Map<string, ProviderMapEntry>();
  for (const requirement of providerRequirements) {
    assertIdentifier(requirement.localName, "rootgen: provider local name");
    byChildRef.set(requirement.localName, {
      childRef: requirement.localName,
      rootRef: requirement.localName,
    });
  }
  for (const entry of explicitByChildRef.values()) {
    byChildRef.set(entry.childRef, entry);
  }
  return Array.from(byChildRef.values()).sort((left, right) =>
    left.childRef.localeCompare(right.childRef),
  );
}

function hasExplicitProviderIdentity(binding: RootProviderBinding): boolean {
  return (
    binding.moduleLocalName !== undefined ||
    binding.childAlias !== undefined ||
    binding.rootAlias !== undefined
  );
}

function bindingLocalName(binding: RootProviderBinding): string {
  const localName =
    binding.moduleLocalName ?? providerLocalName(binding.provider);
  assertIdentifier(localName, "rootgen: provider local name");
  return localName;
}

function bindingChildAlias(binding: RootProviderBinding): string | undefined {
  return (
    binding.childAlias ??
    (hasExplicitProviderIdentity(binding) ? undefined : binding.alias)
  );
}

function bindingRootAlias(binding: RootProviderBinding): string | undefined {
  return binding.rootAlias ?? binding.alias;
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
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
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
 * OpenTofu local provider name used inside required_providers / module
 * references. OpenTofu defines this as the type segment of an explicit source.
 */
function providerLocalName(rule: string): string {
  const parts = rule.split("/");
  const type = parts[parts.length - 1] ?? rule;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(type)) {
    throw new RootgenValidationError(
      "rootgen_invalid_provider_local_name",
      `rootgen: provider rule ${rule} has no valid local name`,
    );
  }
  return type;
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
