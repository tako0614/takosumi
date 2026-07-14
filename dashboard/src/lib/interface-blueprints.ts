import type { CapsuleInterfaceBlueprint } from "takosumi-contract";

export type InterfaceBlueprintJsonError = "invalid_json" | "not_array";

export type ParseInterfaceBlueprintsJsonResult =
  | {
      readonly ok: true;
      readonly value: readonly CapsuleInterfaceBlueprint[];
    }
  | {
      readonly ok: false;
      readonly error: InterfaceBlueprintJsonError;
    };

/**
 * Keep the dashboard editor deliberately data-driven. It only owns JSON
 * syntax and the top-level collection shape; the control API remains the
 * canonical validator for Interface names, specs, inputs, and bindings.
 */
export function parseInterfaceBlueprintsJson(
  text: string,
): ParseInterfaceBlueprintsJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "not_array" };
  }
  return {
    ok: true,
    value: parsed as readonly CapsuleInterfaceBlueprint[],
  };
}

export function formatInterfaceBlueprintsJson(
  blueprints: readonly CapsuleInterfaceBlueprint[] | undefined,
): string {
  return JSON.stringify(blueprints ?? [], null, 2);
}
