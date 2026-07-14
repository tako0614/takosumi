import { describe, expect, test } from "bun:test";
import { parseInterfaceBlueprintsValue } from "../../../../accounts/service/src/control/interface-blueprints.ts";

describe("control API Interface blueprint parsing", () => {
  test("returns the canonical validator error instead of flattening it", () => {
    const result = parseInterfaceBlueprintsValue([
      {
        name: "runtime.api",
        spec: {
          type: "example.protocol",
          version: "1",
          document: {},
          access: { visibility: "workspace" },
        },
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("blueprint.key");
  });

  test("keeps the top-level array error precise", () => {
    expect(parseInterfaceBlueprintsValue({})).toEqual({
      ok: false,
      message: "interfaceBlueprints must be an array",
    });
  });
});
