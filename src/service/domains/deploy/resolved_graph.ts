// ResolvedGraph projection builder for Deployment.resolution.resolved_graph.
//
// Phase 10B (Wave 2): the descriptor closure pinned by Wave 1 is consumed here
// to emit the six canonical projection families that controllers read instead
// of re-interpreting raw descriptors. Per Space contract spec § 8 the projection
// types are deterministic compiler outputs; the wire shape per record is
// `CoreProjectionRecord` (Space spec § 8 / `paas-contract/takosumi-v1.ts`).
//
// Six projection families produced from the resolved InternalDeploySpec:
//   1. runtime-claim          — every component's runtime contract instance
//   2. resource-claim         — every declared resource
//   3. exposure-target        — component contracts that opt-in via descriptor
//                               (e.g. `interface.http@v1` whose
//                               `exposureEligible=true`)
//   4. output-declaration     — every entry in manifest.outputs[]
//   5. binding-request        — every component bindings declaration
//                               (resource / output / secret / provider-output)
//   6. access-path-request    — network boundary request per resource binding
//                               (Space spec § 12: ResourceAccessPath)
//
// Determinism contract: identical InternalDeploySpec + descriptor closure inputs MUST
// yield byte-identical projection records, in byte-identical order. Apply
// reuses these projections without re-deriving them, so the digest is the
// resolution-time witness consumed by Group head + read-set checks.

// Round-2 fix: removed `createHash` from `node:crypto`. Web Crypto's
// `crypto.subtle.digest` is async-only on every runtime the service targets,
// so `buildResolvedGraph` and the per-projection builders are now async.
// The caller (`resolution_pipeline.ts`) was already inside `async
// resolveDeploymentWithMode`, so the propagation is local.
import { sha256HexOfStringAsync } from "../../shared/runtime/hash.ts";
import { objectAddress } from "takosumi-contract/reference/compat";
import type {
  CoreComponent,
  CoreContractInstance,
  CoreProjectionRecord,
  DeploymentDescriptorClosure,
  DeploymentResolvedGraph,
  Digest,
  IsoTimestamp,
  JsonObject,
  ObjectAddress,
} from "takosumi-contract/reference/compat";
import type {
  InternalDeploySpec,
  InternalDeploySpecComponent,
  InternalDeploySpecOutput,
  InternalDeploySpecResource,
  InternalDeploySpecRoute,
  PublicComponentBindingSpec,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Input bundle for `buildResolvedGraph`. */
export interface BuildResolvedGraphInput {
  readonly deploySpec: InternalDeploySpec;
  readonly descriptorClosure: DeploymentDescriptorClosure;
  /** Manifest snapshot digest (folded into the resolved-graph digest). */
  readonly manifestSnapshot?: string;
}

/** Build the canonical `DeploymentResolvedGraph` for a resolved Deployment.
 *
 *  The returned graph carries the six projection families described above and
 *  pre-computed digests for the InternalDeploySpec and operator resolution inputs. The
 *  graph digest is a sha256 over the canonical-stringified projections plus
 *  source snapshot + closure digest, so two resolutions with identical
 *  manifests + closures always produce identical graph digests.
 */
export async function buildResolvedGraph(
  input: BuildResolvedGraphInput,
): Promise<DeploymentResolvedGraph> {
  const closureIndex = indexClosure(input.descriptorClosure);
  const components = await Promise.all(
    input.deploySpec.components.map((component) =>
      buildCoreComponent(component, input.deploySpec.routes, closureIndex)
    ),
  );

  const projections: CoreProjectionRecord[] = [];
  for (const component of input.deploySpec.components) {
    projections.push(
      await buildRuntimeClaim(component, input.deploySpec, closureIndex),
    );
    projections.push(
      ...(await buildExposureTargets(
        component,
        input.deploySpec.routes,
        closureIndex,
      )),
    );
    projections.push(...(await buildBindingRequests(component, closureIndex)));
  }
  for (const resource of input.deploySpec.resources) {
    projections.push(await buildResourceClaim(resource, closureIndex));
  }
  for (const output of input.deploySpec.outputs) {
    projections.push(
      await buildOutputDeclaration(input.deploySpec, output, closureIndex),
    );
  }
  for (
    const access of await buildAccessPathRequests(input.deploySpec, closureIndex)
  ) {
    projections.push(access);
  }

  // Sort for deterministic ordering. Type then objectAddress yields a stable
  // family-grouped output that survives manifest re-ordering.
  projections.sort((left, right) => {
    const cmp = left.projectionType.localeCompare(right.projectionType);
    return cmp !== 0
      ? cmp
      : left.objectAddress.localeCompare(right.objectAddress);
  });

  const deploySpecDigest = await digestOf(input.deploySpec);
  const envSpecDigest = await digestOf({
    env: input.deploySpec.env,
    runtimeNetworkPolicy: runtimeNetworkPolicyInput(input.deploySpec),
  });
  const policySpecDigest = await digestOf(policyInput(input.deploySpec));

  const digest = await digestOf({
    manifestSnapshot: input.manifestSnapshot ?? null,
    closureDigest: input.descriptorClosure.closureDigest,
    components: components.map(componentFingerprint),
    projections,
  });

  return {
    digest,
    components,
    projections,
    deploySpecDigest,
    envSpecDigest,
    policySpecDigest,
  };
}

// ---------------------------------------------------------------------------
// Closure indexing
// ---------------------------------------------------------------------------

interface ClosureIndex {
  readonly resolveByAlias: Map<string, string>;
  readonly resolveById: Set<string>;
}

function indexClosure(closure: DeploymentDescriptorClosure): ClosureIndex {
  const resolveByAlias = new Map<string, string>();
  const resolveById = new Set<string>();
  for (const resolution of closure.resolutions) {
    resolveById.add(resolution.id);
    if (resolution.alias && !resolveByAlias.has(resolution.alias)) {
      resolveByAlias.set(resolution.alias, resolution.id);
    }
  }
  return { resolveByAlias, resolveById };
}

/** Resolve a descriptor alias-or-URI to its closure resolution id. Falls back
 *  to the input ref when the closure has no entry (e.g. plugin descriptor
 *  shipped out-of-tree); the caller still produces a deterministic projection
 *  record because the closure builder always emits a synthetic resolution for
 *  unknown aliases. */
function descriptorIdFor(ref: string, closure: ClosureIndex): string {
  if (closure.resolveById.has(ref)) return ref;
  const aliasHit = closure.resolveByAlias.get(ref);
  if (aliasHit) return aliasHit;
  return ref;
}

// ---------------------------------------------------------------------------
// CoreComponent construction
// ---------------------------------------------------------------------------

async function buildCoreComponent(
  component: InternalDeploySpecComponent,
  routes: readonly InternalDeploySpecRoute[],
  closure: ClosureIndex,
): Promise<CoreComponent> {
  const componentAddr = componentAddress(component.name);
  const runtime = await contractInstanceFor({
    componentName: component.name,
    localName: "runtime",
    descriptorRef: component.type,
    closure,
    config: {
      image: component.image,
      port: component.port,
      entrypoint: component.entrypoint,
      command: component.command,
      args: component.args,
      env: component.env,
      requirements: component.requirements,
    },
    lifecycleDomain: "runtime",
  });
  const instances: CoreContractInstance[] = [runtime];
  if (usesSourceJsModule(component)) {
    instances.push(
      await contractInstanceFor({
        componentName: component.name,
        localName: "source",
        descriptorRef: "source.js-module@v1",
        closure,
        config: sourceJsModuleConfigFor(component),
        lifecycleDomain: "source",
      }),
    );
  }
  if (component.image) {
    instances.push(
      await contractInstanceFor({
        componentName: component.name,
        localName: "runtime-input",
        descriptorRef: "runtime-input.oci-image@v1",
        closure,
        config: runtimeInputOciImageConfigFor(component.image),
        lifecycleDomain: "runtime-input",
      }),
    );
  }
  for (const route of routes.filter((route) => route.to === component.name)) {
    const localName = routeInterfaceLocalName(route);
    instances.push(
      await contractInstanceFor({
        componentName: component.name,
        localName,
        descriptorRef: routeInterfaceRef(route),
        closure,
        config: {
          route: route.name,
          protocol: route.protocol,
          host: route.host,
          path: route.path,
          port: route.port ?? null,
          targetPort: route.targetPort ?? component.port ?? null,
          source: route.source,
        },
        lifecycleDomain: "interface",
      }),
    );
  }
  return {
    address: componentAddr,
    contractInstances: instances,
    shapeRefs: [component.type],
  };
}

async function contractInstanceFor(input: {
  readonly componentName: string;
  readonly localName: string;
  readonly descriptorRef: string;
  readonly closure: ClosureIndex;
  readonly config: unknown;
  readonly lifecycleDomain: string;
}): Promise<CoreContractInstance> {
  const descriptorId = descriptorIdFor(input.descriptorRef, input.closure);
  return {
    address: objectAddress(
      "contract",
      `${input.componentName}.${input.localName}`,
    ),
    localName: input.localName,
    descriptorId,
    descriptorDigest: await digestOf({ descriptor: descriptorId }),
    configDigest: await digestOf(input.config),
    lifecycleDomain: input.lifecycleDomain,
  };
}

function usesSourceJsModule(component: InternalDeploySpecComponent): boolean {
  return component.type === "runtime.js-worker@v1" && !component.image;
}

function sourceJsModuleConfigFor(component: InternalDeploySpecComponent): JsonObject {
  return {
    bundleFormat: "esm",
    ...(component.entrypoint ? { entrypoint: component.entrypoint } : {}),
  };
}

function runtimeInputOciImageConfigFor(image: string): JsonObject {
  const digest = ociImageDigest(image);
  return {
    image,
    ...(digest ? { digest } : {}),
  };
}

function ociImageDigest(image: string): string | undefined {
  const match = /@([A-Za-z][A-Za-z0-9_+.-]*:[0-9A-Fa-f]+)$/.exec(image);
  return match?.[1];
}

function routeInterfaceLocalName(route: InternalDeploySpecRoute): string {
  return `interface.${route.name}`;
}

function routeInterfaceRef(route: InternalDeploySpecRoute): string {
  const explicit = (route as InternalDeploySpecRoute & { interfaceContractRef?: string })
    .interfaceContractRef;
  if (explicit) return explicit;
  const protocol = route.protocol.toLowerCase();
  if (protocol === "http" || protocol === "https") return "interface.http@v1";
  if (protocol === "tcp") return "interface.tcp@v1";
  if (protocol === "udp") return "interface.udp@v1";
  if (protocol === "queue") return "interface.queue@v1";
  return "interface.http@v1";
}

// ---------------------------------------------------------------------------
// Projection 1: runtime claim
// ---------------------------------------------------------------------------

async function buildRuntimeClaim(
  component: InternalDeploySpecComponent,
  deploySpec: InternalDeploySpec,
  closure: ClosureIndex,
): Promise<CoreProjectionRecord> {
  const descriptorId = descriptorIdFor(component.type, closure);
  return {
    projectionType: "runtime-claim",
    objectAddress: objectAddress("runtime.claim", component.name),
    sourceComponentAddress: componentAddress(component.name),
    sourceContractInstance: "runtime",
    descriptorResolutionId: descriptorId,
    digest: await digestOf({
      kind: "runtime-claim",
      component: component.name,
      descriptor: descriptorId,
      image: component.image ?? null,
      port: component.port ?? null,
      entrypoint: component.entrypoint ?? null,
      command: component.command ?? null,
      args: component.args ?? null,
      requirements: component.requirements ?? null,
      effectiveRuntimeCapabilities:
        deploySpec.effectiveRuntimeCapabilities?.[component.name] ?? null,
    }),
  };
}

// ---------------------------------------------------------------------------
// Projection 2: resource claim
// ---------------------------------------------------------------------------

async function buildResourceClaim(
  resource: InternalDeploySpecResource,
  closure: ClosureIndex,
): Promise<CoreProjectionRecord> {
  const descriptorId = descriptorIdFor(resource.type, closure);
  // Resource claims are component-agnostic but spec mandates a
  // `sourceComponentAddress`; we use the resource address itself so the field
  // is non-empty and uniquely identifies the claim source. Apply binds
  // resource→component edges via the binding-request projection instead.
  const claimAddr = objectAddress("resource.claim", resource.name);
  const sourceAddr = objectAddress("resource", resource.name);
  return {
    projectionType: "resource-claim",
    objectAddress: claimAddr,
    sourceComponentAddress: sourceAddr,
    sourceContractInstance: "resource",
    descriptorResolutionId: descriptorId,
    digest: await digestOf({
      kind: "resource-claim",
      resource: resource.name,
      descriptor: descriptorId,
      env: resource.env,
      previousNames: previousNames(resource.raw),
      nativeFeatures: nativeFeatures(resource.raw),
    }),
  };
}

// ---------------------------------------------------------------------------
// Projection 3: exposure target
// ---------------------------------------------------------------------------

async function buildExposureTargets(
  component: InternalDeploySpecComponent,
  routes: readonly InternalDeploySpecRoute[],
  closure: ClosureIndex,
): Promise<readonly CoreProjectionRecord[]> {
  return await Promise.all(
    routes.filter((route) => route.to === component.name).map(async (route) => {
      const descriptorRef = routeInterfaceRef(route);
      const descriptorId = descriptorIdFor(descriptorRef, closure);
      const localName = routeInterfaceLocalName(route);
      const exposureName = exposureNameFor(component.name, route.name);
      return {
        projectionType: "exposure-target",
        objectAddress: objectAddress("app.exposure", exposureName),
        sourceComponentAddress: componentAddress(component.name),
        sourceContractInstance: localName,
        descriptorResolutionId: descriptorId,
        digest: await digestOf({
          kind: "exposure-target",
          component: component.name,
          route: route.name,
          protocol: route.protocol,
          contractInstance: localName,
          descriptor: descriptorId,
          host: route.host ?? null,
          path: route.path ?? null,
          port: route.port ?? null,
          targetPort: route.targetPort ?? component.port ?? null,
          source: route.source ?? null,
        }),
      };
    }),
  );
}

function exposureNameFor(component: string, instance: string): string {
  return `${component}/${instance}`;
}

// ---------------------------------------------------------------------------
// Projection 4: output declaration
// ---------------------------------------------------------------------------

async function buildOutputDeclaration(
  deploySpec: InternalDeploySpec,
  output: InternalDeploySpecOutput,
  closure: ClosureIndex,
): Promise<CoreProjectionRecord> {
  const descriptorId = descriptorIdFor(output.type, closure);
  const owner = output.from ?? deploySpec.components[0]?.name ?? "group";
  const outputName = outputFullName(deploySpec.groupId, output.name);
  return {
    projectionType: "output-declaration",
    objectAddress: objectAddress("output", outputName),
    sourceComponentAddress: componentAddress(owner),
    sourceContractInstance: "runtime",
    descriptorResolutionId: descriptorId,
    digest: await digestOf({
      kind: "output-declaration",
      group: deploySpec.groupId,
      name: output.name,
      from: output.from ?? null,
      descriptor: descriptorId,
      outputs: output.outputs,
      spec: output.spec,
    }),
  };
}

function outputFullName(group: string, name: string): string {
  return `${group}/${name}`;
}

// ---------------------------------------------------------------------------
// Projection 5: binding request
// ---------------------------------------------------------------------------

async function buildBindingRequests(
  component: InternalDeploySpecComponent,
  closure: ClosureIndex,
): Promise<readonly CoreProjectionRecord[]> {
  const records: CoreProjectionRecord[] = [];
  for (const [bindingName, spec] of Object.entries(component.bindings)) {
    const sourceKind = bindingSourceFor(spec);
    const sourceName = bindingSourceName(spec);
    const descriptorRef = bindingDescriptorRef(sourceKind, spec);
    const descriptorId = descriptorIdFor(descriptorRef, closure);
    const bindingFullName = `${component.name}/${bindingName}`;
    records.push({
      projectionType: "binding-request",
      objectAddress: objectAddress("app.binding", bindingFullName),
      sourceComponentAddress: componentAddress(component.name),
      sourceContractInstance: "runtime",
      descriptorResolutionId: descriptorId,
      digest: await digestOf({
        kind: "binding-request",
        component: component.name,
        envBinding: bindingName,
        sourceKind,
        sourceName,
        access: accessFor(spec),
        injection: spec.inject,
        descriptor: descriptorId,
      }),
    });
  }
  return records;
}

function bindingSourceFor(spec: PublicComponentBindingSpec): BindingSource {
  const from = spec.from;
  if ("resource" in from) return "resource";
  if ("output" in from) return "output";
  if ("secret" in from) return "secret";
  return "provider-output";
}

type BindingSource =
  | "resource"
  | "output"
  | "secret"
  | "provider-output";

function bindingSourceName(spec: PublicComponentBindingSpec): string {
  const from = spec.from;
  if ("resource" in from) return from.resource;
  if ("output" in from) return from.output;
  if ("secret" in from) return from.secret;
  return from.providerOutput;
}

function bindingDescriptorRef(
  source: BindingSource,
  spec: PublicComponentBindingSpec,
): string {
  const from = spec.from as { access?: unknown };
  const access = from.access;
  if (typeof access === "object" && access !== null && !Array.isArray(access)) {
    const contract = (access as Record<string, unknown>).contract;
    if (typeof contract === "string" && contract.length > 0) return contract;
  }
  return `binding.${source}@v1`;
}

function accessFor(spec: PublicComponentBindingSpec): JsonObject | null {
  const from = spec.from as { access?: unknown };
  const access = from.access;
  if (
    typeof access === "object" && access !== null && !Array.isArray(access)
  ) {
    return access as JsonObject;
  }
  if (typeof access === "string") return { mode: access };
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function previousNames(raw: Record<string, unknown>): readonly unknown[] {
  const generate = isRecord(raw.generate) ? raw.generate : {};
  const value = raw.previousNames ?? raw.previous_names ??
    generate.previousNames ?? generate.previous_names;
  return Array.isArray(value) ? structuredClone(value) : [];
}

function nativeFeatures(raw: Record<string, unknown>): readonly string[] {
  const generate = isRecord(raw.generate) ? raw.generate : {};
  return [
    ...stringArray(raw.features),
    ...stringArray(raw.nativeFeatures),
    ...stringArray(raw.providerNativeFeatures),
    ...stringArray(raw.extensions),
    ...stringArray(generate.features),
    ...stringArray(generate.nativeFeatures),
    ...stringArray(generate.providerNativeFeatures),
    ...stringArray(generate.extensions),
  ].sort();
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string =>
      typeof item === "string" && item.length > 0
    )
    : [];
}

// ---------------------------------------------------------------------------
// Projection 6: access path request
// ---------------------------------------------------------------------------

async function buildAccessPathRequests(
  deploySpec: InternalDeploySpec,
  closure: ClosureIndex,
): Promise<readonly CoreProjectionRecord[]> {
  const records: CoreProjectionRecord[] = [];
  for (const component of deploySpec.components) {
    for (const [_bindingName, spec] of Object.entries(component.bindings)) {
      const source = bindingSourceFor(spec);
      // Only resource / output bindings need a network-boundary access path;
      // secrets and provider-outputs are control-plane delivered.
      if (source !== "resource" && source !== "output") continue;
      const sourceName = bindingSourceName(spec);
      const target = source === "resource"
        ? sourceName
        : sourceName.split("/").at(-1) ?? sourceName;
      const accessRef = bindingDescriptorRef(source, spec);
      const descriptorId = descriptorIdFor(accessRef, closure);
      const networkBoundary: "internal" | "external" = source === "output"
        ? "external"
        : "internal";
      const fullName = `${target}/${component.name}`;
      records.push({
        projectionType: "access-path-request",
        objectAddress: objectAddress("resource.access", fullName),
        sourceComponentAddress: componentAddress(component.name),
        sourceContractInstance: "runtime",
        descriptorResolutionId: descriptorId,
        digest: await digestOf({
          kind: "access-path-request",
          component: component.name,
          target,
          source,
          networkBoundary,
          access: accessFor(spec),
          descriptor: descriptorId,
        }),
      });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function componentAddress(name: string): ObjectAddress {
  return objectAddress("component", name);
}

function componentFingerprint(component: CoreComponent): JsonObject {
  return {
    address: component.address,
    shapeRefs: [...(component.shapeRefs ?? [])],
    instances: component.contractInstances.map((instance) => ({
      address: instance.address,
      localName: instance.localName,
      descriptorId: instance.descriptorId,
      descriptorDigest: instance.descriptorDigest,
      configDigest: instance.configDigest ?? null,
      lifecycleDomain: instance.lifecycleDomain ?? null,
    })),
  };
}

function runtimeNetworkPolicyInput(deploySpec: InternalDeploySpec): unknown {
  const overrides = deploySpec.overrides;
  const value = overrides.runtimeNetworkPolicy;
  return value ?? {};
}

function policyInput(deploySpec: InternalDeploySpec): unknown {
  const overrides = deploySpec.overrides;
  if (
    typeof overrides === "object" && overrides !== null &&
    !Array.isArray(overrides) &&
    typeof (overrides as Record<string, unknown>).approvals === "object"
  ) {
    return { approvals: (overrides as Record<string, unknown>).approvals };
  }
  return {};
}

async function digestOf(value: unknown): Promise<Digest> {
  const hex = await sha256HexOfStringAsync(stableStringify(value));
  return `sha256:${hex}`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${
      Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${stableStringify(object[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

// Surface used by routes to attach a route exposure projection. We keep the
// existing route-derived projection in `deployment_service.ts` (Wave 1) since
// it is downstream of the InternalDeploySpec route shape rather than part of the six
// canonical families. Future waves may collapse it into `exposure-target`
// once router materialisation moves into ResolvedGraph.
export const RESOLVED_GRAPH_PROJECTION_TYPES = [
  "runtime-claim",
  "resource-claim",
  "exposure-target",
  "output-declaration",
  "binding-request",
  "access-path-request",
] as const;

export type ResolvedGraphProjectionType =
  typeof RESOLVED_GRAPH_PROJECTION_TYPES[number];

// IsoTimestamp re-exported for callers that thread resolution timestamps.
export type { IsoTimestamp };
