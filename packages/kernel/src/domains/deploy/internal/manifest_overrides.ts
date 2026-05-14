// Override-merge phase for the public deploy manifest.
//
// `preparePublicDeployManifest` runs first: it validates the top-level
// envelope, then if an `envName` is selected, merges the matching
// `overrides[envName]` block back over the base manifest before the
// validation phase looks at the result.

import type { PublicDeployManifest, PublicOutputSpec } from "../types.ts";
import {
  assertKnownFields,
  isRecord,
  namedCollectionEntries,
} from "./manifest_common.ts";

interface PrepareOptions {
  env?: string;
  envName?: string;
}

const FORBIDDEN_PUBLIC_FIELDS = [
  "apiVersion",
  "kind",
  "metadata",
  "spec",
  "provider",
  "backend",
] as const;

const TOP_LEVEL_FIELDS = new Set([
  "name",
  "version",
  "compute",
  "resources",
  "routes",
  "outputs",
  "env",
  "overrides",
]);

const ENV_OVERRIDE_FIELDS = new Set([
  "compute",
  "resources",
  "routes",
  "outputs",
  "env",
]);

export const INTERNAL_OVERRIDE_FIELDS = new Set([
  "providerTarget",
  "rollout",
  "runtimeNetworkPolicy",
  "accessPathPreferences",
  "approvals",
  "takosumi.directDeploy",
]);

export function preparePublicDeployManifest(
  manifest: PublicDeployManifest,
  options: PrepareOptions,
): PublicDeployManifest {
  validateTopLevelAndOverrides(manifest);
  const envName = options.envName ?? options.env;
  const base = structuredClone(manifest);
  if (!envName) return base;
  const overrides = isRecord(base.overrides) ? base.overrides : {};
  const selected = overrides[envName];
  if (selected === undefined) return base;
  if (!isRecord(selected)) {
    throw new TypeError(`overrides.${envName} must be an object`);
  }
  validateEnvironmentOverride(envName, selected);
  return mergeEnvironmentOverride(base, envName, selected);
}

function validateTopLevelAndOverrides(manifest: PublicDeployManifest): void {
  const candidate = manifest;
  for (const field of FORBIDDEN_PUBLIC_FIELDS) {
    if (field in candidate) {
      throw new TypeError(
        `public deploy manifest must not include '${field}'`,
      );
    }
  }
  assertKnownFields(candidate, TOP_LEVEL_FIELDS, "public deploy manifest");
  if (!manifest.name || typeof manifest.name !== "string") {
    throw new TypeError("public deploy manifest requires string field 'name'");
  }
  if (manifest.overrides !== undefined && !isRecord(manifest.overrides)) {
    throw new TypeError(
      "public deploy manifest field 'overrides' must be object",
    );
  }
  for (const [name, value] of Object.entries(manifest.overrides ?? {})) {
    if (INTERNAL_OVERRIDE_FIELDS.has(name)) continue;
    if (!isRecord(value)) {
      throw new TypeError(`overrides.${name} must be an object`);
    }
    validateEnvironmentOverride(name, value);
  }
}

function validateEnvironmentOverride(
  envName: string,
  override: Record<string, unknown>,
): void {
  assertKnownFields(override, ENV_OVERRIDE_FIELDS, `overrides.${envName}`);
}

function mergeEnvironmentOverride(
  manifest: PublicDeployManifest,
  envName: string,
  override: Record<string, unknown>,
): PublicDeployManifest {
  const output = structuredClone(manifest);
  output.overrides = Object.fromEntries(
    Object.entries(output.overrides ?? {}).filter(([key]) =>
      INTERNAL_OVERRIDE_FIELDS.has(key)
    ),
  );

  if (isRecord(override.env)) {
    output.env = {
      ...(output.env ?? {}),
      ...(override.env as Record<string, string>),
    };
  }
  if (isRecord(override.compute)) {
    output.compute = mergeRecordByName(output.compute ?? {}, override.compute);
  }
  if (isRecord(override.resources)) {
    output.resources = mergeRecordByName(
      output.resources ?? {},
      override.resources,
    );
  }
  if (override.routes !== undefined) {
    output.routes = structuredClone(
      override.routes as PublicDeployManifest["routes"],
    );
  }
  const overrideOutputs = override.outputs;
  if (overrideOutputs !== undefined) {
    output.outputs = mergeOutputsByName(
      output.outputs ?? {},
      overrideOutputs as
        | Record<string, PublicOutputSpec>
        | PublicOutputSpec[],
      envName,
    );
  }
  return output;
}

function mergeRecordByName<T>(
  base: Record<string, T>,
  override: Record<string, unknown>,
): Record<string, T> {
  const output = structuredClone(base) as Record<string, T>;
  for (const [name, value] of Object.entries(override)) {
    if (!isRecord(value)) {
      throw new TypeError(`override entry '${name}' must be an object`);
    }
    output[name] = deepMergeRecord(
      isRecord(output[name]) ? output[name] as Record<string, unknown> : {},
      value,
    ) as T;
  }
  return output;
}

function mergeOutputsByName(
  base: Record<string, PublicOutputSpec> | PublicOutputSpec[],
  override: Record<string, PublicOutputSpec> | PublicOutputSpec[],
  envName: string,
): PublicOutputSpec[] {
  const byName = new Map<string, PublicOutputSpec>();
  for (const [name, output] of namedCollectionEntries(base, "output")) {
    byName.set(name, { name, ...structuredClone(output) });
  }
  for (const [name, output] of namedCollectionEntries(override, "output")) {
    if (!output.name && Array.isArray(override)) {
      throw new TypeError(
        `overrides.${envName}.outputs entry requires name`,
      );
    }
    const previous = byName.get(name) ?? { name };
    byName.set(
      name,
      deepMergeRecord(
        previous,
        output,
      ) as PublicOutputSpec,
    );
  }
  return [...byName.values()];
}

function deepMergeRecord(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    output[key] = isRecord(value) && isRecord(output[key])
      ? deepMergeRecord(output[key] as Record<string, unknown>, value)
      : structuredClone(value);
  }
  return output;
}
