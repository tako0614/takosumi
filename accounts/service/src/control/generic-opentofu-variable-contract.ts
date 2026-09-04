import {
  normalizeCompatibilityReportModulePath,
  type CapsuleRootModuleVariableDeclaration,
} from "takosumi-contract/capsules";

import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";

/**
 * Canonical digest of the runner-discovered generic OpenTofu variable
 * declaration contract. Values, UI presentation, and policy are deliberately
 * excluded: the marker only proves which names/basic types/default presence
 * the immutable SourceSnapshot runner observed.
 */
export async function genericOpenTofuVariableContractDigest(input: {
  readonly declarations: readonly CapsuleRootModuleVariableDeclaration[];
  readonly modulePath: string;
}): Promise<string> {
  return await stableJsonDigest({
    contract: "takosumi.generic-opentofu-variable-contract/v1",
    modulePath: normalizeCompatibilityReportModulePath(input.modulePath),
    declarations: input.declarations
      .map((declaration) => ({
        name: declaration.name,
        type: declaration.type,
        hasDefault: declaration.hasDefault,
      }))
      .sort(compareVariableDeclarations),
  });
}

export function genericOpenTofuVariableDeclarationsAreCanonical(
  declarations: readonly CapsuleRootModuleVariableDeclaration[],
): boolean {
  const names = new Set<string>();
  return declarations.every((declaration) => {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(declaration.name) ||
      names.has(declaration.name) ||
      (declaration.type !== "string" &&
        declaration.type !== "number" &&
        declaration.type !== "boolean" &&
        declaration.type !== "json" &&
        declaration.type !== "unknown") ||
      typeof declaration.hasDefault !== "boolean"
    ) {
      return false;
    }
    names.add(declaration.name);
    return true;
  });
}

function compareVariableDeclarations(
  left: Pick<CapsuleRootModuleVariableDeclaration, "name">,
  right: Pick<CapsuleRootModuleVariableDeclaration, "name">,
): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}
