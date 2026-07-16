import { formRefKey } from "takosumi-contract";
import type { FormDefinitionRecord, FormPackageRecord } from "./records.ts";

export function packageInstallEquivalent(
  existingPackage: FormPackageRecord,
  incomingPackage: FormPackageRecord,
  existingDefinitions: readonly FormDefinitionRecord[],
  incomingDefinitions: readonly FormDefinitionRecord[],
): boolean {
  if (
    existingPackage.artifactRef !== incomingPackage.artifactRef ||
    existingPackage.verifierId !== incomingPackage.verifierId ||
    canonicalJson(existingPackage.definitionRefs) !==
      canonicalJson(incomingPackage.definitionRefs) ||
    existingDefinitions.length !== incomingDefinitions.length
  ) {
    return false;
  }
  const existingByKey = definitionsByKey(existingDefinitions);
  const incomingByKey = definitionsByKey(incomingDefinitions);
  if (
    existingByKey.size !== existingDefinitions.length ||
    incomingByKey.size !== incomingDefinitions.length
  ) {
    return false;
  }
  for (const [key, left] of existingByKey) {
    const right = incomingByKey.get(key);
    if (
      right === undefined ||
      left.identity.packageDigest !== right.identity.packageDigest ||
      left.displayName !== right.displayName ||
      left.description !== right.description ||
      canonicalJson(left.operations) !== canonicalJson(right.operations) ||
      canonicalJson(left.metadata ?? null) !==
        canonicalJson(right.metadata ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function definitionsByKey(definitions: readonly FormDefinitionRecord[]) {
  return new Map(
    definitions.map((definition) => [
      formRefKey(definition.identity.formRef),
      definition,
    ]),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
