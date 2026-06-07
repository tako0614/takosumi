/**
 * Root-module generation (rootgen).
 *
 * Given an official template and its validated literal inputs, generate the
 * Takosumi OpenTofu root module that wires the template module + inputs and
 * re-exports its public outputs. The output is `{ files }` per the dispatch
 * contract: the runner writes these into `/work/generated-root` and copies the
 * template module to `/work/generated-root/template-module`, then runs `tofu`
 * in `/work/generated-root` (the generated root references `./template-module`).
 *
 * Generated files:
 *   - versions.tf : `terraform { required_providers { ... } }` from
 *                   policy.allowedProviders, with sensible v5-era version pins.
 *   - main.tf     : `module "app" { source = "./template-module"; <inputs> }`.
 *   - outputs.tf  : passthrough of template.outputs.public:
 *                   `output "<public>" { value = module.app.<from> }`.
 *
 * Inputs are emitted as literal HCL values (string/number/bool); strings are
 * escaped so a value can never break out of its quotes or inject HCL.
 *
 * `generateInstallationRoot` is the installType-aware §13 entry point. It emits
 * the same three files plus, when the InstallConfig declares per-capability
 * providers, provider alias blocks + a `providers = { ... }` module map; and for
 * `app_source` it threads a generated `artifact_path` variable. Per-alias
 * credential split (§13): a capability whose provider has an arg mapping (see
 * `PROVIDER_CREDENTIAL_ARG_MAP`) gets one `variable "<provider>_<capability>_<arg>"
 * { sensitive = true }` per credential arg, and its alias block sets that
 * provider argument from the variable (cloudflare: `api_token`; aws: access/secret
 * key + session token). The Vault mints the matching `TF_VAR_<provider>_<capability>_<arg>`
 * env per resolved Connection. A provider WITHOUT an arg mapping keeps the
 * credential-free alias and inherits its shared provider env credential.
 */

import type {
  DispatchGeneratedRoot,
  TemplateDefinition,
} from "takosumi-contract/deploy-control-api";
import { providerCredentialArgs } from "takosumi-contract/provider-env-rules";
import type { TemplateInputValue } from "../../../src/service/domains/templates/mod.ts";
import { OpenTofuControllerError } from "../../../src/service/domains/deploy-control/errors.ts";

const TEMPLATE_MODULE_SOURCE = "./template-module";

/**
 * Default provider version pins keyed by the trailing `<namespace>/<type>` of a
 * provider rule. Pinned to the v5-era cloudflare provider that the official
 * cloudflare templates were authored against. Unknown providers get no version
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
 * is intentionally absent: there the SourceSnapshot IS the root configuration,
 * so no root is generated (the raw-module plan path is used directly).
 */
export type GeneratedRootInstallType = "core" | "opentofu_module" | "app_source";

/** A capability mapped to the provider that satisfies it (§13). */
export type CapabilityKind =
  | "compute"
  | "dns"
  | "storage"
  | "database"
  | "secrets";

export interface CapabilityProvider {
  readonly capability: CapabilityKind;
  /** Provider rule, short (`cloudflare`) or registry form (`cloudflare/cloudflare`). */
  readonly provider: string;
}

export interface GenerateInstallationRootInput {
  readonly template: TemplateDefinition;
  readonly inputs: Readonly<Record<string, TemplateInputValue>>;
  readonly installType: GeneratedRootInstallType;
  /**
   * Per-capability provider mapping. When non-empty, the generated root emits a
   * provider alias block per capability and a `providers = { ... }` map on the
   * module block (§13). When empty/omitted the root is structurally identical to
   * {@link generateRootModule}.
   */
  readonly capabilityProviders?: ReadonlyArray<CapabilityProvider>;
}

/** Module input name an `app_source` template reads the built artifact path from. */
const ARTIFACT_PATH_INPUT = "artifact_path";
/** Path the runner copies the credential-free build artifact to (invariant 3). */
const ARTIFACT_PATH_VALUE = "/work/artifact";

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
 * When `capabilityProviders` is non-empty, per-capability provider alias blocks
 * and a `providers = { ... }` map are emitted per §13.
 */
export function generateInstallationRoot(
  input: GenerateInstallationRootInput,
): GeneratedRootModule {
  const { template, inputs, installType } = input;
  const capabilityProviders = input.capabilityProviders ?? [];
  const wantsArtifact =
    installType === "app_source" && ARTIFACT_PATH_INPUT in template.inputs;
  return {
    files: {
      "versions.tf": renderVersionsTf(template),
      "main.tf": renderInstallationMainTf(
        template,
        inputs,
        capabilityProviders,
        wantsArtifact,
      ),
      "outputs.tf": renderOutputsTf(template),
    },
  };
}

function renderVersionsTf(template: TemplateDefinition): string {
  const entries = template.policy.allowedProviders.map((rule) => {
    const localName = providerLocalName(rule);
    const source = PROVIDER_SOURCE_BY_RULE[rule] ?? normalizeProviderSource(rule);
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
 * Comment header for a capability-aliased generated root (§13). Per-alias
 * credential split is now emitted: a capability whose provider has an arg mapping
 * gets one sensitive `var.<provider>_<capability>_<arg>` per credential arg wired
 * into its alias block (the Vault mints the matching `TF_VAR_…` env per resolved
 * Connection); a provider without an arg mapping keeps a credential-free alias and
 * inherits its shared provider env credential.
 */
const CAPABILITY_SPLIT_COMMENT = [
  "# Generated by Takosumi rootgen (§13).",
  "# Per-alias credential split: a provider with a credential arg mapping wires",
  "# each alias from a sensitive var.<provider>_<capability>_<arg> (the Vault",
  "# mints the matching TF_VAR_<provider>_<capability>_<arg> per resolved",
  "# Connection); a provider without an arg mapping keeps a credential-free alias",
  "# inheriting its shared provider env credential.",
].join("\n");

/**
 * The §13 per-alias credential variable name for one provider arg:
 * `<localProvider>_<capability>_<arg>` (e.g. `cloudflare_compute_api_token`).
 * Used as the rootgen `variable` name and as the `TF_VAR_…` env name the Vault
 * mints; the two MUST stay byte-identical.
 */
function aliasCredentialVarName(
  localProvider: string,
  capability: string,
  arg: string,
): string {
  return `${localProvider}_${capability}_${arg}`;
}

function renderInstallationMainTf(
  template: TemplateDefinition,
  inputs: Readonly<Record<string, TemplateInputValue>>,
  capabilityProviders: ReadonlyArray<CapabilityProvider>,
  wantsArtifact: boolean,
): string {
  const sections: string[] = [];

  // Provider alias blocks (§13). A provider WITH a credential arg mapping wires
  // its alias from sensitive per-alias variables; a provider WITHOUT one keeps a
  // credential-free alias inheriting the shared provider env credential.
  if (capabilityProviders.length > 0) {
    sections.push(CAPABILITY_SPLIT_COMMENT);
    // Sensitive credential variables come first (declared before the alias blocks
    // that consume them), in capability/arg order for deterministic golden output.
    for (const cp of capabilityProviders) {
      const localProvider = providerLocalName(cp.provider);
      for (const credArg of providerCredentialArgs(cp.provider)) {
        const varName = aliasCredentialVarName(
          localProvider,
          cp.capability,
          credArg.arg,
        );
        sections.push(
          [
            `variable ${hclString(varName)} {`,
            "  type      = string",
            "  sensitive = true",
            "}",
          ].join("\n"),
        );
      }
    }
    for (const cp of capabilityProviders) {
      const localProvider = providerLocalName(cp.provider);
      const credArgs = providerCredentialArgs(cp.provider);
      const aliasLines = [
        `provider ${hclString(localProvider)} {`,
        `  alias = ${hclString(cp.capability)}`,
      ];
      for (const credArg of credArgs) {
        const varName = aliasCredentialVarName(
          localProvider,
          cp.capability,
          credArg.arg,
        );
        aliasLines.push(`  ${credArg.arg} = var.${varName}`);
      }
      aliasLines.push("}");
      sections.push(aliasLines.join("\n"));
    }
  }

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

  // providers = { <provider>.<capability> = <provider>.<capability>, ... } map.
  if (capabilityProviders.length > 0) {
    moduleLines.push("", "  providers = {");
    for (const cp of capabilityProviders) {
      const ref = `${providerLocalName(cp.provider)}.${cp.capability}`;
      moduleLines.push(`    ${ref} = ${ref}`);
    }
    moduleLines.push("  }", "");
  }

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

/**
 * Local provider name used inside required_providers / module references. The
 * trailing type segment of the rule (e.g. `cloudflare/cloudflare` -> `cloudflare`).
 */
function providerLocalName(rule: string): string {
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
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
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
