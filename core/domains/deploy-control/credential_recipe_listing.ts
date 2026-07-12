/** Read-only guided Credential Recipe discovery. */
import {
  BUILT_IN_CREDENTIAL_RECIPES,
  type CredentialRecipe,
} from "takosumi-contract";

/**
 * Returns setup helpers, not a provider allowlist. A provider absent from this
 * list still runs through a generic env/file Provider Connection or with no
 * Provider Connection when credentials are unnecessary.
 */
export function listBuiltInCredentialRecipes(): readonly CredentialRecipe[] {
  return BUILT_IN_CREDENTIAL_RECIPES;
}

export function credentialRecipeById(
  id: string,
): CredentialRecipe | undefined {
  return BUILT_IN_CREDENTIAL_RECIPES.find((recipe) => recipe.id === id);
}
