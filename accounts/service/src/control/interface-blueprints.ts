import type { CapsuleInterfaceBlueprint } from "takosumi-contract/interfaces";
import { validateCapsuleInterfaceBlueprints } from "../../../../core/domains/interfaces/service.ts";

export type InterfaceBlueprintsParseResult =
  | {
      readonly ok: true;
      readonly value: readonly CapsuleInterfaceBlueprint[];
    }
  | { readonly ok: false; readonly message: string };

/**
 * Parse service-owned Interface declarations without teaching the request
 * layer a second schema. The Interface domain validator remains authoritative,
 * and its actionable 4xx reason is preserved for API clients.
 */
export function parseInterfaceBlueprintsValue(
  value: unknown,
): InterfaceBlueprintsParseResult {
  if (!Array.isArray(value)) {
    return { ok: false, message: "interfaceBlueprints must be an array" };
  }
  try {
    validateCapsuleInterfaceBlueprints(
      value as readonly CapsuleInterfaceBlueprint[],
    );
    return {
      ok: true,
      value: value as readonly CapsuleInterfaceBlueprint[],
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : "interfaceBlueprints must contain valid Interface blueprint declarations",
    };
  }
}
