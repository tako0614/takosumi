import { expect, test } from "bun:test";

import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { rootgenErrorForController } from "../../../../core/domains/deploy-control/rootgen_error.ts";
import { RootgenValidationError } from "../../../../lib/rootgen/src/mod.ts";

test("Core translates rootgen validation once without losing public semantics", () => {
  const rootgenError = new RootgenValidationError(
    "rootgen_invalid_identifier",
    "rootgen: input name must be a valid OpenTofu identifier",
  );

  const mapped = rootgenErrorForController(rootgenError);

  expect(mapped).toBeInstanceOf(OpenTofuControllerError);
  expect(mapped).not.toBe(rootgenError);
  expect(mapped).toMatchObject({
    name: "OpenTofuControllerError",
    code: "invalid_argument",
    message: rootgenError.message,
    details: { reason: "rootgen_invalid_identifier" },
  });

  // A second boundary cannot remap the already translated controller error.
  expect(rootgenErrorForController(mapped)).toBe(mapped);
});

test("Core does not launder unexpected rootgen failures into public validation", () => {
  const unexpected = new Error("unexpected");
  expect(rootgenErrorForController(unexpected)).toBe(unexpected);
});
