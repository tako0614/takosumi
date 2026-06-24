import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parse } from "yaml";

import {
  allowedEnvNamesForProvider,
  isProviderEnvName,
  isReservedProviderEnvName,
  PROVIDER_CREDENTIAL_ENV_RULES,
  providerEnvRule,
  requiredEnvGroupsForProvider,
} from "../../contract/provider-env-rules.ts";
import { PROVIDER_RUNTIMES } from "../../providers/registry.ts";

const RECIPE_DIR = join(import.meta.dir, "../../recipes/providers");

interface ParsedRecipe {
  readonly id: string;
  readonly display_name?: string;
  readonly provider_rule?: string;
  readonly terraform_source?: readonly string[] | string;
  readonly env_names?: readonly string[];
  readonly required_env_groups?: readonly (readonly string[])[];
  readonly declared_env?: boolean;
  readonly auth_modes?: Record<string, unknown>;
  readonly constraints?: Record<string, unknown>;
}

function loadRecipes(): readonly ParsedRecipe[] {
  return readdirSync(RECIPE_DIR)
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((name) => {
      const parsed = parse(readFileSync(join(RECIPE_DIR, name), "utf8"));
      if (!isRecord(parsed) || typeof parsed.id !== "string") {
        throw new Error(`recipe ${name} must be an object with string id`);
      }
      return parsed as ParsedRecipe;
    });
}

const RECIPES = loadRecipes();
const RECIPES_BY_ID = new Map(RECIPES.map((recipe) => [recipe.id, recipe]));

test("recipe catalog covers the Final Plan built-ins plus arbitrary generic env", () => {
  expect([...RECIPES_BY_ID.keys()]).toEqual(
    expect.arrayContaining([
      "cloudflare",
      "aws",
      "google",
      "s3-compatible",
      "generic-env",
      "hcloud",
      "digitalocean",
      "vultr",
      "scaleway",
      "openstack",
    ]),
  );
});

test("every built-in provider env rule has a matching recipe with exact env and required-group projection", () => {
  for (const rule of PROVIDER_CREDENTIAL_ENV_RULES) {
    const recipe = RECIPES_BY_ID.get(rule.shortName);
    expect(recipe, `missing recipe for ${rule.shortName}`).toBeDefined();
    expect(recipe!.provider_rule).toBe(rule.shortName);
    expect(sorted(recipe!.env_names ?? [])).toEqual(sorted(rule.envNames));
    expect(groupSet(recipe!.required_env_groups ?? [])).toEqual(
      groupSet(rule.requiredGroups),
    );
  }
});

test("recipe auth modes only reference declared provider env names", () => {
  for (const recipe of RECIPES) {
    if (recipe.declared_env) continue;
    const rule = providerEnvRule(recipe.provider_rule ?? recipe.id);
    expect(
      rule,
      `recipe ${recipe.id} must resolve a provider rule`,
    ).toBeDefined();
    const declared = new Set(recipe.env_names ?? []);
    expect(
      declared.size,
      `recipe ${recipe.id} must declare env_names`,
    ).toBeGreaterThan(0);
    for (const envName of declared) {
      expect(isProviderEnvName(envName), `${recipe.id}:${envName}`).toBe(true);
      expect(
        isReservedProviderEnvName(envName),
        `${recipe.id}:${envName}`,
      ).toBe(false);
    }
    for (const envName of authModeEnvNames(recipe)) {
      expect(declared.has(envName), `${recipe.id}:${envName}`).toBe(true);
    }
  }
});

test("s3-compatible is an AWS provider recipe, not a separate provider boundary", () => {
  const recipe = RECIPES_BY_ID.get("s3-compatible");
  expect(recipe?.provider_rule).toBe("aws");
  const allowed = new Set(allowedEnvNamesForProvider("aws"));
  expect(recipe?.env_names).toContain("AWS_ENDPOINT_URL_S3");
  for (const envName of recipe?.env_names ?? []) {
    expect(allowed.has(envName), envName).toBe(true);
  }
});

test("generic-env recipe declares the arbitrary provider path without widening built-in rules", () => {
  const recipe = RECIPES_BY_ID.get("generic-env");
  expect(recipe?.declared_env).toBe(true);
  expect(recipe?.provider_rule).toBeUndefined();
  expect(recipe?.terraform_source).toBe("*");
  expect(authModeEnvNames(recipe!)).toEqual(["*"]);
  expect(
    (recipe?.constraints?.reserved_env_prefixes as string[]) ?? [],
  ).toEqual(expect.arrayContaining(["TAKOSUMI_", "OPENTOFU_", "TF_"]));
});

test("provider runtime registry credential env names are backed by recipes", () => {
  const recipeIdForProviderRuntime = new Map([
    ["gcp", "google"],
    ["azure", "azurerm"],
  ]);
  for (const runtime of PROVIDER_RUNTIMES) {
    if (runtime.credentialEnvNames.length === 0) continue;
    const recipeId = recipeIdForProviderRuntime.get(runtime.id) ?? runtime.id;
    const recipe = RECIPES_BY_ID.get(recipeId);
    expect(recipe, `missing recipe for runtime ${runtime.id}`).toBeDefined();
    expect(sorted(recipe!.env_names ?? [])).toEqual(
      sorted(runtime.credentialEnvNames),
    );
  }
});

test("recipe required groups match the runtime provider-env rule helper", () => {
  for (const recipe of RECIPES) {
    if (recipe.declared_env) continue;
    if (recipe.provider_rule && recipe.provider_rule !== recipe.id) continue;
    const provider = recipe.provider_rule ?? recipe.id;
    expect(groupSet(recipe.required_env_groups ?? [])).toEqual(
      groupSet(requiredEnvGroupsForProvider(provider)),
    );
  }
});

function authModeEnvNames(recipe: ParsedRecipe): readonly string[] {
  const names = new Set<string>();
  for (const mode of Object.values(recipe.auth_modes ?? {})) {
    if (!isRecord(mode)) continue;
    collectEnvObjectKeys(mode.env, names);
    collectFileEnvNames(mode.files, names);
  }
  return sorted([...names]);
}

function collectEnvObjectKeys(value: unknown, names: Set<string>): void {
  if (!isRecord(value)) return;
  for (const name of Object.keys(value)) names.add(name);
}

function collectFileEnvNames(value: unknown, names: Set<string>): void {
  if (!isRecord(value)) return;
  for (const file of Object.values(value)) {
    if (!isRecord(file)) continue;
    const envName = file.env_name;
    if (typeof envName === "string") names.add(envName);
  }
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

function groupSet(groups: readonly (readonly string[])[]): readonly string[] {
  return groups.map((group) => sorted(group).join("\0")).sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
