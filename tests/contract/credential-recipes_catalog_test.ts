import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parse } from "yaml";

import {
  isProviderEnvName,
  isReservedProviderEnvName,
} from "../../contract/provider-env-rules.ts";
import { GUIDED_PROVIDER_SETUPS } from "../../providers/registry.ts";

const RECIPE_DIR = join(import.meta.dir, "../../recipes/providers");

interface ParsedRecipe {
  readonly id: string;
  readonly display_name?: string;
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

test("recipe auth modes only reference declared provider env names", () => {
  for (const recipe of RECIPES) {
    if (recipe.declared_env) continue;
    expect(recipe.terraform_source).toBeDefined();
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

test("s3-compatible selects the AWS provider by exact Terraform source", () => {
  const recipe = RECIPES_BY_ID.get("s3-compatible");
  const aws = RECIPES_BY_ID.get("aws");
  expect(recipe?.terraform_source).toEqual(aws?.terraform_source);
  const allowed = new Set(aws?.env_names ?? []);
  expect(recipe?.env_names).toContain("AWS_ENDPOINT_URL_S3");
  for (const envName of recipe?.env_names ?? []) {
    expect(allowed.has(envName), envName).toBe(true);
  }
});

test("generic-env recipe declares the arbitrary provider path", () => {
  const recipe = RECIPES_BY_ID.get("generic-env");
  expect(recipe?.declared_env).toBe(true);
  expect(recipe?.terraform_source).toBe("*");
  expect(authModeEnvNames(recipe!)).toEqual(["*"]);
  expect(
    (recipe?.constraints?.reserved_env_prefixes as string[]) ?? [],
  ).toEqual(expect.arrayContaining(["TAKOSUMI_", "OPENTOFU_", "TF_"]));
});

test("guided provider setup credential env names are backed by recipes", () => {
  const recipeIdForGuidedSetup = new Map([
    ["gcp", "google"],
    ["azure", "azurerm"],
  ]);
  for (const setup of GUIDED_PROVIDER_SETUPS) {
    if (setup.credentialEnvNames.length === 0) continue;
    const recipeId = recipeIdForGuidedSetup.get(setup.id) ?? setup.id;
    const recipe = RECIPES_BY_ID.get(recipeId);
    expect(recipe, `missing recipe for setup ${setup.id}`).toBeDefined();
    expect(sorted(recipe!.env_names ?? [])).toEqual(
      sorted(setup.credentialEnvNames),
    );
  }
});

test("recipe required groups reference only their own declared env names", () => {
  for (const recipe of RECIPES) {
    if (recipe.declared_env) continue;
    const declared = new Set(recipe.env_names ?? []);
    for (const group of recipe.required_env_groups ?? []) {
      expect(
        group.length,
        `${recipe.id} has an empty required group`,
      ).toBeGreaterThan(0);
      for (const envName of group) {
        expect(declared.has(envName), `${recipe.id}:${envName}`).toBe(true);
      }
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
