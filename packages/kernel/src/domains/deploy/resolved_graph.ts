// ResolvedGraph projection builder for Deployment.resolution.resolved_graph.
//
// Phase 10B (Wave 2): the descriptor closure pinned by Wave 1 is consumed here
// to emit the six canonical projection families that controllers read instead
// of re-interpreting raw descriptors. Per Core contract spec § 8 the projection
// types are deterministic compiler outputs; the wire shape per record is
// `CoreProjectionRecord` (Core spec § 8 / `paas-contract/core-v1.ts`).
//
// Six projection families produced from the resolved AppSpec:
//   1. runtime-claim          — every component's runtime contract instance
//   2. resource-claim         — every declared resource
//   3. exposure-target        — component contracts that opt-in via descriptor
//                               (e.g. `interface.http@v1` whose
//                               `exposureEligible=true`)
//   4. output-declaration     — every entry in manifest.outputs[]
//   5. binding-request        — every component bindings declaration
//                               (resource / output / secret / provider-output)
//   6. access-path-request    — network boundary request per resource binding
//                               (Core spec § 12: ResourceAccessPath)
//
// Determinism contract: identical AppSpec + descriptor closure inputs MUST
// yield byte-identical projection records, in byte-identical order. Apply
// reuses these projections without re-deriving them, so the digest is the
// resolution-time witness consumed by Group head + read-set checks.

import { createHash } from "node:crypto";
import { objectAddress } from "takosumi-contract";
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
} from "takosumi-contract";
import type {
  AppSpec,
  AppSpecComponent,
  AppSpecOutput,
  AppSpecResource,
  AppSpecRoute,
  PublicComponentBindingSpec,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Input bundle for `buildResolvedGraph`. */
export interface BuildResolvedGraphInput {
  readonly appSpec: AppSpec;
  readonly descriptorClosure: DeploymentDescriptorClosure;
  /** Manifest snapshot digest (folded into the resolved-graph digest). */
  readonly manifestSnapshot?: string;
}

/** Build the canonical `DeploymentResolvedGraph` for a resolved Deployment.
 *
 *  The returned graph carries the six projection families described above and
 *  pre-computed digests for the AppSpec / EnvSpec / PolicySpec inputs. The
 *  graph digest is a sha256 over the canonical-stringified projections plus
 *  manifest snapshot + closure digest, so two resolutions with identical
 *  manifests + closures always produce identical graph digests.
 */
export function buildResolvedGraph(
  input: BuildResolvedGraphInput,
): DeploymentResolvedGraph {
  const closureIndex = indexClosure(input.descriptorClosure);
  const components = input.appSpec.components.map((component) =>
    buildCoreComponent(component, input.appSpec.routes, closureIndex)
  );

  const projections: CoreProjectionRecord[] = [];
  for (const component of input.appSpec.components) {
    projections.push(buildRuntimeClaim(component, input.appSpec, closureIndex));
    projections.push(
      ...buildExposureTargets(component, input.appSpec.routes, closureIndex),
    );
    projections.push(...buildBindingRequests(component, closureIndex));
  }
  for (const resource of input.appSpec.resources) {
    projections.push(buildResourceClaim(resource, closureIndex));
  }
  for (const output of input.appSpec.outputs) {
    projections.push(
      buildOutputDeclaration(input.appSpec, output, closureIndex),
    );
  }
  for (const access of buildAccessPathRequests(input.appSpec, closureIndex)) {
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

  const appSpecDigest = digestOf(input.appSpec);
  const envSpecDigest = digestOf({
    env: input.appSpec.env,
    runtimeNetworkPolicy: runtimeNetworkPolicyInput(input.appSpec),
  });
  const policySpecDigest = digestOf(policyInput(input.appSpec));

  const digest = digestOf({
    manifestSnapshot: input.manifestSnapshot ?? null,
    closureDigest: input.descriptorClosure.closureDigest,
    components: components.map(componentFingerprint),
    projections,
  });

  return {
    digest,
    components,
    projections,
    appSpecDigest,
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

function buildCoreComponent(
  component: AppSpecComponent,
  routes: readonly AppSpecRoute[],
  closure: ClosureIndex,
): CoreComponent {
  const componentAddr = componentAddress(component.name);
  const runtime = contractInstanceFor({
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
  if (component.image) {
    instances.push(contractInstanceFor({
      componentName: component.name,
      localName: "artifact",
      descriptorRef: "artifact.oci-image@v1",
      closure,
      config: { image: component.image },
      lifecycleDomain: "artifact",
    }));
  }
  for (const route of routes.filter((route) => route.to === component.name)) {
    const localName = routeInterfaceLocalName(route);
    instances.push(contractInstanceFor({
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
    }));
  }
  return {
    address: componentAddr,
    contractInstances: instances,
    shapeRefs: [component.type],
  };
}

function contractInstanceFor(input: {
  readonly componentName: string;
  readonly localName: string;
  readonly descriptorRef: string;
  readonly closure: ClosureIndex;
  readonly config: unknown;
  readonly lifecycleDomain: string;
}): CoreContractInstance {
  const descriptorId = descriptorIdFor(input.descriptorRef, input.closure);
  return {
    address: objectAddress(
      "contract",
      `${input.componentName}.${input.localName}`,
    ),
    localName: input.localName,
    descriptorId,
    descriptorDigest: digestOf({ descriptor: descriptorId }),
    configDigest: digestOf(input.config),
    lifecycleDomain: input.lifecycleDomain,
  };
}

function routeInterfaceLocalName(route: AppSpecRoute): string {
  return `interface.${route.name}`;
}

function routeInterfaceRef(route: AppSpecRoute): string {
  const explicit = (route as AppSpecRoute & { interfaceContractRef?: string })
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

function buildRuntimeClaim(
  component: AppSpecComponent,
  appSpec: AppSpec,
  closure: ClosureIndex,
): CoreProjectionRecord {
  const descriptorId = descriptorIdFor(component.type, closure);
  return {
    projectionType: "runtime-claim",
    objectAddress: objectAddress("runtime.claim", component.name),
    sourceComponentAddress: componentAddress(component.name),
    sourceContractInstance: "runtime",
    descriptorResolutionId: descriptorId,
    digest: digestOf({
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
        appSpec.effectiveRuntimeCapabilities?.[component.name] ?? null,
    }),
  };
}

// ---------------------------------------------------------------------------
// Projection 2: resource claim
// ---------------------------------------------------------------------------

function buildResourceClaim(
  resource: AppSpecResource,
  closure: ClosureIndex,
): CoreProjectionRecord {
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
    digest: digestOf({
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

function buildExposureTargets(
  component: AppSpecComponent,
  routes: readonly AppSpecRoute[],
  closure: ClosureIndex,
): readonly CoreProjectionRecord[] {
  return routes.filter((route) => route.to === component.name).map((route) => {
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
      digest: digestOf({
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
  });
}

function exposureNameFor(component: string, instance: string): string {
  return `${component}/${instance}`;
}

// ---------------------------------------------------------------------------
// Projection 4: output declaration
// ---------------------------------------------------------------------------

function buildOutputDeclaration(
  appSpec: AppSpec,
  output: AppSpecOutput,
  closure: ClosureIndex,
): CoreProjectionRecord {
  const descriptorId = descriptorIdFor(output.type, closure);
  const owner = output.from ?? appSpec.components[0]?.name ?? "group";
  const outputName = outputFullName(appSpec.groupId, output.name);
  return {
    projectionType: "output-declaration",
    objectAddress: objectAddress("output", outputName),
    sourceComponentAddress: componentAddress(owner),
    sourceContractInstance: "runtime",
    descriptorResolutionId: descriptorId,
    digest: digestOf({
      kind: "output-declaration",
      group: appSpec.groupId,
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

function buildBindingRequests(
  component: AppSpecComponent,
  closure: ClosureIndex,
): readonly CoreProjectionRecord[] {
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
      digest: digestOf({
        kind: "binding-request",
        component: component.name,
        envBinding: bindingName,
        sourceKind,
        sourceName,
        access: accessFor(spec),
        injection: spec.inject as unknown as JsonObject,
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
  if ("import" in from) return "service-import";
  return "provider-output";
}

type BindingSource =
  | "resource"
  | "output"
  | "secret"
  | "provider-output"
  | "service-import";

function bindingSourceName(spec: PublicComponentBindingSpec): string {
  const from = spec.from;
  if ("resource" in from) return from.resource;
  if ("output" in from) return from.output;
  if ("secret" in from) return from.secret;
  if ("import" in from) {
    return `${from.import}/${from.endpointRole}/${from.field}`;
  }
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

function buildAccessPathRequests(
  appSpec: AppSpec,
  closure: ClosureIndex,
): readonly CoreProjectionRecord[] {
  const records: CoreProjectionRecord[] = [];
  for (const component of appSpec.components) {
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
        digest: digestOf({
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

function runtimeNetworkPolicyInput(appSpec: AppSpec): unknown {
  const overrides = appSpec.overrides;
  const value = overrides.runtimeNetworkPolicy;
  return value ?? {};
}

function policyInput(appSpec: AppSpec): unknown {
  const overrides = appSpec.overrides;
  if (
    typeof overrides === "object" && overrides !== null &&
    !Array.isArray(overrides) &&
    typeof (overrides as Record<string, unknown>).approvals === "object"
  ) {
    return { approvals: (overrides as Record<string, unknown>).approvals };
  }
  return {};
}

function digestOf(value: unknown): Digest {
  return `sha256:${
    createHash("sha256").update(stableStringify(value)).digest("hex")
  }`;
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
// it is downstream of the AppSpec route shape rather than part of the six
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
