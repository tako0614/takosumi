import { describe, expect, test } from "bun:test";
import { installConfigVariableDefaultValue } from "../../../../accounts/service/src/control/parse.ts";

describe("InstallConfig variable default request parsing", () => {
  test("accepts only canonical discriminated defaults", () => {
    expect(
      installConfigVariableDefaultValue({ source: "literal", value: false }),
    ).toEqual({ source: "literal", value: false });
    expect(
      installConfigVariableDefaultValue({ source: "capsule_name" }),
    ).toEqual({ source: "capsule_name" });
    expect(
      installConfigVariableDefaultValue({
        source: "workspace_scoped_capsule_name",
      }),
    ).toEqual({ source: "workspace_scoped_capsule_name" });
  });

  test("rejects legacy magic strings and ambiguous object shapes", () => {
    expect(installConfigVariableDefaultValue("service-name")).toBeUndefined();
    expect(
      installConfigVariableDefaultValue("service-name-with-workspace"),
    ).toBeUndefined();
    expect(
      installConfigVariableDefaultValue({
        source: "capsule_name",
        value: "unexpected",
      }),
    ).toBeUndefined();
    expect(
      installConfigVariableDefaultValue({ source: "literal" }),
    ).toBeUndefined();
  });
});
