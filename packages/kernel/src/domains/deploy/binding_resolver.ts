// Binding resolver + access-path policy validator (Phase 10C / Wave 3).
//
// The resolver expands every component-level `bindings` declaration from the
// AppSpec into a canonical `DeploymentBinding` with:
//   - explicit `source` (resource | output | secret | provider-output)
//   - canonical `sourceAddress` (matches the access-path request projection)
//   - access mode + injection target derived from the binding spec
//   - sensitivity / enforcement / resolutionPolicy assigned from the source
//   - per-binding `CoreResourceAccessPath` (Core spec § 12) with stage chain
//     and `networkBoundary` decided by the source kind
//
// The validator inspects every emitted access path together with the
// `Deployment.desired.runtime_network_policy` and emits one
// `DeploymentPolicyDecision` per binding that crosses an external boundary.
// External-boundary access paths MUST be explicitly allow-listed by an egress
// rule (Core spec § 12 invariant): otherwise resolution is blocked.
//
// The resolver is a pure function over already-built artifacts (descriptor
// closure + resolved graph + AppSpec), so apply consumes its output verbatim
// without re-deriving binding shapes from raw descriptors.

import { objectAddress } from "takosumi-contract";
import type {
  CoreAccessModeRef,
  CoreAccessPathStage,
  CoreEnforcement,
  CoreInjectionTarget,
  CoreNetworkBoundary,
  CoreResourceAccessPath,
  CoreSensitivity,
  DeploymentBinding,
  DeploymentBindingResolutionPolicy,
  DeploymentBindingSource,
  DeploymentDescriptorClosure,
  DeploymentPolicyDecision,
  DeploymentResolvedGraph,
  DeploymentRuntimeNetworkPolicy,
  IsoTimestamp,
  ObjectAddress,
} from "takosumi-contract";
import type {
  AppSpec,
  AppSpecComponent,
  PublicComponentBindingSpec,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ResolveBindingsInput {
  readonly appSpec: AppSpec;
  readonly resolvedGraph: DeploymentResolvedGraph;
  readonly descriptorClosure: DeploymentDescriptorClosure;
  readonly resolvedAt: IsoTimestamp;
}

/** Resolve every component binding declaration in the AppSpec into a
 *  canonical `DeploymentBinding`. Output is deterministic and sorted by
 *  component then binding name so apply consumes a stable shape. */
export function resolveBindings(
  input: ResolveBindingsInput,
): readonly DeploymentBinding[] {
  const bindings: DeploymentBinding[] = [];
  for (const component of input.appSpec.components) {
    for (const [name, spec] of Object.entries(component.bindings)) {
      bindings.push(buildBinding({
        component,
        bindingName: name,
        spec,
        appSpec: input.appSpec,
        resolvedAt: input.resolvedAt,
      }));
    }
  }
  bindings.sort((left, right) => {
    const cmp = left.componentAddress.localeCompare(right.componentAddress);
    return cmp !== 0 ? cmp : left.bindingName.localeCompare(right.bindingName);
  });
  return bindings;
}

export interface ValidateAccessPathsInput {
  readonly bindings: readonly DeploymentBinding[];
  readonly runtimeNetworkPolicy: DeploymentRuntimeNetworkPolicy;
  readonly resolvedAt: IsoTimestamp;
}

/** Validate every binding's `accessPath.networkBoundary` against the
 *  `runtime_network_policy`. External-boundary paths require an `allow` egress
 *  rule that matches the source. Missing policy on an enforced path emits
 *  `deny`; missing policy on an advisory path emits an `allow` audit decision
 *  with an advisory ruleRef so resolution can proceed without pretending the
 *  boundary was enforced. Internal / provider-internal paths are emitted as
 *  `allow` decisions (audit witness, no policy required). */
export function validateAccessPaths(
  input: ValidateAccessPathsInput,
): readonly DeploymentPolicyDecision[] {
  const decisions: DeploymentPolicyDecision[] = [];
  for (const binding of input.bindings) {
    const path = binding.accessPath;
    if (!path) continue;
    const subjectAddress = objectAddress(
      "resource.access",
      `${binding.bindingName}/${addressLocalName(binding.componentAddress)}`,
    );
    const subjectDigest = digestForAccessPath(binding, path);
    const decisionId =
      `policy-decision:access-path:${binding.componentAddress}:${binding.bindingName}`;
    if (path.networkBoundary !== "external") {
      decisions.push({
        id: decisionId,
        gateGroup: "resolution",
        gate: "access-path-selection",
        decision: "allow",
        ruleRef: `boundary:${path.networkBoundary}`,
        subjectAddress,
        subjectDigest,
        decidedAt: input.resolvedAt,
      });
      continue;
    }
    const allowed = isExternalEgressAllowed(
      binding,
      input.runtimeNetworkPolicy,
    );
    if (allowed) {
      decisions.push({
        id: decisionId,
        gateGroup: "resolution",
        gate: "access-path-selection",
        decision: "allow",
        ruleRef: "runtime-network-policy:egress-allow",
        subjectAddress,
        subjectDigest,
        decidedAt: input.resolvedAt,
      });
    } else if (path.enforcement === "advisory") {
      decisions.push({
        id: decisionId,
        gateGroup: "resolution",
        gate: "access-path-selection",
        decision: "allow",
        ruleRef:
          "runtime-network-policy:advisory-external-boundary-not-allowed",
        subjectAddress,
        subjectDigest,
        decidedAt: input.resolvedAt,
      });
    } else {
      decisions.push({
        id: decisionId,
        gateGroup: "resolution",
        gate: "access-path-selection",
        decision: "deny",
        ruleRef: "runtime-network-policy:external-boundary-not-allowed",
        subjectAddress,
        subjectDigest,
        decidedAt: input.resolvedAt,
      });
    }
  }
  decisions.sort((left, right) => left.id.localeCompare(right.id));
  return decisions;
}

// ---------------------------------------------------------------------------
// Binding construction
// ---------------------------------------------------------------------------

interface BuildBindingInput {
  readonly component: AppSpecComponent;
  readonly bindingName: string;
  readonly spec: PublicComponentBindingSpec;
  readonly appSpec: AppSpec;
  readonly resolvedAt: IsoTimestamp;
}

function buildBinding(input: BuildBindingInput): DeploymentBinding {
  const source = bindingSourceFor(input.spec);
  const sourceName = bindingSourceName(input.spec);
  const access = accessFor(input.spec, source);
  const injection = input.spec.inject;
  const sensitivity = sensitivityFor(source);
  const enforcement = enforcementFor(input.spec);
  const resolutionPolicy = resolutionPolicyFor(source);
  const sourceAddress = sourceAddressFor(source, sourceName);
  const componentAddr = componentAddress(input.component.name);
  const accessPath = buildAccessPath({
    componentAddress: componentAddr,
    bindingName: input.bindingName,
    source,
    access,
    injection,
    enforcement,
    sensitivity,
    appSpec: input.appSpec,
    spec: input.spec,
  });
  const resolvedVersion = stableHashLike({
    source,
    sourceAddress,
    access: access ?? null,
    injection,
  });
  return {
    bindingName: input.bindingName,
    componentAddress: componentAddr,
    source,
    sourceAddress,
    access,
    injection,
    sensitivity,
    enforcement,
    resolutionPolicy,
    resolvedVersion,
    resolvedAt: input.resolvedAt,
    accessPath,
  };
}

function bindingSourceFor(
  spec: PublicComponentBindingSpec,
): DeploymentBindingSource {
  const from = spec.from;
  if ("resource" in from) return "resource";
  if ("output" in from) return "output";
  if ("secret" in from) return "secret";
  if ("providerOutput" in from) return "provider-output";
  throw new TypeError("binding.from must declare a source");
}

function bindingSourceName(spec: PublicComponentBindingSpec): string {
  const from = spec.from;
  if ("resource" in from) return from.resource;
  if ("output" in from) return from.output;
  if ("secret" in from) return from.secret;
  return from.providerOutput;
}

function sourceAddressFor(
  source: DeploymentBindingSource,
  sourceName: string,
): ObjectAddress {
  const name = sourceName.replace(
    /^(resource|output|secret|provider-output)\./,
    "",
  );
  if (source === "resource") return objectAddress("resource", name);
  if (source === "output") return objectAddress("output", name);
  if (source === "secret") return objectAddress("secret", name);
  return objectAddress("provider-output", name);
}

function accessFor(
  spec: PublicComponentBindingSpec,
  source: DeploymentBindingSource,
): CoreAccessModeRef | undefined {
  if (source !== "resource") return undefined;
  const from = spec.from as { resource: string; access: unknown };
  const access = from.access;
  if (
    isRecord(access) && typeof access.contract === "string" &&
    typeof access.mode === "string"
  ) {
    return { contract: access.contract, mode: access.mode };
  }
  return undefined;
}

function enforcementFor(spec: PublicComponentBindingSpec): CoreEnforcement {
  const from = spec.from as { access?: unknown };
  if (isRecord(from.access)) {
    const enforcement = from.access.enforcement;
    if (
      enforcement === "enforced" || enforcement === "advisory" ||
      enforcement === "unsupported"
    ) {
      return enforcement;
    }
  }
  return "enforced";
}

function sensitivityFor(source: DeploymentBindingSource): CoreSensitivity {
  switch (source) {
    case "secret":
      return "secret";
    case "provider-output":
      return "credential";
    case "output":
      return "internal";
    case "resource":
      return "internal";
  }
}

function resolutionPolicyFor(
  _source: DeploymentBindingSource,
): DeploymentBindingResolutionPolicy {
  return "latest-at-activation";
}

// ---------------------------------------------------------------------------
// Access path construction
// ---------------------------------------------------------------------------

interface BuildAccessPathInput {
  readonly componentAddress: ObjectAddress;
  readonly bindingName: string;
  readonly source: DeploymentBindingSource;
  readonly access?: CoreAccessModeRef;
  readonly injection: CoreInjectionTarget;
  readonly enforcement: CoreEnforcement;
  readonly sensitivity: CoreSensitivity;
  readonly appSpec: AppSpec;
  readonly spec: PublicComponentBindingSpec;
}

function buildAccessPath(
  input: BuildAccessPathInput,
): CoreResourceAccessPath {
  const access = input.access ?? syntheticAccess(input.source);
  const stages = buildStages(input);
  const networkBoundary = networkBoundaryFor(input.source, input.spec);
  return {
    id: `access:${
      addressLocalName(input.componentAddress)
    }:${input.bindingName}`,
    bindingName: input.bindingName,
    componentAddress: input.componentAddress,
    access,
    injection: input.injection,
    stages,
    networkBoundary,
    enforcement: input.enforcement,
  };
}

function syntheticAccess(source: DeploymentBindingSource): CoreAccessModeRef {
  return {
    contract: `binding.${source}@v1`,
    mode: "default",
  };
}

function buildStages(
  input: BuildAccessPathInput,
): readonly CoreAccessPathStage[] {
  const baseStage: CoreAccessPathStage = {
    kind: input.source,
    role: stageRole(input.source),
    owner: "takosumi",
    lifecycle: stageLifecycle(input.source),
    readiness: "required",
    credentialBoundary: credentialBoundaryFor(input.source),
    credentialVisibility: credentialVisibilityFor(input.source),
  };
  if (input.source === "resource") {
    return [{
      kind: "access-mediator",
      role: "access-mediator",
      owner: "takosumi",
      lifecycle: "per-component",
      readiness: "required",
      credentialBoundary: "none",
      credentialVisibility: "control-plane-only",
    }, baseStage];
  }
  return [baseStage];
}

function stageRole(
  source: DeploymentBindingSource,
): CoreAccessPathStage["role"] {
  switch (source) {
    case "resource":
      return "resource-host";
    case "output":
      return "resource-host";
    case "secret":
      return "credential-source";
    case "provider-output":
      return "credential-source";
  }
}

function stageLifecycle(
  source: DeploymentBindingSource,
): CoreAccessPathStage["lifecycle"] {
  switch (source) {
    case "resource":
      return "per-resource";
    case "output":
      return "shared";
    case "secret":
      return "per-resource";
    case "provider-output":
      return "per-resource";
  }
}

function credentialBoundaryFor(
  source: DeploymentBindingSource,
): CoreAccessPathStage["credentialBoundary"] {
  switch (source) {
    case "secret":
      return "resource-credential";
    case "provider-output":
      return "provider-credential";
    case "resource":
      return "resource-credential";
    case "output":
      return "none";
  }
}

function credentialVisibilityFor(
  source: DeploymentBindingSource,
): CoreAccessPathStage["credentialVisibility"] {
  switch (source) {
    case "secret":
      return "consumer-runtime";
    case "provider-output":
      return "consumer-runtime";
    case "resource":
      return "mediator-only";
    case "output":
      return "consumer-runtime";
  }
}

function networkBoundaryFor(
  source: DeploymentBindingSource,
  spec: PublicComponentBindingSpec,
): CoreNetworkBoundary {
  const from = spec.from as { access?: unknown };
  const access = from.access;
  const explicit = isRecord(access) ? access.networkBoundary : undefined;
  if (
    explicit === "internal" || explicit === "provider-internal" ||
    explicit === "external"
  ) {
    return explicit;
  }
  switch (source) {
    case "output":
      return "external";
    case "resource":
      return "provider-internal";
    case "secret":
      return "internal";
    case "provider-output":
      return "internal";
  }
}

// ---------------------------------------------------------------------------
// External egress allow check
// ---------------------------------------------------------------------------

function isExternalEgressAllowed(
  binding: DeploymentBinding,
  policy: DeploymentRuntimeNetworkPolicy,
): boolean {
  if (policy.defaultEgress === "allow") return true;
  const rules = policy.egressRules ?? [];
  for (const rule of rules) {
    if (rule.effect !== "allow") continue;
    if (matchesBinding(rule.to, binding)) return true;
  }
  return false;
}

function matchesBinding(
  to: readonly Record<string, unknown>[] | undefined,
  binding: DeploymentBinding,
): boolean {
  if (!to || to.length === 0) {
    return true;
  }
  for (const target of to) {
    if (matchesTarget(target, binding)) return true;
  }
  return false;
}

function matchesTarget(
  target: Record<string, unknown>,
  binding: DeploymentBinding,
): boolean {
  const sourceMatch = stringField(target, "source") ??
    stringField(target, "kind");
  if (sourceMatch && sourceMatch !== binding.source) {
    if (sourceMatch !== "resource-access-path") return false;
    if (!binding.accessPath) return false;
  }
  const boundaryMatch = stringField(target, "networkBoundary");
  if (
    boundaryMatch && binding.accessPath?.networkBoundary !== boundaryMatch
  ) {
    return false;
  }
  const enforcementMatch = stringField(target, "enforcement");
  if (enforcementMatch && binding.enforcement !== enforcementMatch) {
    return false;
  }
  const addressMatch = stringField(target, "sourceAddress") ??
    stringField(target, "address");
  if (addressMatch && addressMatch !== binding.sourceAddress) return false;
  const bindingMatch = stringField(target, "bindingName");
  if (bindingMatch && bindingMatch !== binding.bindingName) return false;
  const componentMatch = stringField(target, "componentAddress");
  if (componentMatch && componentMatch !== binding.componentAddress) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function componentAddress(name: string): ObjectAddress {
  return objectAddress("component", name);
}

function addressLocalName(address: ObjectAddress): string {
  const idx = address.indexOf(":");
  return idx >= 0 ? address.slice(idx + 1) : address;
}

function stringField(
  target: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digestForAccessPath(
  binding: DeploymentBinding,
  path: CoreResourceAccessPath,
): `sha256:${string}` {
  return stableHashLike({
    bindingName: binding.bindingName,
    componentAddress: binding.componentAddress,
    sourceAddress: binding.sourceAddress,
    networkBoundary: path.networkBoundary,
    access: path.access,
    injection: path.injection,
    stages: path.stages,
  });
}

function stableHashLike(value: unknown): `sha256:${string}` {
  const input = stableStringify(value);
  const seeds = [
    0xcbf29ce484222325n,
    0x84222325cbf29ce4n,
    0x9e3779b97f4a7c15n,
    0x94d049bb133111ebn,
  ];
  return `sha256:${seeds.map((seed) => fnv1a64(input, seed)).join("")}`;
}

function fnv1a64(input: string, seed: bigint): string {
  let hash = seed;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
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
