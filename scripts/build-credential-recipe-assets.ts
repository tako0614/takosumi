import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { isCredentialRecipeRenewableEnv } from "../contract/credential-recipes.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const recipeDir = join(root, "recipes/providers");
const outputPath = join(root, "providers/credential-recipes.generated.ts");

interface ParsedRecipe {
  readonly id: string;
  readonly display_name: string;
  readonly secret_partition?: string;
  readonly terraform_source: readonly string[] | "*";
  readonly env_names?: readonly string[];
  readonly required_env_groups?: readonly (readonly string[])[];
  readonly declared_env?: boolean;
  readonly renewable_env_capability?: ParsedRenewableEnvCapability;
  readonly auth_modes: Readonly<Record<string, ParsedAuthMode>>;
}

interface ParsedRenewableEnvCapability {
  readonly source_env_name: string;
  readonly file_env_name: string;
  readonly minimum_provider_version: string;
}

interface ParsedAuthMode {
  readonly env?: Readonly<Record<string, ParsedMaterial>>;
  readonly files?: Readonly<Record<string, ParsedFileMaterial>>;
  readonly pre_run?: ParsedPreRunAction;
  readonly runtime_inputs?: ParsedRuntimeInputs;
  readonly input_hints?: Readonly<Record<string, ParsedInputHint>>;
  readonly presentation?: ParsedAuthModePresentation;
}

/**
 * Value-free protocol shape: the two provider-block argument names a provider
 * reads for run-scoped sensitive inputs. It never declares a value source.
 */
interface ParsedRuntimeInputs {
  readonly contract: string;
  readonly nonce_argument: string;
  readonly map_argument: string;
  readonly minimum_provider_version: string;
}

type ParsedPresentationText = string | Readonly<Record<string, string>>;

interface ParsedInputHint {
  readonly label?: ParsedPresentationText;
  readonly placeholder?: ParsedPresentationText;
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly hidden?: boolean;
}

interface ParsedAuthModePresentation {
  readonly show_in_connection_setup?: boolean;
  readonly display_name?: ParsedPresentationText;
  readonly description?: ParsedPresentationText;
  readonly setup_guide?: {
    readonly url: string;
    readonly steps?: readonly ParsedPresentationText[];
  };
}

interface ParsedMaterial {
  readonly from: string;
  readonly name?: string;
  readonly value?: string;
}

interface ParsedFileMaterial extends ParsedMaterial {
  readonly env_name?: string;
  readonly mode?: number;
}

interface ParsedPreRunAction {
  readonly type: string;
  readonly inputs?: Readonly<Record<string, ParsedMaterial>>;
}

const names = (await readdir(recipeDir))
  .filter((name) => name.endsWith(".yaml"))
  .sort();
const recipes = [];
const renewableEnvCapabilities = [];
for (const name of names) {
  const parsed = parse(
    await readFile(join(recipeDir, name), "utf8"),
  ) as ParsedRecipe;
  if (!parsed || typeof parsed.id !== "string") {
    throw new TypeError(`credential recipe ${name} has no id`);
  }
  if (parsed.renewable_env_capability !== undefined) {
    const capability = parsed.renewable_env_capability;
    const renewableEnv = {
      sourceEnvName: capability.source_env_name,
      fileEnvName: capability.file_env_name,
      minimumProviderVersion: capability.minimum_provider_version,
    };
    if (
      Object.keys(capability).sort().join(",") !==
        "file_env_name,minimum_provider_version,source_env_name" ||
      !Array.isArray(parsed.terraform_source) ||
      !isCredentialRecipeRenewableEnv(renewableEnv)
    ) {
      throw new TypeError(
        `credential recipe ${name} has an invalid renewable_env_capability`,
      );
    }
    const declaredEnvNames = new Set(parsed.env_names ?? []);
    if (
      !declaredEnvNames.has(renewableEnv.sourceEnvName) ||
      declaredEnvNames.has(renewableEnv.fileEnvName)
    ) {
      throw new TypeError(
        `credential recipe ${name} has an incompatible renewable_env_capability`,
      );
    }
    renewableEnvCapabilities.push({
      terraformSource: parsed.terraform_source,
      renewableEnv,
    });
  }
  recipes.push({
    id: parsed.id,
    displayName: parsed.display_name,
    ...(parsed.secret_partition
      ? { secretPartition: parsed.secret_partition }
      : {}),
    terraformSource: parsed.terraform_source,
    ...(parsed.env_names ? { envNames: parsed.env_names } : {}),
    ...(parsed.required_env_groups
      ? { requiredEnvGroups: parsed.required_env_groups }
      : {}),
    ...(parsed.declared_env ? { declaredEnv: true } : {}),
    authModes: Object.fromEntries(
      Object.entries(parsed.auth_modes ?? {}).map(([id, mode]) => [
        id,
        {
          ...(mode.env ? { env: mode.env } : {}),
          ...(mode.files
            ? {
                files: Object.fromEntries(
                  Object.entries(mode.files).map(([path, material]) => [
                    path,
                    {
                      from: material.from,
                      ...(material.name ? { name: material.name } : {}),
                      ...(material.value ? { value: material.value } : {}),
                      ...(material.env_name
                        ? { envName: material.env_name }
                        : {}),
                      ...(material.mode !== undefined
                        ? { mode: material.mode }
                        : {}),
                    },
                  ]),
                ),
              }
            : {}),
          ...(mode.pre_run
            ? {
                preRun: {
                  type: mode.pre_run.type,
                  ...(mode.pre_run.inputs
                    ? { inputs: mode.pre_run.inputs }
                    : {}),
                },
              }
            : {}),
          ...(mode.runtime_inputs
            ? {
                runtimeInputs: {
                  contract: mode.runtime_inputs.contract,
                  nonceArgument: mode.runtime_inputs.nonce_argument,
                  mapArgument: mode.runtime_inputs.map_argument,
                  minimumProviderVersion:
                    mode.runtime_inputs.minimum_provider_version,
                },
              }
            : {}),
          ...(mode.input_hints ? { inputHints: mode.input_hints } : {}),
          ...(mode.presentation
            ? {
                presentation: {
                  ...(mode.presentation.show_in_connection_setup !== undefined
                    ? {
                        showInConnectionSetup:
                          mode.presentation.show_in_connection_setup,
                      }
                    : {}),
                  ...(mode.presentation.display_name !== undefined
                    ? { displayName: mode.presentation.display_name }
                    : {}),
                  ...(mode.presentation.description !== undefined
                    ? { description: mode.presentation.description }
                    : {}),
                  ...(mode.presentation.setup_guide
                    ? {
                        setupGuide: {
                          url: mode.presentation.setup_guide.url,
                          ...(mode.presentation.setup_guide.steps
                            ? { steps: mode.presentation.setup_guide.steps }
                            : {}),
                        },
                      }
                    : {}),
                },
              }
            : {}),
        },
      ]),
    ),
  });
}

const generated =
  `// Generated by scripts/build-credential-recipe-assets.ts. Do not edit.\n` +
  `import type { CredentialRecipe, CredentialRecipeRenewableEnv } from "../contract/credential-recipes.ts";\n\n` +
  `export const REFERENCE_CREDENTIAL_RECIPES: readonly CredentialRecipe[] = ` +
  `${JSON.stringify(recipes, null, 2)};\n\n` +
  `export type ReferenceProviderRenewableEnvCapability = Readonly<{\n` +
  `  terraformSource: readonly string[];\n` +
  `  renewableEnv: CredentialRecipeRenewableEnv;\n` +
  `}>;\n\n` +
  `export const REFERENCE_PROVIDER_RENEWABLE_ENV_CAPABILITIES: readonly ReferenceProviderRenewableEnvCapability[] = ` +
  `${JSON.stringify(renewableEnvCapabilities, null, 2)};\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== generated) {
    throw new Error(
      `${relative(root, outputPath)} is stale; run bun scripts/build-credential-recipe-assets.ts`,
    );
  }
} else {
  await writeFile(outputPath, generated);
}
