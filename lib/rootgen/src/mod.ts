/**
 * Root-module generation (rootgen).
 *
 * Given an InstallConfig-backed Capsule definition and its validated literal
 * inputs, generate the Takosumi OpenTofu root module that wires the child
 * module + inputs and re-exports its public outputs. The output is `{ files }`
 * per the dispatch contract: the runner writes these into
 * `/work/generated-root`, materializes the child module at
 * `/work/generated-root/template-module`, then runs `tofu` in
 * `/work/generated-root` (the generated root references `./template-module`).
 *
 * Generated files:
 *   - versions.tf : `terraform { required_providers { ... } }` from
 *                   policy.allowedProviders, with sensible v5-era version pins.
 *   - main.tf     : `module "app" { source = "./template-module"; <inputs> }`.
 *   - outputs.tf  : passthrough of template.outputs.public:
 *                   `output "<public>" { value = module.app.<from> }`.
 *                   Generic Capsule roots also pass through Takosumi control
 *                   outputs used by post-apply release activation; those are
 *                   later filtered out of the public deployment projection.
 *
 * Inputs are emitted as literal HCL values (string/number/bool); strings are
 * escaped so a value can never break out of its quotes or inject HCL.
 *
 * `generateInstallationRoot` is the installType-aware entry point. It emits the
 * same three files plus, when the Installation declares provider bindings,
 * provider blocks + a `providers = { ... }` module map; and for `app_source` it
 * threads a generated `artifact_path` variable. Per-connection credential split:
 * a provider with an arg mapping gets one `variable "<provider>_<alias>_<arg>"`
 * { sensitive = true, ephemeral = true }` per credential arg, and its provider
 * block sets that provider argument from the variable. The Vault mints the
 * matching `TF_VAR_<provider>_<alias>_<arg>` env per resolved Connection. A
 * provider WITHOUT an arg mapping keeps a credential-free block. Generic-env
 * Provider Connections are delivered as runner process env, not generated-root
 * variables.
 */

import type {
  DispatchGeneratedRoot,
  TemplateDefinition,
} from "@takosumi/internal/deploy-control-api";
import type { JsonValue } from "takosumi-contract";
import type { OutputAllowlistEntry } from "takosumi-contract/installations";
import {
  providerCredentialArgs,
  providerEnvRule,
} from "takosumi-contract/provider-env-rules";
import type { TemplateInputValue } from "../../../core/domains/templates/mod.ts";
import { OpenTofuControllerError } from "../../../core/domains/deploy-control/errors.ts";

const TEMPLATE_MODULE_SOURCE = "./template-module";

/**
 * Default provider version pins keyed by the trailing `<namespace>/<type>` of a
 * provider rule. Pinned to the v5-era cloudflare provider used by the
 * first-party cloudflare modules. Unknown providers get no version
 * constraint (still listed in required_providers by source).
 */
const PROVIDER_SOURCE_BY_RULE: Readonly<Record<string, string>> = {
  "cloudflare/cloudflare": "cloudflare/cloudflare",
  "hashicorp/aws": "hashicorp/aws",
  "hashicorp/google": "hashicorp/google",
};

const PROVIDER_VERSION_BY_RULE: Readonly<Record<string, string>> = {
  "cloudflare/cloudflare": "~> 5.0",
  "hashicorp/aws": "~> 5.0",
  "hashicorp/google": "~> 6.0",
};

export interface GeneratedRootModule extends DispatchGeneratedRoot {
  readonly files: Readonly<Record<string, string>>;
}

/**
 * §13 install types that drive a Takosumi-generated root module. `opentofu_root`
 * is intentionally absent: it is a legacy direct-root ledger compatibility value,
 * and Takosumi v1 plan creation fails closed before dispatch for those rows.
 */
export type GeneratedRootInstallType =
  | "core"
  | "opentofu_module"
  | "app_source";

/** One OpenTofu provider binding emitted into the generated root. */
export interface RootInstallationProviderEnvBinding {
  /** Provider rule, short (`cloudflare`) or registry form (`cloudflare/cloudflare`). */
  readonly provider: string;
  /** Optional root provider alias selected by this Provider Binding. */
  readonly alias?: string;
  /**
   * How provider credential material reaches OpenTofu for this binding.
   *
   * `generated_root_variable` is the legacy root-only split for providers whose
   * credentials must be expressed as provider block arguments. `provider_env`
   * means credentials are already injected into the runner process env/file
   * material and the generated provider block must stay credential-free.
   */
  readonly credentialDelivery?: "provider_env" | "generated_root_variable";
  /**
   * Optional provider API base URL. The control plane sets this for a managed
   * (platform-hosted) cloudflare run so the provider talks to the Takosumi
   * Gateway provider endpoint (which lands worker scripts in the WfP dispatch namespace) instead
   * of api.cloudflare.com directly. Rendered as `base_url = "…"` in the provider
   * block. A capsule cannot override it: the generated root passes providers in,
   * so a capsule's own provider block fails tofu plan (fail-closed redirect).
   */
  readonly baseUrl?: string;
}

export interface GenerateInstallationRootInput {
  readonly template: TemplateDefinition;
  readonly inputs: Readonly<Record<string, TemplateInputValue>>;
  readonly installType: GeneratedRootInstallType;
  /**
   * Provider binding mapping. When non-empty, the generated root emits a
   * provider block per binding and a `providers = { ... }` map on the module
   * block. When empty/omitted the root is structurally identical to
   * {@link generateRootModule}.
   */
  readonly providerEnvBindings?: ReadonlyArray<RootInstallationProviderEnvBinding>;
}

export interface GenerateGenericCapsuleRootInput {
  readonly requiredProviders: readonly string[];
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly providerEnvBindings?: ReadonlyArray<RootInstallationProviderEnvBinding>;
}

/** Module input name an `app_source` template reads the built artifact path from. */
const ARTIFACT_PATH_INPUT = "artifact_path";
/** Path the runner copies the credential-free build artifact to (invariant 3). */
const ARTIFACT_PATH_VALUE = "/work/artifact";
const GENERIC_CONTROL_OUTPUTS = ["takosumi_release"] as const;

export function generateRootModule(
  template: TemplateDefinition,
  inputs: Readonly<Record<string, TemplateInputValue>>,
): GeneratedRootModule {
  return {
    files: {
      "versions.tf": renderVersionsTf(template),
      "main.tf": renderMainTf(template, inputs),
      "outputs.tf": renderOutputsTf(template),
    },
  };
}

/**
 * installType-aware §13 generated root.
 *
 * - `core` / `opentofu_module`: structurally identical wrappers — the core
 *   module is just value plumbing over the same template-module path.
 * - `app_source`: same wrap, plus a generated `variable "artifact_path"` (default
 *   `/work/artifact`) passed to the module as the `artifact_path` input when the
 *   template declares that input. The build phase produces the artifact in the
 *   Container with ZERO credentials (invariant 3); the deploy module consumes it.
 *
 * When `providerEnvBindings` is non-empty, provider blocks and a
 * `providers = { ... }` map are emitted.
 */
export function generateInstallationRoot(
  input: GenerateInstallationRootInput,
): GeneratedRootModule {
  const { template, inputs, installType } = input;
  const providerEnvBindings = input.providerEnvBindings ?? [];
  const wantsArtifact =
    installType === "app_source" && ARTIFACT_PATH_INPUT in template.inputs;
  return {
    files: {
      "versions.tf": renderVersionsTf(template),
      "main.tf": renderInstallationMainTf(
        template,
        inputs,
        providerEnvBindings,
        wantsArtifact,
      ),
      "outputs.tf": renderOutputsTf(template),
    },
  };
}

/**
 * Generic OpenTofu Capsule wrapper (§7): Takosumi owns the root module even
 * when the InstallConfig is not backed by a built-in first-party module. The runner
 * copies the normalized/user module to `./template-module`; this root wires
 * literal variable/dependency inputs, provider bindings, and
 * output allowlist passthroughs.
 */
export function generateGenericCapsuleRoot(
  input: GenerateGenericCapsuleRootInput,
): GeneratedRootModule {
  const providerEnvBindings = input.providerEnvBindings ?? [];
  return {
    files: {
      "versions.tf": renderProviderVersionsTf(input.requiredProviders),
      "main.tf": renderGenericMainTf(input.inputs, providerEnvBindings),
      "outputs.tf": renderGenericOutputsTf(input.outputAllowlist),
    },
  };
}

function renderVersionsTf(template: TemplateDefinition): string {
  return renderProviderVersionsTf(template.policy.allowedProviders);
}

function renderProviderVersionsTf(providers: readonly string[]): string {
  if (providers.length === 0) {
    return ["terraform {}", ""].join("\n");
  }
  const entries = providers.map((rule) => {
    const localName = providerLocalName(rule);
    const source =
      PROVIDER_SOURCE_BY_RULE[rule] ?? normalizeProviderSource(rule);
    const version = PROVIDER_VERSION_BY_RULE[rule];
    const lines = [
      `    ${localName} = {`,
      `      source = ${hclString(source)}`,
      ...(version ? [`      version = ${hclString(version)}`] : []),
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

function renderMainTf(
  template: TemplateDefinition,
  inputs: Readonly<Record<string, TemplateInputValue>>,
): string {
  const lines = [
    'module "app" {',
    `  source = ${hclString(TEMPLATE_MODULE_SOURCE)}`,
  ];
  // Emit inputs in the template's declared order for deterministic golden output.
  for (const name of Object.keys(template.inputs)) {
    if (!(name in inputs)) continue;
    lines.push(`  ${name} = ${hclLiteral(inputs[name]!)}`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

/**
 * Comment header for a provider-bound generated root. Per-connection credential
 * split is emitted as `var.<provider>_<alias>_<arg>` when an alias is present,
 * otherwise `var.<provider>_<arg>`.
 */
const PROVIDER_BINDINGS_COMMENT = [
  "# Generated by Takosumi rootgen.",
  "# Provider credentials are root-only: the generated root wires provider",
  "# blocks from sensitive variables minted by the Vault. Child modules",
  "# receive only provider configurations.",
].join("\n");

/**
 * The per-connection credential variable name for one provider arg:
 * `<localProvider>_<alias>_<arg>` or `<localProvider>_<arg>`.
 * Used as the rootgen `variable` name and as the `TF_VAR_…` env name the Vault
 * mints; the two MUST stay byte-identical.
 */
function aliasCredentialVarName(
  localProvider: string,
  alias: string | undefined,
  arg: string,
): string {
  return alias ? `${localProvider}_${alias}_${arg}` : `${localProvider}_${arg}`;
}

function renderInstallationMainTf(
  template: TemplateDefinition,
  inputs: Readonly<Record<string, TemplateInputValue>>,
  providerEnvBindings: ReadonlyArray<RootInstallationProviderEnvBinding>,
  wantsArtifact: boolean,
): string {
  const sections: string[] = [];

  appendProviderSections(sections, providerEnvBindings);

  // Generated artifact_path variable for app_source installs.
  if (wantsArtifact) {
    sections.push(
      [
        `variable ${hclString(ARTIFACT_PATH_INPUT)} {`,
        `  default = ${hclString(ARTIFACT_PATH_VALUE)}`,
        "}",
      ].join("\n"),
    );
  }

  const moduleLines = [
    'module "app" {',
    `  source = ${hclString(TEMPLATE_MODULE_SOURCE)}`,
  ];

  appendProviderMap(moduleLines, providerEnvBindings);

  // Emit inputs in the template's declared order for deterministic golden output.
  for (const name of Object.keys(template.inputs)) {
    if (name === ARTIFACT_PATH_INPUT && wantsArtifact) {
      // Wired from the generated variable, not from literal inputs.
      moduleLines.push(`  ${ARTIFACT_PATH_INPUT} = var.${ARTIFACT_PATH_INPUT}`);
      continue;
    }
    if (!(name in inputs)) continue;
    moduleLines.push(`  ${name} = ${hclLiteral(inputs[name]!)}`);
  }
  moduleLines.push("}", "");
  sections.push(moduleLines.join("\n"));

  return `${sections.join("\n\n")}`;
}

function appendProviderSections(
  sections: string[],
  providerEnvBindings: ReadonlyArray<RootInstallationProviderEnvBinding>,
): void {
  // Provider blocks. A provider WITH a credential arg mapping wires sensitive
  // root variables; a provider WITHOUT one keeps a credential-free block.
  if (providerEnvBindings.length > 0) {
    sections.push(PROVIDER_BINDINGS_COMMENT);
    // Sensitive credential variables come first (declared before the alias blocks
    // that consume them), in binding/arg order for deterministic golden output.
    for (const binding of providerEnvBindings) {
      if (!usesGeneratedRootCredentialVariables(binding)) continue;
      const localProvider = providerLocalName(binding.provider);
      for (const credArg of providerCredentialArgs(binding.provider)) {
        const varName = aliasCredentialVarName(
          localProvider,
          binding.alias,
          credArg.arg,
        );
        sections.push(
          [
            `variable ${hclString(varName)} {`,
            "  type      = string",
            "  sensitive = true",
            "  ephemeral = true",
            "}",
          ].join("\n"),
        );
      }
    }
    for (const binding of providerEnvBindings) {
      const localProvider = providerLocalName(binding.provider);
      const credArgs = usesGeneratedRootCredentialVariables(binding)
        ? providerCredentialArgs(binding.provider)
        : [];
      const aliasLines = [`provider ${hclString(localProvider)} {`];
      if (binding.alias) {
        aliasLines.push(`  alias = ${hclString(binding.alias)}`);
      }
      if (binding.baseUrl) {
        aliasLines.push(`  base_url = ${hclString(binding.baseUrl)}`);
      }
      for (const credArg of credArgs) {
        const varName = aliasCredentialVarName(
          localProvider,
          binding.alias,
          credArg.arg,
        );
        aliasLines.push(`  ${credArg.arg} = var.${varName}`);
      }
      aliasLines.push("}");
      sections.push(aliasLines.join("\n"));
    }
  }
}

function usesGeneratedRootCredentialVariables(
  binding: RootInstallationProviderEnvBinding,
): boolean {
  return binding.credentialDelivery !== "provider_env";
}

function renderOutputsTf(template: TemplateDefinition): string {
  const blocks = Object.entries(template.outputs.public).map(([name, spec]) => {
    return [
      `output ${hclString(name)} {`,
      `  value = module.app.${spec.from}`,
      "}",
    ].join("\n");
  });
  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

function renderGenericMainTf(
  inputs: Readonly<Record<string, JsonValue>>,
  providerEnvBindings: ReadonlyArray<RootInstallationProviderEnvBinding>,
): string {
  const sections: string[] = [];
  appendProviderSections(sections, providerEnvBindings);

  const moduleLines = [
    'module "app" {',
    `  source = ${hclString(TEMPLATE_MODULE_SOURCE)}`,
  ];
  appendProviderMap(moduleLines, providerEnvBindings);
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
  providerEnvBindings: ReadonlyArray<RootInstallationProviderEnvBinding>,
): void {
  const entries = providerMapEntries(providerEnvBindings);
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
  providerEnvBindings: ReadonlyArray<RootInstallationProviderEnvBinding>,
): ProviderMapEntry[] {
  const byLocalProvider = new Map<
    string,
    RootInstallationProviderEnvBinding[]
  >();
  for (const binding of providerEnvBindings) {
    const localProvider = providerLocalName(binding.provider);
    byLocalProvider.set(localProvider, [
      ...(byLocalProvider.get(localProvider) ?? []),
      binding,
    ]);
  }
  const byChildRef = new Map<string, ProviderMapEntry>();
  for (const [localProvider, bindings] of byLocalProvider) {
    const singleAliasDefault =
      bindings.length === 1 && bindings[0]?.alias !== undefined;
    for (const binding of bindings) {
      const childRef = singleAliasDefault
        ? localProvider
        : childProviderRef(localProvider, binding.alias);
      const rootRef = rootProviderRef(localProvider, binding.alias);
      const existing = byChildRef.get(childRef);
      if (existing) {
        if (existing.rootRef === rootRef) continue;
        throw new OpenTofuControllerError(
          "invalid_argument",
          `rootgen: conflicting provider bindings for ${childRef}`,
        );
      }
      byChildRef.set(childRef, {
        childRef,
        rootRef,
      });
    }
  }
  return Array.from(byChildRef.values());
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
      `  value = try(module.app.${spec.from}, "")`,
      "}",
    ].join("\n");
  });
  for (const name of GENERIC_CONTROL_OUTPUTS) {
    if (name in outputAllowlist) continue;
    blocks.push(
      [
        `output ${hclString(name)} {`,
        `  value = try(module.app.${name}, null)`,
        "}",
      ].join("\n"),
    );
  }
  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
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
 * Local provider name used inside required_providers / module references. The
 * trailing type segment of the rule (e.g. `cloudflare/cloudflare` -> `cloudflare`).
 */
function providerLocalName(rule: string): string {
  const providerRule = providerEnvRule(rule);
  if (providerRule) return providerRule.shortName;
  const parts = rule.split("/");
  const type = parts[parts.length - 1] ?? rule;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(type)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `rootgen: provider rule ${rule} has no valid local name`,
    );
  }
  return type;
}

/**
 * Normalizes a provider rule to a registry source string. A bare
 * `namespace/type` is used as-is; a full `registry/namespace/type` keeps its
 * trailing two segments (the OpenTofu source form).
 */
function normalizeProviderSource(rule: string): string {
  const parts = rule.split("/").filter((p) => p.length > 0);
  if (parts.length >= 2)
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return rule;
}

function hclLiteral(value: TemplateInputValue): string {
  switch (typeof value) {
    case "string":
      return hclString(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          "rootgen: number input must be finite",
        );
      }
      return String(value);
    case "boolean":
      return value ? "true" : "false";
    default:
      throw new OpenTofuControllerError(
        "invalid_argument",
        "rootgen: unsupported input literal",
      );
  }
}

function hclJsonLiteral(value: JsonValue): string {
  switch (typeof value) {
    case "string":
      return hclString(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new OpenTofuControllerError(
          "invalid_argument",
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
      throw new OpenTofuControllerError(
        "invalid_argument",
        "rootgen: unsupported JSON input literal",
      );
  }
}

/**
 * Renders an HCL double-quoted string with the escapes the HCL grammar requires.
 * Critically escapes `\`, `"`, `${` and `%{` so an input value can never break
 * out of the quotes or open an interpolation / template directive.
 */
function hclString(value: string): string {
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
