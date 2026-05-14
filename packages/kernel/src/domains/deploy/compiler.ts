import type {
  AppSpec,
  AppSpecOutput,
  AppSpecRoute,
  DeploySourceRef,
  PublicComponentBindingSpec,
  PublicComputeRequirements,
  PublicComputeSpec,
  PublicDeployManifest,
  PublicOutputSpec,
  PublicRouteSpec,
} from "./types.ts";
import {
  assertKnownFields,
  isRecord,
  namedCollectionEntries,
  PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR,
} from "./internal/manifest_common.ts";
import { resourceBindingsByComputeFor } from "./internal/resource_bindings.ts";
import { validateManifestShape } from "./internal/manifest_validate.ts";
import {
  inferComputeType,
  interfaceContractRefFor,
  outputContractRefFor,
  resourceContractRefFor,
  runtimeContractRefFor,
} from "./internal/contract_refs.ts";
import {
  isPortProtocol,
  isQueueRouteProtocol,
  normalizeRoutePort,
  normalizeRouteProtocol,
  portForCompute,
} from "./internal/route_helpers.ts";

export interface CompileManifestOptions {
  source?: DeploySourceRef;
  env?: string;
  envName?: string;
  autoHostnameAvailable?: boolean;
  localDevelopment?: boolean;
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

const INTERNAL_OVERRIDE_FIELDS = new Set([
  "providerTarget",
  "rollout",
  "runtimeNetworkPolicy",
  "accessPathPreferences",
  "approvals",
  "takosumi.directDeploy",
]);

export function compileManifestToAppSpec(
  manifest: PublicDeployManifest,
  options: CompileManifestOptions = {},
): AppSpec {
  const expansionDescriptors = new Set<string>();
  const expandedManifest = preparePublicDeployManifest(manifest, options);
  validateManifestShape(expandedManifest, options);
  const computeNames = new Set(Object.keys(expandedManifest.compute ?? {}));
  const resourceBindingsByCompute = resourceBindingsByComputeFor(
    expandedManifest.resources ?? {},
    computeNames,
    expansionDescriptors,
  );
  const outputs = publicOutputCollection(expandedManifest);
  for (
    const [name, compute] of Object.entries(expandedManifest.compute ?? {})
  ) {
    for (const dependency of compute.depends ?? []) {
      if (!computeNames.has(dependency)) {
        throw new TypeError(
          `compute.${name}.depends references unknown compute '${dependency}'`,
        );
      }
    }
  }

  const appSpec = {
    groupId: expandedManifest.name,
    name: expandedManifest.name,
    version: expandedManifest.version,
    source: structuredClone(options.source ?? { kind: "manifest" }),
    components: Object.entries(expandedManifest.compute ?? {}).map((
      [name, compute],
    ) => {
      const computeType = compute.type ?? inferComputeType(name, compute);
      const runtimeContractRef = runtimeContractRefFor(computeType);
      if (runtimeContractRef !== compute.type) {
        expansionDescriptors.add(PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR);
      }
      const bindings: Record<string, PublicComponentBindingSpec> = {
        ...structuredClone(compute.bindings ?? {}),
        ...structuredClone(resourceBindingsByCompute.get(name) ?? {}),
      };
      return {
        name,
        type: runtimeContractRef,
        image: compute.image,
        port: compute.port,
        entrypoint: compute.entrypoint,
        command: compute.command,
        args: compute.args,
        env: { ...(compute.env ?? {}) },
        depends: [...(compute.depends ?? [])],
        bindings,
        requirements: computeRequirementsFor(compute),
        raw: structuredClone(compute),
        runtimeContractRef,
      };
    }),
    resources: Object.entries(expandedManifest.resources ?? {}).map((
      [name, resource],
    ) => {
      const resourceContractRef = resourceContractRefFor(resource.type);
      if (resourceContractRef !== resource.type) {
        expansionDescriptors.add(PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR);
      }
      return {
        name,
        type: resourceContractRef,
        env: { ...(resource.env ?? {}) },
        raw: structuredClone(resource),
        resourceContractRef,
      };
    }),
    routes: normalizeNamedCollection(
      expandedManifest.routes ?? {},
      "route",
      expansionDescriptors,
      expandedManifest.compute ?? {},
    ),
    outputs: normalizeNamedCollection(
      outputs,
      "output",
      expansionDescriptors,
    ),
    env: { ...(expandedManifest.env ?? {}) },
    overrides: { ...(expandedManifest.overrides ?? {}) },
  };
  // C2 — fold authoring + override-provided runtime capabilities into a
  // single deterministic map. The descriptor-closure builder folds this map
  // into the closure digest so a profile switch that injects different
  // capabilities produces a different closure digest even when the raw
  // manifest text is unchanged.
  const effectiveRuntimeCapabilities = computeEffectiveRuntimeCapabilities(
    appSpec.components,
    expandedManifest.overrides,
  );
  const baseSpec = expansionDescriptors.size > 0
    ? {
      ...appSpec,
      authoringExpansionDescriptors: [...expansionDescriptors].sort(),
    }
    : appSpec;
  return {
    ...baseSpec,
    effectiveRuntimeCapabilities,
  } as AppSpec;
}

/**
 * C2 — Compute the per-component effective runtime capability set.
 *
 * Sources, merged in order with later sources winning on conflicts:
 *   1. `component.requirements.runtimeCapabilities` (authoring)
 *   2. `manifest.overrides.runtimeCapabilities[component]` (profile)
 *
 * The result is sorted (stable digest input) and only includes components
 * that contribute at least one capability — components with the empty set
 * are omitted so a baseline manifest does not gain a noisy entry.
 */
function computeEffectiveRuntimeCapabilities(
  components: readonly {
    name: string;
    requirements?: { runtimeCapabilities?: readonly string[] };
  }[],
  overrides: PublicDeployManifest["overrides"],
): Record<string, readonly string[]> {
  const profileMap =
    isRecord(overrides) && isRecord(overrides.runtimeCapabilities)
      ? overrides.runtimeCapabilities as Record<string, unknown>
      : {};
  const out: Record<string, readonly string[]> = {};
  for (const component of components) {
    const fromComponent = component.requirements?.runtimeCapabilities ?? [];
    const fromProfileRaw = profileMap[component.name];
    const fromProfile: string[] = Array.isArray(fromProfileRaw)
      ? fromProfileRaw.filter((value): value is string =>
        typeof value === "string"
      )
      : [];
    const merged = [
      ...new Set<string>([...fromComponent, ...fromProfile]),
    ].sort();
    if (merged.length > 0) out[component.name] = merged;
  }
  return out;
}

export function validatePublicDeployManifest(
  manifest: PublicDeployManifest,
  options: Pick<
    CompileManifestOptions,
    "env" | "envName" | "autoHostnameAvailable" | "localDevelopment"
  > = {},
): void {
  const preparedManifest = preparePublicDeployManifest(manifest, options);
  validateManifestShape(preparedManifest, options);
}

export function resolvePublicDeployManifest(
  manifest: PublicDeployManifest,
  options: Pick<
    CompileManifestOptions,
    "env" | "envName" | "autoHostnameAvailable" | "localDevelopment"
  > = {},
): PublicDeployManifest {
  const preparedManifest = preparePublicDeployManifest(manifest, options);
  validateManifestShape(preparedManifest, options);
  return preparedManifest;
}

function preparePublicDeployManifest(
  manifest: PublicDeployManifest,
  options: Pick<CompileManifestOptions, "env" | "envName">,
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
      publicOutputCollection(output),
      overrideOutputs as
        | Record<string, PublicOutputSpec>
        | PublicOutputSpec[],
      envName,
    );
  }
  return output;
}

function publicOutputCollection(
  manifest: PublicDeployManifest,
): Record<string, PublicOutputSpec> | PublicOutputSpec[] {
  return manifest.outputs ?? {};
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

function normalizeNamedCollection(
  value: Record<string, PublicRouteSpec> | PublicRouteSpec[],
  kind: "route",
  expansionDescriptors: Set<string>,
  compute?: Record<string, PublicComputeSpec>,
): AppSpecRoute[];
function normalizeNamedCollection(
  value: Record<string, PublicOutputSpec> | PublicOutputSpec[],
  kind: "output",
  expansionDescriptors: Set<string>,
): AppSpecOutput[];
function normalizeNamedCollection(
  value:
    | Record<string, PublicRouteSpec>
    | PublicRouteSpec[]
    | Record<string, PublicOutputSpec>
    | PublicOutputSpec[],
  kind: "route" | "output",
  expansionDescriptors: Set<string>,
  compute: Record<string, PublicComputeSpec> = {},
): AppSpecRoute[] | AppSpecOutput[] {
  if (kind === "route") {
    const entries = namedCollectionEntries(
      value as Record<string, PublicRouteSpec> | PublicRouteSpec[],
      "route",
    );
    return entries.map(([name, raw]) => {
      const route = raw as PublicRouteSpec;
      const to = route.target;
      if (typeof to !== "string" || to.length === 0) {
        throw new TypeError(`route.${name} requires target compute`);
      }
      const protocol = normalizeRouteProtocol(route.protocol);
      const interfaceContractRef = interfaceContractRefFor(protocol);
      const targetPort = portForCompute(compute[to]);
      const port = normalizeRoutePort(name, route.port) ??
        (isPortProtocol(protocol) ? targetPort : undefined);
      expansionDescriptors.add(PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR);
      return {
        name,
        to,
        host: route.host,
        path: route.path,
        protocol,
        port,
        targetPort: targetPort ?? port,
        methods: route.methods ? [...route.methods] : undefined,
        source: isQueueRouteProtocol(protocol)
          ? route.source ?? name
          : route.source,
        raw: structuredClone(route),
        interfaceContractRef,
      } as AppSpecRoute;
    });
  }

  const entries = namedCollectionEntries(
    value as Record<string, PublicOutputSpec> | PublicOutputSpec[],
    "output",
  );
  return entries.map(([name, raw]) => {
    const output = raw as PublicOutputSpec;
    const outputContractRef = outputContractRefFor(output.type);
    if (outputContractRef !== output.type) {
      expansionDescriptors.add(PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR);
    }
    return {
      name,
      type: outputContractRef,
      from: output.from,
      outputs: { ...(output.outputs ?? {}) },
      spec: { ...(output.spec ?? {}) },
      raw: structuredClone(output),
      outputContractRef,
    } as AppSpecOutput;
  });
}

function computeRequirementsFor(
  compute: PublicComputeSpec,
): PublicComputeRequirements {
  const runtimeCapabilities = new Set(
    Array.isArray(compute.requirements?.runtimeCapabilities)
      ? compute.requirements.runtimeCapabilities.filter((capability) =>
        typeof capability === "string" && capability.length > 0
      )
      : [],
  );
  if (
    typeof compute.requirements?.minInstances === "number" &&
    compute.requirements.minInstances >= 1
  ) {
    runtimeCapabilities.add("always-on-container");
  }

  return {
    ...(compute.requirements ?? {}),
    runtimeCapabilities: [...runtimeCapabilities].sort(),
  };
}
