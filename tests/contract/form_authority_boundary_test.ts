import { expect, test } from "bun:test";

import * as contract from "../../contract/index.ts";
import * as serviceForms from "../../core/domains/service-forms/mod.ts";

test("host support and activation do not expose a central Form admission authority", () => {
  expect(contract).not.toHaveProperty("STANDARD_FORM_ADMISSION_FORMAT");
  expect(contract).not.toHaveProperty(
    "STANDARD_FORM_INVALID_ARGUMENT_ERROR_CODE",
  );
  expect(serviceForms).not.toHaveProperty("evaluateStandardFormAdmission");
});
