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
 */

import type {
  DispatchGeneratedRoot,
  TemplateDefinition,
} from "takosumi-contract/deploy-control-api";
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
