import { describe, expect, test } from "bun:test";
import { validateGeneratedAssetScriptWiring } from "../../scripts/lib/generated-asset-wiring";

const VALID_SCRIPTS = {
  check: "bun run generated-assets:check && bun run test",
  "generated-assets:check":
    "bun run generated-assets:wiring:check && bun run credential-recipes:check && bun run schema-validators:check",
  "generated-assets:write":
    "bun run credential-recipes:assets && bun run schema-validators:assets",
  "generated-assets:wiring:check": "bun scripts/check-generated-assets.ts",
  "credential-recipes:assets": "bun scripts/build-credential-recipes.ts",
  "credential-recipes:check": "bun scripts/build-credential-recipes.ts --check",
  "schema-validators:assets": "bun scripts/build-schema-validators.ts",
  "schema-validators:check": "bun scripts/build-schema-validators.ts --check",
  test: "bun test",
} as const;

describe("generated asset package-script wiring", () => {
  test("accepts paired developer writers and read-only canonical checks", () => {
    expect(validateGeneratedAssetScriptWiring(VALID_SCRIPTS)).toEqual([]);
  });

  test("rejects the canonical check reaching a writer transitively", () => {
    const errors = validateGeneratedAssetScriptWiring({
      ...VALID_SCRIPTS,
      "credential-recipes:check": "bun run credential-recipes:assets",
    });

    expect(errors).toContain(
      "'check' reaches generated asset writer 'credential-recipes:assets'; checks must be read-only",
    );
  });

  test("requires every asset writer to have and register a check-only pair", () => {
    const { "schema-validators:check": _omitted, ...withoutSchemaCheck } =
      VALID_SCRIPTS;
    const errors = validateGeneratedAssetScriptWiring(withoutSchemaCheck);

    expect(errors).toContain(
      "generated asset writer 'schema-validators:assets' requires check-only script 'schema-validators:check'",
    );
  });

  test("requires every writer to remain available through the developer command", () => {
    const errors = validateGeneratedAssetScriptWiring({
      ...VALID_SCRIPTS,
      "generated-assets:write": "bun run credential-recipes:assets",
    });

    expect(errors).toContain(
      "'generated-assets:write' must invoke 'schema-validators:assets'",
    );
  });
});
