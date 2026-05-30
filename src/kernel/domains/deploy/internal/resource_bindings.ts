// Build the per-compute binding map projected from `resource.*.bindings`
// declarations in the public manifest. The validation phase reuses
// `resourceBindingsFor` to assert each binding target exists; the
// compile phase invokes `resourceBindingsByComputeFor` to fold the
// expanded bindings into each component's binding map.

import type {
  PublicComponentBindingSpec,
  PublicDeployManifest,
  PublicResourceSpec,
} from "../types.ts";
import {
  isRecord,
  normalizeEnvName,
  PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR,
  stringField,
} from "./manifest_common.ts";
import {
  resourceContractRefFor,
  resourceDefaultAccessModeFor,
} from "./contract_refs.ts";

export function resourceBindingsByComputeFor(
  resources: NonNullable<PublicDeployManifest["resources"]>,
  computeNames: Set<string>,
  expansionDescriptors: Set<string>,
): Map<string, Record<string, PublicComponentBindingSpec>> {
  const byCompute = new Map<
    string,
    Record<string, PublicComponentBindingSpec>
  >();
  for (const [resourceName, resource] of Object.entries(resources)) {
    const resourceContractRef = resourceContractRefFor(resource.type);
    const accessMode = resourceDefaultAccessModeFor(resourceContractRef);
    const bindings = resourceBindingsFor(resourceName, resource);
    if (bindings.length > 0) {
      expansionDescriptors.add(PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR);
    }
    for (const binding of bindings) {
      if (!computeNames.has(binding.compute)) {
        throw new TypeError(
          `resource.${resourceName}.bindings references unknown compute '${binding.compute}'`,
        );
      }
      const map = byCompute.get(binding.compute) ?? {};
      map[binding.envName] = {
        from: {
          resource: `resource.${resourceName}`,
          access: { contract: resourceContractRef, mode: accessMode },
        },
        inject: { mode: "env", target: binding.envName },
      };
      byCompute.set(binding.compute, map);
    }
  }
  return byCompute;
}

export function resourceBindingsFor(
  resourceName: string,
  resource: PublicResourceSpec,
): { compute: string; envName: string }[] {
  const bindings: { compute: string; envName: string }[] = [];
  if (isRecord(resource.bindings)) {
    for (const [compute, envName] of Object.entries(resource.bindings)) {
      if (typeof envName !== "string" || envName.length === 0) {
        throw new TypeError(
          `resource.${resourceName}.bindings.${compute} requires binding name`,
        );
      }
      bindings.push({
        compute,
        envName: normalizeEnvName(
          envName,
          `resource.${resourceName}.bindings.${compute}`,
        ),
      });
    }
  } else if (Array.isArray(resource.bindings)) {
    for (const [index, item] of resource.bindings.entries()) {
      if (!isRecord(item)) {
        throw new TypeError(
          `resource.${resourceName}.bindings[${index}] must be an object`,
        );
      }
      const envName = stringField(item, "binding") ??
        stringField(item, "bind") ??
        stringField(item, "env");
      const targets = targetListFor(item.to ?? item.target);
      if (!envName || targets.length === 0) {
        throw new TypeError(
          `resource.${resourceName}.bindings[${index}] requires target and binding`,
        );
      }
      for (const compute of targets) {
        bindings.push({
          compute,
          envName: normalizeEnvName(
            envName,
            `resource.${resourceName}.bindings[${index}]`,
          ),
        });
      }
    }
  } else if (resource.bindings !== undefined) {
    throw new TypeError(
      `resource.${resourceName}.bindings must be object or array`,
    );
  }

  if (resource.bind !== undefined || resource.to !== undefined) {
    if (typeof resource.bind !== "string" || resource.bind.length === 0) {
      throw new TypeError(
        `resource.${resourceName}.bind requires binding name`,
      );
    }
    const targets = targetListFor(resource.to);
    if (targets.length === 0) {
      throw new TypeError(`resource.${resourceName}.bind requires to`);
    }
    for (const compute of targets) {
      bindings.push({
        compute,
        envName: normalizeEnvName(
          resource.bind,
          `resource.${resourceName}.bind`,
        ),
      });
    }
  }
  return bindings;
}

function targetListFor(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string =>
      typeof item === "string" && item.length > 0
    );
  }
  return [];
}
