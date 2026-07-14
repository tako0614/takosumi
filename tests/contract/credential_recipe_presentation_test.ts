import { expect, test } from "bun:test";

import { REFERENCE_CREDENTIAL_RECIPES } from "../../providers/credential-recipes.generated.ts";

test("reference guided forms are recipe-owned presentation, not execution metadata", () => {
  const guided = REFERENCE_CREDENTIAL_RECIPES.flatMap((recipe) =>
    Object.entries(recipe.authModes).flatMap(([authMode, mode]) =>
      mode.presentation?.showInConnectionSetup
        ? [{ recipe, authMode, mode }]
        : [],
    ),
  );

  expect(guided.length).toBeGreaterThan(10);
  for (const { recipe, mode } of guided) {
    expect(recipe.secretPartition).toBeTruthy();
    expect(recipe.terraformSource).not.toBe("*");
    expect(Object.keys(mode.env ?? {}).length).toBeGreaterThan(0);
    expect(mode.presentation?.displayName).toBeTruthy();
  }

  const generic = REFERENCE_CREDENTIAL_RECIPES.find(
    (recipe) => recipe.id === "generic-env",
  );
  expect(generic?.secretPartition).toBe("provider-credentials");
  expect(generic?.authModes.env?.presentation?.showInConnectionSetup).not.toBe(
    true,
  );
});
