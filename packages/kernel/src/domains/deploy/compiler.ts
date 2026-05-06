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
  PublicResourceSpec,
  PublicRouteSpec,
} from "./types.ts";

export interface CompileManifestOptions {
  source?: DeploySourceRef;
  env?: string;
  envName?: string;
  autoHostnameAvailable?: boolean;
  localDevelopment?: boolean;
}

const PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR =
  "authoring.public-manifest-expansion@v1";

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

const COMPUTE_FIELDS = new Set([
  "type",
  "build",
  "image",
  "port",
  "entrypoint",
  "command",
  "args",
  "env",
  "depends",
  "bindings",
  "requirements",
  "icon",
  "readiness",
  "containers",
  "triggers",
  "scaling",
  "dockerfile",
  "healthCheck",
  "volumes",
]);

const ATTACHED_CONTAINER_FIELDS = new Set([
  "image",
  "port",
  "env",
  "healthCheck",
  "volumes",
  "scaling",
  "bindings",
  "depends",
  "dockerfile",
  "cloudflare",
  "cloudflare.container",
]);

const CLOUDFLARE_CONTAINER_FIELDS = new Set([
  "className",
  "binding",
  "instanceType",
  "maxInstances",
  "name",
  "imageBuildContext",
  "imageVars",
  "rolloutActiveGracePeriod",
  "rolloutStepPercentage",
  "migrationTag",
  "sqlite",
]);

const TRIGGERS_FIELDS = new Set(["schedules", "queues"]);
const SCHEDULE_TRIGGER_FIELDS = new Set(["cron"]);
const QUEUE_TRIGGER_FIELDS = new Set([
  "binding",
  "queue",
  "deadLetterQueue",
  "maxBatchSize",
  "maxConcurrency",
  "maxRetries",
  "maxWaitTimeMs",
  "retryDelaySeconds",
]);

const RESOURCE_FIELDS = new Set([
  "type",
  "plan",
  "env",
  "bindings",
  "bind",
  "to",
  "generate",
]);

const ROUTE_FIELDS = new Set([
  "id",
  "target",
  "host",
  "path",
  "protocol",
  "port",
  "methods",
  "source",
  "timeoutMs",
]);

const OUTPUT_FIELDS = new Set([
  "name",
  "type",
  "from",
  "display",
  "auth",
  "outputs",
  "spec",
]);

const BINDING_FIELDS = new Set(["from", "inject"]);
const BINDING_FROM_FIELDS = new Set([
  "resource",
  "output",
  "secret",
  "providerOutput",
  "field",
  "access",
  "request",
  "optional",
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

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMAGE_DIGEST_PATTERN = /@sha256:[a-fA-F0-9]{64}$/;
const HTTP_METHOD_PATTERN = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/;

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

function validateManifestShape(
  manifest: PublicDeployManifest,
  options: Pick<
    CompileManifestOptions,
    "autoHostnameAvailable" | "localDevelopment"
  > = {},
): void {
  const compute = manifest.compute ?? {};
  const computeNames = new Set(Object.keys(compute));
  validateStringRecord(manifest.env, "env");
  const inheritedEnv = normalizedEnvNameSet(manifest.env ?? {}, "env");
  validateComputeCollection(manifest.compute ?? {});
  validateResources(manifest.resources ?? {}, computeNames);
  const routeEntries = validateRoutes(manifest.routes ?? {}, compute);
  validateOutputs(publicOutputCollection(manifest), routeEntries);
  const resourceBindingsByCompute = resourceBindingsByComputeFor(
    manifest.resources ?? {},
    computeNames,
    new Set(),
  );
  for (const [name, compute] of Object.entries(manifest.compute ?? {})) {
    const merged: Record<string, PublicComponentBindingSpec> = {
      ...(compute.bindings ?? {}),
      ...(resourceBindingsByCompute.get(name) ?? {}),
    };
    validateBindings(
      `compute.${name}`,
      merged,
      compute.env ?? {},
      inheritedEnv,
      options,
    );
    validateAttachedContainerBindings(name, compute, inheritedEnv, options);
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

function namedCollectionEntries<T extends { id?: string; name?: string }>(
  value: Record<string, T> | T[],
  kind: "route" | "output",
): [string, T][] {
  return Array.isArray(value)
    ? value.map((item, index) => [arrayEntryName(item, kind, index), item])
    : Object.entries(value);
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
        source: isEventRouteProtocol(protocol)
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

function arrayEntryName(
  item: PublicRouteSpec | PublicOutputSpec,
  kind: "route" | "output",
  index: number,
): string {
  const explicitName = kind === "route"
    ? (item as PublicRouteSpec).id
    : (item as PublicOutputSpec).name;
  return typeof explicitName === "string" && explicitName.length > 0
    ? explicitName
    : `${kind}-${index + 1}`;
}

function validateComputeCollection(
  compute: Record<string, PublicComputeSpec>,
): void {
  for (const [name, spec] of Object.entries(compute)) {
    if (!isRecord(spec)) {
      throw new TypeError(`compute.${name} must be an object`);
    }
    assertKnownFields(spec, COMPUTE_FIELDS, `compute.${name}`);
    validateStringRecord(spec.env, `compute.${name}.env`);
    if (spec.type !== undefined && typeof spec.type !== "string") {
      throw new TypeError(`compute.${name}.type must be string`);
    }
    if (spec.image !== undefined) {
      validateServiceImage(name, spec);
    }
    if (spec.build !== undefined) {
      console.warn(
        `compute.${name}.build.fromWorkflow is deprecated and will be ` +
          `removed; resolve the artifact upstream (e.g. via takosumi-git) ` +
          `and submit a manifest with a digest-pinned image URI instead.`,
      );
      validateWorkflowBuild(name, spec.build);
    }
    if (spec.depends !== undefined && !isStringArray(spec.depends)) {
      throw new TypeError(`compute.${name}.depends must be string array`);
    }
    const runtimeContractRef = computeRuntimeContractRef(name, spec);
    if (spec.containers !== undefined) {
      if (runtimeContractRef !== "runtime.js-worker@v1") {
        throw new TypeError(`compute.${name}.containers is worker-only`);
      }
      validateAttachedContainers(name, spec.containers);
    }
    if (spec.triggers !== undefined) {
      if (runtimeContractRef !== "runtime.js-worker@v1") {
        throw new TypeError(`compute.${name}.triggers is worker-only`);
      }
      validateTriggers(name, spec.triggers);
    }
    if (spec.bindings !== undefined) {
      validateBindingShape(`compute.${name}.bindings`, spec.bindings);
    }
  }
}

function validateBindingShape(
  pathPrefix: string,
  value: unknown,
): void {
  if (!isRecord(value)) {
    throw new TypeError(`${pathPrefix} must be object`);
  }
  for (const [name, spec] of Object.entries(value)) {
    const path = `${pathPrefix}.${name}`;
    if (!isRecord(spec)) {
      throw new TypeError(`${path} must be object`);
    }
    assertKnownFields(spec, BINDING_FIELDS, path);
    if (!isRecord(spec.from)) {
      throw new TypeError(`${path}.from must be object`);
    }
    assertKnownFields(spec.from, BINDING_FROM_FIELDS, `${path}.from`);
    const sourceKeys = ["resource", "output", "secret", "providerOutput"]
      .filter(
        (key) =>
          typeof (spec.from as Record<string, unknown>)[key] === "string",
      );
    if (sourceKeys.length !== 1) {
      throw new TypeError(
        `${path}.from must declare exactly one of resource | output | secret | providerOutput`,
      );
    }
    if (!isRecord(spec.inject)) {
      throw new TypeError(`${path}.inject must be object`);
    }
    if (
      typeof (spec.inject as Record<string, unknown>).mode !== "string" ||
      typeof (spec.inject as Record<string, unknown>).target !== "string"
    ) {
      throw new TypeError(`${path}.inject requires mode and target strings`);
    }
  }
}

function computeRuntimeContractRef(
  name: string,
  spec: PublicComputeSpec,
): string {
  return runtimeContractRefFor(spec.type ?? inferComputeType(name, spec));
}

function validateAttachedContainers(
  computeName: string,
  value: unknown,
): void {
  if (!isRecord(value)) {
    throw new TypeError(`compute.${computeName}.containers must be object`);
  }
  for (const [containerName, container] of Object.entries(value)) {
    const path = `compute.${computeName}.containers.${containerName}`;
    if (!isRecord(container)) {
      throw new TypeError(`${path} must be object`);
    }
    assertKnownFields(container, ATTACHED_CONTAINER_FIELDS, path);
    validateStringRecord(container.env, `${path}.env`);
    if (container.depends !== undefined && !isStringArray(container.depends)) {
      throw new TypeError(`${path}.depends must be string array`);
    }
    if (container.bindings !== undefined) {
      validateBindingShape(`${path}.bindings`, container.bindings);
    }
    validateAttachedContainerImage(path, container);
  }
}

function validateAttachedContainerImage(
  path: string,
  container: Record<string, unknown>,
): void {
  const port = container.port;
  if (
    typeof port !== "number" || !Number.isInteger(port) || port < 1 ||
    port > 65535
  ) {
    throw new TypeError(`${path}.port must be integer 1..65535`);
  }

  const cloudflareContainer = cloudflareContainerMetadata(container, path);
  if (typeof container.image !== "string" || container.image.length === 0) {
    throw new TypeError(`${path}.image must be digest-pinned with sha256`);
  }
  if (IMAGE_DIGEST_PATTERN.test(container.image)) return;
  if (cloudflareContainer && isSafeRepositoryRelativePath(container.image)) {
    return;
  }
  throw new TypeError(`${path}.image must be digest-pinned with sha256`);
}

function cloudflareContainerMetadata(
  container: Record<string, unknown>,
  path: string,
): Record<string, unknown> | undefined {
  const dotted = container["cloudflare.container"];
  const nested = isRecord(container.cloudflare)
    ? container.cloudflare.container
    : undefined;
  if (dotted !== undefined && nested !== undefined) {
    throw new TypeError(
      `${path} must not include both cloudflare.container forms`,
    );
  }
  const metadata = dotted ?? nested;
  if (metadata === undefined) return undefined;
  if (!isRecord(metadata)) {
    throw new TypeError(`${path}.cloudflare.container must be object`);
  }
  assertKnownFields(
    metadata,
    CLOUDFLARE_CONTAINER_FIELDS,
    `${path}.cloudflare.container`,
  );
  if (
    typeof metadata.className !== "string" || metadata.className.length === 0
  ) {
    throw new TypeError(
      `${path}.cloudflare.container.className must be string`,
    );
  }
  return metadata;
}

function validateTriggers(computeName: string, value: unknown): void {
  const path = `compute.${computeName}.triggers`;
  if (!isRecord(value)) throw new TypeError(`${path} must be object`);
  assertKnownFields(value, TRIGGERS_FIELDS, path);
  if (value.schedules !== undefined) {
    if (!Array.isArray(value.schedules)) {
      throw new TypeError(`${path}.schedules must be array`);
    }
    for (const [index, schedule] of value.schedules.entries()) {
      const itemPath = `${path}.schedules[${index}]`;
      if (!isRecord(schedule)) {
        throw new TypeError(`${itemPath} must be object`);
      }
      assertKnownFields(schedule, SCHEDULE_TRIGGER_FIELDS, itemPath);
      if (typeof schedule.cron !== "string" || schedule.cron.length === 0) {
        throw new TypeError(`${itemPath}.cron must be string`);
      }
    }
  }
  if (value.queues !== undefined) {
    if (!Array.isArray(value.queues)) {
      throw new TypeError(`${path}.queues must be array`);
    }
    for (const [index, queue] of value.queues.entries()) {
      validateQueueTrigger(`${path}.queues[${index}]`, queue);
    }
  }
}

function validateQueueTrigger(path: string, value: unknown): void {
  if (!isRecord(value)) throw new TypeError(`${path} must be object`);
  assertKnownFields(value, QUEUE_TRIGGER_FIELDS, path);
  const hasBinding = value.binding !== undefined;
  const hasQueue = value.queue !== undefined;
  if (hasBinding === hasQueue) {
    throw new TypeError(`${path} requires exactly one of binding or queue`);
  }
  if (hasBinding) {
    if (typeof value.binding !== "string") {
      throw new TypeError(`${path}.binding must be string`);
    }
    normalizeEnvName(value.binding, `${path}.binding`);
  }
  if (
    hasQueue && (typeof value.queue !== "string" || value.queue.length === 0)
  ) {
    throw new TypeError(`${path}.queue must be string`);
  }
  for (
    const field of [
      "maxBatchSize",
      "maxConcurrency",
      "maxRetries",
      "maxWaitTimeMs",
      "retryDelaySeconds",
    ] as const
  ) {
    if (value[field] !== undefined && !Number.isInteger(value[field])) {
      throw new TypeError(`${path}.${field} must be integer`);
    }
  }
  if (
    value.deadLetterQueue !== undefined &&
    (typeof value.deadLetterQueue !== "string" ||
      value.deadLetterQueue.length === 0)
  ) {
    throw new TypeError(`${path}.deadLetterQueue must be string`);
  }
}

function validateServiceImage(name: string, spec: PublicComputeSpec): void {
  if (
    typeof spec.image !== "string" || !IMAGE_DIGEST_PATTERN.test(spec.image)
  ) {
    throw new TypeError(
      `compute.${name}.image must be digest-pinned with sha256`,
    );
  }
  const port = spec.port;
  if (
    port === undefined || !Number.isInteger(port) || port < 1 || port > 65535
  ) {
    throw new TypeError(`compute.${name}.port must be integer 1..65535`);
  }
}

/**
 * @deprecated `compute.<name>.build.fromWorkflow` is being removed from the
 * manifest spec. Workflow / build pipeline concerns are owned by the
 * `takosumi-git` sibling product, which resolves the artifact and submits
 * a manifest carrying a digest-pinned URI directly. See
 * `docs/reference/architecture/workflow-extension-design.md` for the policy.
 * This validator will be deleted in a follow-up change.
 */
function validateWorkflowBuild(name: string, build: unknown): void {
  if (!isRecord(build) || !isRecord(build.fromWorkflow)) {
    throw new TypeError(`compute.${name}.build.fromWorkflow is required`);
  }
  assertKnownFields(
    build,
    new Set(["fromWorkflow"]),
    `compute.${name}.build`,
  );
  const workflow = build.fromWorkflow;
  assertKnownFields(
    workflow,
    new Set(["path", "job", "artifact", "artifactPath"]),
    `compute.${name}.build.fromWorkflow`,
  );
  for (const field of ["path", "job", "artifact"] as const) {
    if (typeof workflow[field] !== "string" || workflow[field].length === 0) {
      throw new TypeError(
        `compute.${name}.build.fromWorkflow.${field} must be string`,
      );
    }
  }
  const path = workflow.path as string;
  if (
    !path.startsWith(".takos/workflows/") || path.includes("..") ||
    path.endsWith("/")
  ) {
    throw new TypeError(
      `compute.${name}.build.fromWorkflow.path must be under .takos/workflows/`,
    );
  }
  if (workflow.artifactPath !== undefined) {
    if (
      typeof workflow.artifactPath !== "string" ||
      !isSafeRepositoryRelativePath(workflow.artifactPath)
    ) {
      throw new TypeError(
        `compute.${name}.build.fromWorkflow.artifactPath must be a repository relative path`,
      );
    }
  }
}

function validateResources(
  resources: Record<string, PublicResourceSpec>,
  computeNames: Set<string>,
): void {
  for (const [name, spec] of Object.entries(resources)) {
    if (!isRecord(spec)) {
      throw new TypeError(`resource.${name} must be an object`);
    }
    assertKnownFields(spec, RESOURCE_FIELDS, `resource.${name}`);
    if (typeof spec.type !== "string" || spec.type.length === 0) {
      throw new TypeError(`resource.${name}.type must be string`);
    }
    resourceContractRefFor(spec.type);
    validateStringRecord(spec.env, `resource.${name}.env`);
    for (const binding of resourceBindingsFor(name, spec)) {
      if (!computeNames.has(binding.compute)) {
        throw new TypeError(
          `resource.${name}.bindings references unknown compute '${binding.compute}'`,
        );
      }
    }
  }
}

function validateRoutes(
  routes: Record<string, PublicRouteSpec> | PublicRouteSpec[],
  compute: Record<string, PublicComputeSpec>,
): Map<string, PublicRouteSpec> {
  const computeNames = new Set(Object.keys(compute));
  const byName = new Map<string, PublicRouteSpec>();
  const seen: {
    readonly name: string;
    readonly target: string;
    readonly host?: string;
    readonly path?: string;
    readonly methods?: readonly string[];
  }[] = [];
  for (const [name, route] of namedCollectionEntries(routes, "route")) {
    if (byName.has(name)) {
      throw new TypeError(`route.${name} duplicates route id`);
    }
    if (!isRecord(route)) throw new TypeError(`route.${name} must be object`);
    assertKnownFields(route, ROUTE_FIELDS, `route.${name}`);
    const target = route.target;
    if (typeof target !== "string" || target.length === 0) {
      throw new TypeError(`route.${name} requires target compute`);
    }
    if (!computeNames.has(target)) {
      throw new TypeError(
        `route.${name} references unknown compute '${target}'`,
      );
    }
    if (route.source !== undefined && typeof route.source !== "string") {
      throw new TypeError(`route.${name}.source must be string`);
    }
    const protocol = normalizeRouteProtocol(route.protocol);
    const isHttpRoute = isHttpRouteProtocol(protocol);
    const isPortRoute = isPortProtocol(protocol);
    const isEventRoute = isEventRouteProtocol(protocol);
    if (isHttpRoute && typeof route.path !== "string") {
      throw new TypeError(`route.${name}.path must start with '/'`);
    }
    if (route.path !== undefined && typeof route.path !== "string") {
      throw new TypeError(`route.${name}.path must start with '/'`);
    }
    if (route.path !== undefined && !route.path.startsWith("/")) {
      throw new TypeError(`route.${name}.path must start with '/'`);
    }
    if ((isPortRoute || isEventRoute) && route.path !== undefined) {
      throw new TypeError(
        `route.${name}.path is only valid for http/https routes`,
      );
    }
    if (!isEventRoute && route.source !== undefined) {
      throw new TypeError(
        `route.${name}.source is only valid for queue/schedule/event routes`,
      );
    }
    const port = normalizeRoutePort(name, route.port);
    if (
      isPortRoute && port === undefined &&
      portForCompute(compute[target]) === undefined
    ) {
      throw new TypeError(
        `route.${name}.port or compute.${target}.port is required for ${protocol} routes`,
      );
    }
    if (isEventRoute && port !== undefined) {
      throw new TypeError(
        `route.${name}.port is only valid for http/https/tcp/udp routes`,
      );
    }
    const methods = normalizeRouteMethods(name, route.methods);
    if (!isHttpRoute && methods !== undefined) {
      throw new TypeError(
        `route.${name}.methods is only valid for http/https routes`,
      );
    }
    if (isHttpRoute) {
      for (const previous of seen) {
        if (
          previous.target === target && previous.host === route.host &&
          previous.path === route.path &&
          routeMethodsOverlap(previous.methods, methods)
        ) {
          throw new TypeError(
            `route.${name} duplicates target/path with route.${previous.name}`,
          );
        }
      }
      seen.push({ name, target, host: route.host, path: route.path, methods });
    }
    byName.set(name, route);
  }
  return byName;
}

function isHttpRouteProtocol(protocol: string | undefined): boolean {
  const normalized = normalizeRouteProtocol(protocol);
  return normalized === "http" || normalized === "https";
}

function isPortProtocol(protocol: string): boolean {
  return protocol === "tcp" || protocol === "udp";
}

function isEventRouteProtocol(protocol: string): boolean {
  return protocol === "queue" || protocol === "schedule" ||
    protocol === "event";
}

function normalizeRouteProtocol(protocol: string | undefined): string {
  const normalized = (protocol ?? "https").toLowerCase();
  interfaceContractRefFor(normalized);
  return normalized;
}

function normalizeRoutePort(
  routeName: string,
  port: unknown,
): number | undefined {
  if (port === undefined) return undefined;
  if (
    typeof port !== "number" || !Number.isInteger(port) || port < 1 ||
    port > 65535
  ) {
    throw new TypeError(`route.${routeName}.port must be integer 1..65535`);
  }
  return port;
}

function portForCompute(
  compute: PublicComputeSpec | undefined,
): number | undefined {
  return typeof compute?.port === "number" && Number.isInteger(compute.port)
    ? compute.port
    : undefined;
}

function normalizeRouteMethods(
  routeName: string,
  methods: string[] | undefined,
): readonly string[] | undefined {
  if (methods === undefined) return undefined;
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new TypeError(
      `route.${routeName}.methods must be non-empty string array`,
    );
  }
  const normalized = methods.map((method) => {
    if (typeof method !== "string" || method.length === 0) {
      throw new TypeError(`route.${routeName}.methods must be string array`);
    }
    const upper = method.toUpperCase();
    if (!HTTP_METHOD_PATTERN.test(upper)) {
      throw new TypeError(`route.${routeName}.methods contains invalid method`);
    }
    return upper;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`route.${routeName}.methods contains duplicate method`);
  }
  return normalized;
}

function routeMethodsOverlap(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (!left || !right) return true;
  const rightSet = new Set(right);
  return left.some((method) => rightSet.has(method));
}

function validateOutputs(
  outputs: Record<string, PublicOutputSpec> | PublicOutputSpec[],
  routes: Map<string, PublicRouteSpec>,
): void {
  for (const [name, output] of namedCollectionEntries(outputs, "output")) {
    if (!isRecord(output)) {
      throw new TypeError(`output.${name} must be object`);
    }
    assertKnownFields(output, OUTPUT_FIELDS, `output.${name}`);
    if (Array.isArray(outputs) && !output.name) {
      throw new TypeError(`output.${name}.name is required`);
    }
    if (typeof output.type !== "string" || output.type.length === 0) {
      throw new TypeError(`output.${name}.type must be string`);
    }
    outputContractRefFor(output.type);
    const routeRefs = outputRouteRefs(output);
    if (routeRefs.length === 0) {
      throw new TypeError(
        `output.${name} requires outputs.*.routeRef`,
      );
    }
    for (const routeRef of routeRefs) {
      const route = routes.get(routeRef);
      if (!route) {
        throw new TypeError(
          `output.${name} references unknown route '${routeRef}'`,
        );
      }
    }
  }
}

function outputRouteRefs(output: PublicOutputSpec): string[] {
  const refs: string[] = [];
  if (isRecord(output.outputs)) {
    for (const item of Object.values(output.outputs)) {
      if (!isRecord(item)) continue;
      const routeRef = item.routeRef;
      if (typeof routeRef === "string" && routeRef.length > 0) {
        refs.push(routeRef);
      }
    }
  }
  return refs;
}

function validateBindings(
  pathPrefix: string,
  bindings: Record<string, PublicComponentBindingSpec>,
  localEnv: Record<string, string>,
  inheritedEnv: Set<string>,
  options: Pick<
    CompileManifestOptions,
    "autoHostnameAvailable" | "localDevelopment"
  >,
): void {
  const injectedEnvNames = new Set(inheritedEnv);
  for (const name of normalizedEnvNameSet(localEnv, `${pathPrefix}.env`)) {
    if (injectedEnvNames.has(name)) {
      throw new TypeError(`${pathPrefix}.env collides with env '${name}'`);
    }
    injectedEnvNames.add(name);
  }
  for (const [bindingName, spec] of Object.entries(bindings)) {
    const path = `${pathPrefix}.bindings.${bindingName}`;
    validateBuiltinOutputRequest(path, spec, options);
    const inject = spec.inject;
    if (inject.mode === "env") {
      const normalized = normalizeEnvName(
        inject.target,
        `${path}.inject.target`,
      );
      if (injectedEnvNames.has(normalized)) {
        throw new TypeError(
          `${path}.inject collides with env '${normalized}'`,
        );
      }
      injectedEnvNames.add(normalized);
    }
  }
}

function validateAttachedContainerBindings(
  computeName: string,
  compute: PublicComputeSpec,
  inheritedEnv: Set<string>,
  options: Pick<
    CompileManifestOptions,
    "autoHostnameAvailable" | "localDevelopment"
  >,
): void {
  if (!isRecord(compute.containers)) return;
  for (const [containerName, container] of Object.entries(compute.containers)) {
    if (!isRecord(container)) continue;
    const bindings = isRecord(container.bindings)
      ? container.bindings as Record<string, PublicComponentBindingSpec>
      : {};
    validateBindings(
      `compute.${computeName}.containers.${containerName}`,
      bindings,
      isRecord(container.env) ? container.env as Record<string, string> : {},
      inheritedEnv,
      options,
    );
  }
}

function validateBuiltinOutputRequest(
  path: string,
  spec: PublicComponentBindingSpec,
  options: Pick<
    CompileManifestOptions,
    "autoHostnameAvailable" | "localDevelopment"
  >,
): void {
  const from = spec.from as { output?: string; request?: unknown };
  if (from.output === "takosumi.api-key") {
    if (!isRecord(from.request)) {
      throw new TypeError(`${path}.from.request is required`);
    }
    assertKnownFields(
      from.request,
      new Set(["scopes"]),
      `${path}.from.request`,
    );
    if (!isStringArray(from.request.scopes)) {
      throw new TypeError(`${path}.from.request.scopes must be string array`);
    }
  }
  if (from.output === "takosumi.oauth-client") {
    if (!isRecord(from.request)) {
      throw new TypeError(`${path}.from.request is required`);
    }
    assertKnownFields(
      from.request,
      new Set(["redirectUris", "scopes", "clientName", "metadata"]),
      `${path}.from.request`,
    );
    if (!isStringArray(from.request.redirectUris)) {
      throw new TypeError(
        `${path}.from.request.redirectUris must be string array`,
      );
    }
    for (const [index, redirectUri] of from.request.redirectUris.entries()) {
      validateOAuthRedirectUri(
        `${path}.from.request.redirectUris[${index}]`,
        redirectUri,
        options,
      );
    }
    if (!isStringArray(from.request.scopes)) {
      throw new TypeError(`${path}.from.request.scopes must be string array`);
    }
    if (from.request.metadata !== undefined) {
      if (!isRecord(from.request.metadata)) {
        throw new TypeError(`${path}.from.request.metadata must be object`);
      }
      assertKnownFields(
        from.request.metadata,
        new Set(["logoUri", "tosUri", "policyUri"]),
        `${path}.from.request.metadata`,
      );
    }
  }
}

function normalizedEnvNameSet(
  value: Record<string, string>,
  path: string,
): Set<string> {
  const names = new Set<string>();
  for (const name of Object.keys(value)) {
    const normalized = normalizeEnvName(name, path);
    if (names.has(normalized)) {
      throw new TypeError(`${path} contains duplicate env '${normalized}'`);
    }
    names.add(normalized);
  }
  return names;
}

function validateOAuthRedirectUri(
  path: string,
  redirectUri: string,
  options: Pick<
    CompileManifestOptions,
    "autoHostnameAvailable" | "localDevelopment"
  >,
): void {
  if (redirectUri.startsWith("/") && !redirectUri.startsWith("//")) {
    if (options.autoHostnameAvailable === true) return;
    throw new TypeError(
      `${path} relative path requires auto hostname context`,
    );
  }

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new TypeError(`${path} must be HTTPS absolute URL or relative path`);
  }
  if (url.protocol === "https:") return;
  if (
    url.protocol === "http:" && options.localDevelopment === true &&
    isLocalhostName(url.hostname)
  ) {
    return;
  }
  throw new TypeError(`${path} must be HTTPS absolute URL`);
}

function isLocalhostName(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost");
}

function inferComputeType(name: string, compute: PublicComputeSpec): string {
  if (compute.build !== undefined) return "js-worker";
  if (compute.image !== undefined) return "service";
  throw new TypeError(
    `compute.${name} requires type or an inferable build/image field`,
  );
}

function runtimeContractRefFor(type: string): string {
  const normalized = type.toLowerCase();
  if (
    normalized === "runtime.oci-container@v1" ||
    normalized === "https://takosumi.com/contracts/runtime/oci-container/v1"
  ) {
    return "runtime.oci-container@v1";
  }
  if (
    normalized === "runtime.js-worker@v1" ||
    normalized === "https://takosumi.com/contracts/runtime/js-worker/v1"
  ) {
    return "runtime.js-worker@v1";
  }
  if (
    normalized === "container" || normalized === "oci-container" ||
    normalized === "service"
  ) {
    return "runtime.oci-container@v1";
  }
  if (normalized === "js-worker" || normalized === "worker") {
    return "runtime.js-worker@v1";
  }
  throw new TypeError(`DescriptorAliasAmbiguous: compute type ${type}`);
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

function resourceContractRefFor(type: string): string {
  const normalized = type.toLowerCase();
  for (const contract of RESOURCE_CONTRACTS) {
    if (
      normalized === contract.ref ||
      normalized === contract.uri ||
      (contract.aliases as readonly string[]).includes(normalized)
    ) {
      return contract.ref;
    }
  }
  throw new TypeError(`DescriptorAliasAmbiguous: resource type ${type}`);
}

const RESOURCE_CONTRACTS = [
  {
    ref: "resource.sql.postgres@v1",
    uri: "https://takosumi.com/contracts/resource/sql/postgres/v1",
    aliases: ["postgres", "sql.postgres"],
    defaultAccessMode: "database-url",
  },
  {
    ref: "resource.sql.sqlite-serverless@v1",
    uri: "https://takosumi.com/contracts/resource/sql/sqlite-serverless/v1",
    aliases: ["sql", "sqlite", "sql.sqlite-serverless"],
    defaultAccessMode: "sql-runtime-binding",
  },
  {
    ref: "resource.object-store.s3@v1",
    uri: "https://takosumi.com/contracts/resource/object-store/s3/v1",
    aliases: ["object-store", "s3", "object-store.s3"],
    defaultAccessMode: "object-runtime-binding",
  },
  {
    ref: "resource.key-value@v1",
    uri: "https://takosumi.com/contracts/resource/key-value/v1",
    aliases: ["key-value", "kv"],
    defaultAccessMode: "kv-runtime-binding",
  },
  {
    ref: "resource.queue.at-least-once@v1",
    uri: "https://takosumi.com/contracts/resource/queue/at-least-once/v1",
    aliases: ["queue", "queue.at-least-once"],
    defaultAccessMode: "queue-runtime-binding",
  },
  {
    ref: "resource.secret@v1",
    uri: "https://takosumi.com/contracts/resource/secret/v1",
    aliases: ["secret"],
    defaultAccessMode: "secret-env-binding",
  },
  {
    ref: "resource.vector-index@v1",
    uri: "https://takosumi.com/contracts/resource/vector-index/v1",
    aliases: ["vector-index"],
    defaultAccessMode: "vector-runtime-binding",
  },
  {
    ref: "resource.analytics-engine@v1",
    uri: "https://takosumi.com/contracts/resource/analytics-engine/v1",
    aliases: ["analytics-engine"],
    defaultAccessMode: "analytics-runtime-binding",
  },
  {
    ref: "resource.workflow@v1",
    uri: "https://takosumi.com/contracts/resource/workflow/v1",
    aliases: ["workflow"],
    defaultAccessMode: "workflow-runtime-binding",
  },
  {
    ref: "resource.durable-object@v1",
    uri: "https://takosumi.com/contracts/resource/durable-object/v1",
    aliases: ["durable-object"],
    defaultAccessMode: "durable-object-runtime-binding",
  },
] as const;

function resourceDefaultAccessModeFor(resourceContractRef: string): string {
  const contract = RESOURCE_CONTRACTS.find((item) =>
    item.ref === resourceContractRef
  );
  if (!contract) {
    throw new TypeError(
      `DescriptorAliasAmbiguous: resource type ${resourceContractRef}`,
    );
  }
  return contract.defaultAccessMode;
}

function resourceBindingsByComputeFor(
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

function resourceBindingsFor(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const item = value[field];
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new TypeError(`${path} must not include '${field}'`);
    }
  }
}

function validateStringRecord(
  value: unknown,
  path: string,
): asserts value is Record<string, string> | undefined {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be object`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new TypeError(`${path}.${key} must be string`);
    }
  }
}

function normalizeEnvName(value: string, path: string): string {
  if (!ENV_NAME_PATTERN.test(value)) {
    throw new TypeError(`${path} must match [A-Za-z_][A-Za-z0-9_]*`);
  }
  return value.toUpperCase();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0);
}

function isSafeRepositoryRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.startsWith("\\")) {
    return false;
  }
  return !value.split(/[\\/]+/).some((part) => part === ".." || part === "");
}

function interfaceContractRefFor(protocol: string | undefined): string {
  const normalized = (protocol ?? "https").toLowerCase();
  if (normalized === "http" || normalized === "https") {
    return "interface.http@v1";
  }
  if (normalized === "tcp") return "interface.tcp@v1";
  if (normalized === "udp") return "interface.udp@v1";
  if (normalized === "queue") return "interface.queue@v1";
  if (normalized === "schedule") return "interface.schedule@v1";
  if (normalized === "event") return "interface.event@v1";
  throw new TypeError(`RouterProtocolUnsupported: ${normalized}`);
}

function outputContractRefFor(type: string): string {
  const normalized = type.toLowerCase();
  if (
    normalized === "output.http-endpoint@v1" ||
    normalized === "https://takosumi.com/contracts/output/http-endpoint/v1"
  ) {
    return "output.http-endpoint@v1";
  }
  if (
    normalized === "output.mcp-server@v1" ||
    normalized === "https://takosumi.com/contracts/output/mcp-server/v1"
  ) {
    return "output.mcp-server@v1";
  }
  if (
    normalized === "output.topic@v1" ||
    normalized === "https://takosumi.com/contracts/output/topic/v1"
  ) {
    return "output.topic@v1";
  }
  throw new TypeError(`DescriptorAliasAmbiguous: output type ${type}`);
}
