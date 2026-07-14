import { describe, expect, test } from "bun:test";
import {
  formatInterfaceBlueprintsJson,
  parseInterfaceBlueprintsJson,
} from "../../../../dashboard/src/lib/interface-blueprints.ts";

describe("Interface blueprint JSON editor helpers", () => {
  test("handles JSON syntax and the top-level array shape locally", () => {
    expect(parseInterfaceBlueprintsJson("{")).toEqual({
      ok: false,
      error: "invalid_json",
    });
    expect(parseInterfaceBlueprintsJson('{"key":"runtime"}')).toEqual({
      ok: false,
      error: "not_array",
    });
  });

  test("preserves canonical declarations for control-API validation", () => {
    const text = JSON.stringify([
      {
        key: "runtime-api",
        name: "runtime.api",
        spec: {
          type: "example.protocol",
          version: "1",
          document: { endpoint: "$inputs.endpoint" },
          inputs: {
            endpoint: {
              source: "capsule_output",
              outputName: "public_endpoint",
            },
          },
          access: { visibility: "workspace" },
        },
      },
    ]);

    const parsed = parseInterfaceBlueprintsJson(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value[0]?.key).toBe("runtime-api");
    expect(parsed.value[0]?.spec.inputs?.endpoint).toEqual({
      source: "capsule_output",
      outputName: "public_endpoint",
    });
    expect(formatInterfaceBlueprintsJson(parsed.value)).toBe(
      JSON.stringify(parsed.value, null, 2),
    );
  });

  test("formats a missing declaration set as an explicit empty array", () => {
    expect(formatInterfaceBlueprintsJson(undefined)).toBe("[]");
  });
});
