// Resolve-phase pipeline for `DeploymentService.resolveDeploymentWithMode`.
//
// `buildDeploymentArtifacts` is the canonical Deployment compiler: it takes
// a public manifest plus deployment input and produces the
// (`groupId`, `resolution`, `desired`, `policyDecisions`) tuple that the
// orchestrator wraps into a persisted Deployment record. The policy gate
// validators (native binding approval, required provider features, resource
// safety, canary safety) and the supporting AppSpec projection helpers all
// live here so the resolve phase is self-contained.
//
// Extracted from `deployment_service.ts` so the orchestrator no longer
// carries ~800 lines of compilation logic. Behavior preserved verbatim;
// every helper migrated as-is.

import { objectAddress } from "takosumi-contract";
import type {
  DeploymentBinding,
  DeploymentDesired,
  DeploymentInput,
  DeploymentPolicyDecision,
  DeploymentResolution,
  DeploymentResourceClaim,
  DeploymentRoute,
  DeploymentRuntimeNetworkPolicy,
  IsoTimestamp,
} from "takosumi-contract";
import { resolveBindings, validateAccessPaths } from "../binding_resolver.ts";
import { compileManifestToAppSpec } from "../compiler.ts";
import { buildDescriptorClosure } from "../descriptor_closure.ts";
import { buildResolvedGraph } from "../resolved_graph.ts";
import type {
  AppSpec,
  AppSpecResource,
  AppSpecRoute,
  PublicComponentBindingSpec,
  PublicDeployManifest,
} from "../types.ts";
import { stableHash } from "./hash.ts";

export function buildDeploymentArtifacts(input: {
  readonly manifest: PublicDeployManifest;
  readonly createdAt: IsoTimestamp;
  readonly env?: string;
  readonly envName?: string;
  readonly input: DeploymentInput;
}): {
  readonly groupId: string;
  readonly resolution: DeploymentResolution;
  readonly desired: DeploymentDesired;
  readonly policyDecisions: readonly DeploymentPolicyDecision[];
} {
  const appSpec = compileManifestToAppSpec(input.manifest, {
    env: input.env,
    envName: input.envName,
    source: {
      kind: input.input.source_kind === "git" ? "git_ref" : "manifest",
      uri: input.input.source_ref,
    },
  });
  // Phase 10A — Authoring expansion already happened inside
  // `compileManifestToAppSpec`. The expansion descriptor digest plus every
  // referenced runtime/artifact/interface/resource/output descriptor
  // (and their JSON-LD context dependencies) is pinned by the descriptor
  // closure builder. Apply consumes this closure verbatim and MUST NOT
  // re-fetch descriptor URLs at execution time (Core spec § 6).
  const descriptorClosure = buildDescriptorClosure({
    appSpec,
    resolvedAt: input.createdAt,
  });
  // Phase 10B — ResolvedGraph projections (six canonical families) are emitted
  // here so controllers consume the projection records instead of re-deriving
  // them from raw descriptors (Core spec § 8).
  const resolvedGraph = buildResolvedGraph({
    appSpec,
    descriptorClosure,
    manifestSnapshot: input.input.manifest_snapshot,
  });
  // Phase 10C / Wave 3 — Binding resolution + access-path policy validation.
  // The resolver expands every consume edge into a canonical
  // `DeploymentBinding` (with stage chain + network boundary). The validator
  // emits one policy decision per access path; external-boundary paths require
  // an explicit `runtime_network_policy` egress allow rule (Core spec § 12
  // invariant). Denied decisions force the Deployment to status `failed` in
  // the caller above.
  const bindings = resolveBindings({
    appSpec,
    resolvedGraph,
    descriptorClosure,
    resolvedAt: input.createdAt,
  });
  const resources = resourceClaimsFor(appSpec, bindings);
  const routes = routeRecordsFor(appSpec);
  const runtimeNetworkPolicy = runtimeNetworkPolicyFor(appSpec);
  const runtimeNetworkPolicyRecord: DeploymentRuntimeNetworkPolicy = {
    ...runtimeNetworkPolicy,
    policyDigest: stableHash(runtimeNetworkPolicy),
  };
  const policyDecisions = validateAccessPaths({
    bindings,
    runtimeNetworkPolicy: runtimeNetworkPolicyRecord,
    resolvedAt: input.createdAt,
  });
  const nativeBindingDecisions = validateNativeBindingApproval({
    appSpec,
    resolvedAt: input.createdAt,
  });
  const providerFeatureDecisions = validateRequiredProviderFeatures({
    appSpec,
    resolvedAt: input.createdAt,
  });
  const resourceSafetyDecisions = validateResourceSafetyPolicies({
    appSpec,
    resolvedAt: input.createdAt,
  });
  const canarySafetyDecisions = validateCanarySafetyPolicies({
    appSpec,
    resolvedAt: input.createdAt,
  });
  const desired: DeploymentDesired = {
    routes,
    bindings,
    resources,
    runtime_network_policy: runtimeNetworkPolicyRecord,
    activation_envelope: activationEnvelopeFor(appSpec, routes),
  };
  return {
    groupId: appSpec.groupId,
    resolution: {
      descriptor_closure: descriptorClosure,
      resolved_graph: resolvedGraph,
    },
    desired,
    policyDecisions: [
      ...policyDecisions,
      ...nativeBindingDecisions,
      ...providerFeatureDecisions,
      ...resourceSafetyDecisions,
      ...canarySafetyDecisions,
    ],
  };
}

function validateNativeBindingApproval(input: {
  readonly appSpec: AppSpec;
  readonly resolvedAt: IsoTimestamp;
}): readonly DeploymentPolicyDecision[] {
  const decisions: DeploymentPolicyDecision[] = [];
  for (const component of input.appSpec.components) {
    for (const [bindingName, spec] of Object.entries(component.bindings)) {
      if (!requestsRawNativeBinding(spec)) continue;
      const sourceName = bindingSourceNameFor(spec);
      const subjectAddress = objectAddress(
        "app.binding",
        `${component.name}/${bindingName}`,
      );
      decisions.push({
        id:
          `policy-decision:native-raw-binding:${component.name}:${bindingName}`,
        gateGroup: "resolution",
        gate: "binding-resolution",
        decision: "require-approval",
        ruleRef: "native-raw-binding:manual-approval-required",
        subjectAddress,
        subjectDigest: stableHash({
          component: component.name,
          bindingName,
          sourceName,
          nativeBinding: "raw",
        }) as `sha256:${string}`,
        decidedAt: input.resolvedAt,
      });
    }
  }
  return decisions.sort((left, right) => left.id.localeCompare(right.id));
}

function requestsRawNativeBinding(spec: PublicComponentBindingSpec): boolean {
  const from = spec.from as { access?: unknown };
  const access = from.access;
  if (!isRecord(access)) return false;
  const nativeBinding = access.nativeBinding ?? access.native;
  return nativeBinding === "raw";
}

function bindingSourceNameFor(spec: PublicComponentBindingSpec): string {
  const from = spec.from;
  if ("resource" in from) return from.resource;
  if ("output" in from) return from.output;
  if ("secret" in from) return from.secret;
  return from.providerOutput;
}

function validateRequiredProviderFeatures(input: {
  readonly appSpec: AppSpec;
  readonly resolvedAt: IsoTimestamp;
}): readonly DeploymentPolicyDecision[] {
  const supported = providerFeatureSupport(input.appSpec);
  const decisions: DeploymentPolicyDecision[] = [];

  for (const component of input.appSpec.components) {
    const caps = new Set([
      ...(component.requirements?.runtimeCapabilities ?? []),
      ...(input.appSpec.effectiveRuntimeCapabilities?.[component.name] ?? []),
    ]);
    for (const capability of caps) {
      if (supported.runtimeCapabilities.has(capability)) continue;
      decisions.push(policyDecision({
        id: `policy-decision:provider-feature:${component.name}:${capability}`,
        gate: "provider-selection",
        decision: "deny",
        ruleRef: "provider-feature:runtime-capability-unsupported",
        subjectAddress: componentAddress(component.name),
        subject: { component: component.name, capability },
        decidedAt: input.resolvedAt,
      }));
    }
  }

  for (const resource of input.appSpec.resources) {
    if (supported.resourceContracts.has(resource.type)) continue;
    decisions.push(policyDecision({
      id: `policy-decision:provider-feature:resource:${resource.name}`,
      gate: "provider-selection",
      decision: "deny",
      ruleRef: "provider-feature:resource-contract-unsupported",
      subjectAddress: resourceAddress(resource.name),
      subject: { resource: resource.name, contract: resource.type },
      decidedAt: input.resolvedAt,
    }));
  }

  for (const route of input.appSpec.routes) {
    const contract = routeDescriptorId(route);
    if (supported.interfaceContracts.has(contract)) continue;
    decisions.push(policyDecision({
      id: `policy-decision:provider-feature:interface:${route.name}`,
      gate: "provider-selection",
      decision: "deny",
      ruleRef: "provider-feature:interface-contract-unsupported",
      subjectAddress: routeAddress(route.name),
      subject: { route: route.name, contract },
      decidedAt: input.resolvedAt,
    }));
  }

  const required = stringArrayFromUnknown(
    providerTargetOverride(input.appSpec).requiredFeatures,
  );
  for (const feature of required) {
    if (supported.genericFeatures.has(feature)) continue;
    decisions.push(policyDecision({
      id: `policy-decision:provider-feature:required:${feature}`,
      gate: "provider-selection",
      decision: "deny",
      ruleRef: "provider-feature:required-feature-unsupported",
      subjectAddress: objectAddress("provider-feature", feature),
      subject: { feature },
      decidedAt: input.resolvedAt,
    }));
  }

  return decisions.sort((left, right) => left.id.localeCompare(right.id));
}

function validateResourceSafetyPolicies(input: {
  readonly appSpec: AppSpec;
  readonly resolvedAt: IsoTimestamp;
}): readonly DeploymentPolicyDecision[] {
  const decisions: DeploymentPolicyDecision[] = [];
  const resourcesByName = new Map(
    input.appSpec.resources.map((resource) => [resource.name, resource]),
  );

  for (const resource of input.appSpec.resources) {
    for (const previous of previousNames(resource.raw)) {
      const previousContract = previous.contract;
      const currentAtPreviousName = resourcesByName.get(previous.name);
      const crossContract = previousContract
        ? previousContract !== resource.type
        : currentAtPreviousName !== undefined &&
          currentAtPreviousName.name !== resource.name &&
          currentAtPreviousName.type !== resource.type;
      if (!crossContract) continue;
      decisions.push(policyDecision({
        id: `policy-decision:previous-names:${resource.name}:${previous.name}`,
        gate: "descriptor-resolution",
        decision: "deny",
        ruleRef: "previous-names:cross-contract-denied",
        subjectAddress: resourceAddress(resource.name),
        subject: {
          resource: resource.name,
          contract: resource.type,
          previousName: previous.name,
          previousContract: previousContract ?? currentAtPreviousName?.type,
        },
        decidedAt: input.resolvedAt,
      }));
    }

    for (const feature of nativeFeatureRequests(resource.raw)) {
      decisions.push(policyDecision({
        id: `policy-decision:native-feature:${resource.name}:${feature}`,
        gate: "provider-selection",
        decision: "require-approval",
        ruleRef: "native-feature-realization:manual-approval-required",
        subjectAddress: resourceAddress(resource.name),
        subject: { resource: resource.name, contract: resource.type, feature },
        decidedAt: input.resolvedAt,
      }));
    }

    if (requestsDbSemanticWrites(resource)) {
      decisions.push(policyDecision({
        id: `policy-decision:db-semantic-write:${resource.name}`,
        gate: "operation-planning",
        decision: "require-approval",
        ruleRef: "db-semantic-write:manual-approval-required",
        subjectAddress: resourceAddress(resource.name),
        subject: { resource: resource.name, contract: resource.type },
        decidedAt: input.resolvedAt,
      }));
    }
  }

  return decisions.sort((left, right) => left.id.localeCompare(right.id));
}

function validateCanarySafetyPolicies(input: {
  readonly appSpec: AppSpec;
  readonly resolvedAt: IsoTimestamp;
}): readonly DeploymentPolicyDecision[] {
  const rollout = input.appSpec.overrides?.rollout;
  if (!isRecord(rollout)) return [];
  const decisions: DeploymentPolicyDecision[] = [];
  const kind = typeof rollout.kind === "string" ? rollout.kind : "canary";

  if (kind === "canary" && hasCandidateScopedEgress(input.appSpec)) {
    decisions.push(policyDecision({
      id: "policy-decision:canary:candidate-scoped-egress",
      gate: "access-path-selection",
      decision: "require-approval",
      ruleRef: "canary-egress:candidate-scoped-manual-approval-required",
      subjectAddress: objectAddress("rollout", input.appSpec.groupId),
      subject: { group: input.appSpec.groupId, kind },
      decidedAt: input.resolvedAt,
    }));
  }

  if (hasShadowRollout(rollout) && hasSideEffectSurface(input.appSpec)) {
    decisions.push(policyDecision({
      id: "policy-decision:canary:shadow-side-effects",
      gate: "operation-planning",
      decision: "deny",
      ruleRef: "shadow-side-effects:forbidden",
      subjectAddress: objectAddress("rollout", input.appSpec.groupId),
      subject: { group: input.appSpec.groupId, kind },
      decidedAt: input.resolvedAt,
    }));
  }

  return decisions.sort((left, right) => left.id.localeCompare(right.id));
}

function routeRecordsFor(appSpec: AppSpec): readonly DeploymentRoute[] {
  return appSpec.routes.map((route) => ({
    id: route.name,
    exposureAddress: routeAddress(route.name),
    routeDescriptorId: routeDescriptorId(route),
    match: {
      host: route.host,
      path: route.path,
      protocol: route.protocol,
      port: route.port,
      source: route.source,
      methods: route.methods,
      target: route.to,
      targetPort: route.targetPort,
    },
    transport: {
      security: route.protocol.toLowerCase() === "http" ? "none" : "tls",
    },
  }));
}

function resourceClaimsFor(
  appSpec: AppSpec,
  bindings: readonly DeploymentBinding[],
): readonly DeploymentResourceClaim[] {
  return appSpec.resources.map((resource) => {
    const claimAddress = resourceAddress(resource.name);
    return {
      claimAddress,
      contract: resource.type,
      bindingNames: bindings
        .filter((binding) => binding.sourceAddress === claimAddress)
        .map((binding) => binding.bindingName),
    };
  });
}

function runtimeNetworkPolicyFor(
  appSpec: AppSpec,
): Omit<DeploymentRuntimeNetworkPolicy, "policyDigest"> {
  const configured = runtimeNetworkPolicyInput(appSpec);
  const defaultEgress = configured.defaultEgress;
  return {
    defaultEgress: defaultEgress === "allow" || defaultEgress === "deny" ||
        defaultEgress === "deny-by-default"
      ? defaultEgress
      : "deny-by-default",
    egressRules: Array.isArray(configured.egressRules)
      ? configured.egressRules
        .filter((rule): rule is Record<string, unknown> => isRecord(rule))
        .map((rule) => ({
          effect: rule.effect === "allow" ? "allow" : "deny",
          protocol: protocolFor(rule.protocol),
          to: Array.isArray(rule.to)
            ? rule.to.filter((item): item is Record<string, unknown> =>
              isRecord(item)
            )
            : undefined,
          ports: Array.isArray(rule.ports)
            ? rule.ports.filter((port): port is number =>
              Number.isInteger(port)
            )
            : undefined,
        }))
      : undefined,
    serviceIdentity: {
      group: appSpec.groupId,
      components: appSpec.components.map((component) => component.name).sort(),
    },
  };
}

function activationEnvelopeFor(
  appSpec: AppSpec,
  routes: readonly DeploymentRoute[],
): DeploymentDesired["activation_envelope"] {
  const assignments = appSpec.components.map((component) => ({
    componentAddress: componentAddress(component.name),
    weight: 1,
    labels: { component: component.name },
  }));
  const primary = assignments[0] ?? {
    componentAddress: objectAddress("group", appSpec.groupId),
    weight: 0,
    labels: { group: appSpec.groupId },
  };
  const rolloutOverride = rolloutStrategyOverride(appSpec);
  const envelope = {
    primary_assignment: primary,
    assignments,
    route_assignments: routeAssignmentsFor(appSpec, routes, rolloutOverride),
    rollout_strategy: rolloutOverride.strategy,
    non_routed_defaults: assignments[0]
      ? {
        events: {
          componentAddress: assignments[0].componentAddress,
          reason: rolloutOverride.kind === "canary"
            ? "http-only-canary"
            : "first-component",
        },
        outputs: {
          componentAddress: assignments[0].componentAddress,
          reason: rolloutOverride.kind === "canary"
            ? "http-only-canary"
            : "first-component",
        },
      }
      : undefined,
  };
  return {
    ...envelope,
    envelopeDigest: stableHash(envelope),
  };
}

/**
 * Phase 17D — read the canary rollout assignment model out of authoring
 * overrides (`overrides.rollout`). The rollout-canary service injects this
 * shape at every step; resolving the override here lets the resolved
 * Deployment carry route-level canary weight assignments rather than the
 * default `weightPermille: 1000` immediate strategy.
 */
function rolloutStrategyOverride(appSpec: AppSpec): {
  readonly kind: string;
  readonly strategy: { kind: string; steps?: readonly unknown[] };
  readonly routeWeights: ReadonlyMap<
    string,
    readonly { readonly target: string; readonly weightPermille: number }[]
  >;
} {
  const overrideValue = appSpec.overrides?.rollout;
  const empty = new Map<
    string,
    readonly { readonly target: string; readonly weightPermille: number }[]
  >();
  if (!isRecord(overrideValue)) {
    return {
      kind: "immediate",
      strategy: { kind: "immediate" },
      routeWeights: empty,
    };
  }
  const kind = typeof overrideValue.kind === "string"
    ? overrideValue.kind
    : "canary";
  const routesField = overrideValue.routes;
  const routeWeights = new Map<
    string,
    readonly { readonly target: string; readonly weightPermille: number }[]
  >();
  if (Array.isArray(routesField)) {
    for (const route of routesField) {
      if (!isRecord(route)) continue;
      const routeName = typeof route.routeName === "string"
        ? route.routeName
        : undefined;
      if (!routeName) continue;
      const rawAssignments = Array.isArray(route.assignments)
        ? route.assignments
        : [];
      const assignments: { target: string; weightPermille: number }[] = [];
      for (const candidate of rawAssignments) {
        if (!isRecord(candidate)) continue;
        const releaseId = candidate["appReleaseId"];
        const componentAddr = candidate["componentAddress"];
        const weight = candidate["weightPermille"];
        const target = typeof releaseId === "string"
          ? releaseId
          : typeof componentAddr === "string"
          ? componentAddr
          : "";
        if (target.length === 0) continue;
        assignments.push({
          target,
          weightPermille: typeof weight === "number" ? weight : 0,
        });
      }
      routeWeights.set(routeName, assignments);
    }
  }
  return {
    kind,
    strategy: {
      kind,
      steps: Array.isArray(overrideValue.steps)
        ? overrideValue.steps
        : undefined,
    },
    routeWeights,
  };
}

function routeAssignmentsFor(
  appSpec: AppSpec,
  routes: readonly DeploymentRoute[],
  override: ReturnType<typeof rolloutStrategyOverride>,
): readonly {
  routeId: string;
  protocol?: string;
  assignments: readonly {
    componentAddress: string;
    weightPermille: number;
  }[];
}[] {
  return routes.map((route) => {
    const targetName = stringField(route.match, "target") ??
      appSpec.components[0]?.name ?? appSpec.groupId;
    const overrideAssignments = override.routeWeights.get(route.id);
    if (overrideAssignments && overrideAssignments.length > 0) {
      // Map app-release labels onto the canonical primary component. The
      // canary releases share the component identity (Deployment.desired
      // carries the activation chain via per-step Deployments) so each
      // assignment maps the override target to the route's primary
      // componentAddress with the requested permille weight.
      return {
        routeId: route.id,
        protocol: stringField(route.match, "protocol"),
        assignments: overrideAssignments.map((assignment) => ({
          componentAddress: componentAddress(targetName),
          weightPermille: assignment.weightPermille,
          labels: { release: assignment.target },
        })),
      };
    }
    return {
      routeId: route.id,
      protocol: stringField(route.match, "protocol"),
      assignments: [{
        componentAddress: componentAddress(targetName),
        weightPermille: 1000,
      }],
    };
  });
}

function runtimeNetworkPolicyInput(appSpec: AppSpec): Record<string, unknown> {
  const overrides = appSpec.overrides;
  const value = overrides.runtimeNetworkPolicy;
  return isRecord(value) ? value : {};
}

function providerTargetOverride(appSpec: AppSpec): Record<string, unknown> {
  const value = appSpec.overrides?.providerTarget ??
    appSpec.overrides?.providerSupport;
  return isRecord(value) ? value : {};
}

function providerFeatureSupport(appSpec: AppSpec): {
  readonly runtimeCapabilities: ReadonlySet<string>;
  readonly resourceContracts: ReadonlySet<string>;
  readonly interfaceContracts: ReadonlySet<string>;
  readonly genericFeatures: ReadonlySet<string>;
} {
  const override = providerTargetOverride(appSpec);
  const supports = isRecord(override.supports) ? override.supports : override;
  const runtimeCapabilities = supportedSet(supports, "runtimeCapabilities", [
    "always-on-container",
    "request-driven-container",
    "request-driven-js-worker",
    "external-tenant-routing",
    "health-check-aware-routing",
  ]);
  const resourceContracts = supportedSet(supports, "resourceContracts", [
    "resource.sql.postgres@v1",
    "resource.sql.sqlite-serverless@v1",
    "resource.object-store.s3@v1",
    "resource.key-value@v1",
    "resource.queue.at-least-once@v1",
    "resource.secret@v1",
    "resource.vector-index@v1",
  ]);
  const interfaceContracts = supportedSet(supports, "interfaceContracts", [
    "interface.http@v1",
    "interface.tcp@v1",
    "interface.udp@v1",
    "interface.queue@v1",
  ]);
  const genericFeatures = new Set([
    ...runtimeCapabilities,
    ...resourceContracts,
    ...interfaceContracts,
    ...stringArrayFromUnknown(supports.features),
    ...stringArrayFromUnknown(supports.capabilityProfiles),
  ]);
  return {
    runtimeCapabilities,
    resourceContracts,
    interfaceContracts,
    genericFeatures,
  };
}

function supportedSet(
  source: Record<string, unknown>,
  field: string,
  defaults: readonly string[],
): ReadonlySet<string> {
  const explicit = stringArrayFromUnknown(source[field]);
  return new Set(explicit.length > 0 ? explicit : defaults);
}

function previousNames(
  resource: Record<string, unknown>,
): readonly { readonly name: string; readonly contract?: string }[] {
  const generate = isRecord(resource.generate) ? resource.generate : {};
  const value = resource.previousNames ?? resource.previous_names ??
    generate.previousNames ?? generate.previous_names;
  if (!Array.isArray(value)) return [];
  const entries: { name: string; contract?: string }[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) {
      entries.push({ name: item });
    } else if (isRecord(item) && typeof item.name === "string") {
      const contract = typeof item.contract === "string"
        ? item.contract
        : typeof item.type === "string"
        ? item.type
        : undefined;
      entries.push({ name: item.name, contract });
    }
  }
  return entries;
}

function nativeFeatureRequests(
  resource: Record<string, unknown>,
): readonly string[] {
  const generate = isRecord(resource.generate) ? resource.generate : {};
  return [
    ...stringArrayFromUnknown(resource.features),
    ...stringArrayFromUnknown(resource.nativeFeatures),
    ...stringArrayFromUnknown(resource.providerNativeFeatures),
    ...stringArrayFromUnknown(resource.extensions),
    ...stringArrayFromUnknown(generate.features),
    ...stringArrayFromUnknown(generate.nativeFeatures),
    ...stringArrayFromUnknown(generate.providerNativeFeatures),
    ...stringArrayFromUnknown(generate.extensions),
  ].filter((feature) => isNativeFeature(feature));
}

function isNativeFeature(feature: string): boolean {
  const normalized = feature.toLowerCase();
  return normalized === "pgvector" || normalized.includes("native") ||
    normalized.startsWith("extension:");
}

function requestsDbSemanticWrites(resource: AppSpecResource): boolean {
  if (!resource.type.includes("sql")) return false;
  const raw = resource.raw;
  if (
    raw.semanticWrites === true || raw.dbSemanticWrites === true ||
    raw.semanticWrite === true
  ) {
    return true;
  }
  const generate = isRecord(raw.generate) ? raw.generate : {};
  if (
    generate.semanticWrites === true || generate.dbSemanticWrites === true ||
    generate.semanticWrite === true
  ) {
    return true;
  }
  const writeSemantics = raw.writeSemantics;
  const generateWriteSemantics = generate.writeSemantics;
  if (
    (typeof writeSemantics === "string" && writeSemantics.length > 0) ||
    (typeof generateWriteSemantics === "string" &&
      generateWriteSemantics.length > 0)
  ) {
    return true;
  }
  const migrations = raw.migrations ?? generate.migrations;
  return isRecord(migrations) && migrations.writes === true;
}

function hasCandidateScopedEgress(appSpec: AppSpec): boolean {
  const policy = runtimeNetworkPolicyInput(appSpec);
  const rules = Array.isArray(policy.egressRules) ? policy.egressRules : [];
  return rules.some((rule) =>
    isRecord(rule) &&
    (rule.candidateScoped === true || rule.candidateOnly === true ||
      typeof rule.candidateAppReleaseId === "string" ||
      rule.scope === "candidate")
  );
}

function hasShadowRollout(rollout: Record<string, unknown>): boolean {
  return rollout.kind === "shadow" || rollout.shadow === true ||
    rollout.shadowTraffic === true || isRecord(rollout.shadowTraffic);
}

function hasSideEffectSurface(appSpec: AppSpec): boolean {
  if (appSpec.outputs.length > 0) return true;
  if (
    appSpec.routes.some((route) => route.protocol.toLowerCase() === "queue")
  ) {
    return true;
  }
  return appSpec.resources.some((resource) =>
    requestsDbSemanticWrites(resource)
  );
}

function policyDecision(input: {
  readonly id: string;
  readonly gate: DeploymentPolicyDecision["gate"];
  readonly decision: DeploymentPolicyDecision["decision"];
  readonly ruleRef: string;
  readonly subjectAddress: string;
  readonly subject: unknown;
  readonly decidedAt: IsoTimestamp;
}): DeploymentPolicyDecision {
  return {
    id: input.id,
    gateGroup: "resolution",
    gate: input.gate,
    decision: input.decision,
    ruleRef: input.ruleRef,
    subjectAddress: input.subjectAddress,
    subjectDigest: stableHash(input.subject) as `sha256:${string}`,
    decidedAt: input.decidedAt,
  };
}

function stringArrayFromUnknown(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string =>
      typeof item === "string" && item.length > 0
    )
    : [];
}

function routeDescriptorId(route: AppSpecRoute): string {
  const value = (route as AppSpecRoute & { interfaceContractRef?: string })
    .interfaceContractRef;
  return value ?? "interface.http@v1";
}

function componentAddress(name: string): string {
  return objectAddress("component", name);
}

function resourceAddress(name: string): string {
  return objectAddress("resource", name);
}

function routeAddress(name: string): string {
  return objectAddress("route", name);
}

function protocolFor(
  value: unknown,
): NonNullable<DeploymentRuntimeNetworkPolicy["egressRules"]>[number][
  "protocol"
] {
  return value === "http" || value === "https" || value === "tcp" ||
      value === "udp"
    ? value
    : undefined;
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const item = value[field];
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
