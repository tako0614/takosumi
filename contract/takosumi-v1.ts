/**
 * Takosumi reference helper module.
 *
 * Internal deploy-control compatibility DTOs live in
 * `internal-deploy-control-api.ts`.
 * This module keeps shared helper primitives used by the service implementation:
 * ObjectAddress, condition reasons, binding resolution helpers, and output
 * projection helpers.
 */

import type { Digest, IsoTimestamp, JsonObject } from "./types.ts";

// ---------------------------------------------------------------------------
// 9. ObjectAddress
// ---------------------------------------------------------------------------

export type ObjectAddress = string;
export type DescriptorId = string;

const OBJECT_ADDRESS_NAMESPACE_PATTERN = /^[a-z][a-z0-9.-]*$/;
const OBJECT_ADDRESS_ENCODED_NAME_PATTERN =
  /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+$/;

export function encodeObjectAddressName(name: string): string {
  if (name.length === 0) {
    throw new TypeError("ObjectAddress name must not be empty");
  }
  return encodeURIComponent(name);
}

export function objectAddressSegment(
  namespace: string,
  name: string,
): string {
  if (!OBJECT_ADDRESS_NAMESPACE_PATTERN.test(namespace)) {
    throw new TypeError(`Invalid ObjectAddress namespace: ${namespace}`);
  }
  return `${namespace}:${encodeObjectAddressName(name)}`;
}

export function joinObjectAddressSegments(
  ...segments: readonly string[]
): ObjectAddress {
  const address = segments.join("/");
  assertObjectAddress(address);
  return address;
}

export function objectAddress(namespace: string, name: string): ObjectAddress {
  return joinObjectAddressSegments(objectAddressSegment(namespace, name));
}

export function isObjectAddress(value: unknown): value is ObjectAddress {
  if (typeof value !== "string") return false;
  return validateObjectAddress(value) === undefined;
}

export function assertObjectAddress(
  value: string,
): asserts value is ObjectAddress {
  const error = validateObjectAddress(value);
  if (error) throw new TypeError(error);
}

function validateObjectAddress(value: string): string | undefined {
  if (value.length === 0) return "ObjectAddress must not be empty";
  for (const segment of value.split("/")) {
    const index = segment.indexOf(":");
    if (index <= 0 || index === segment.length - 1) {
      return `Invalid ObjectAddress segment: ${segment}`;
    }
    const namespace = segment.slice(0, index);
    const encodedName = segment.slice(index + 1);
    if (!OBJECT_ADDRESS_NAMESPACE_PATTERN.test(namespace)) {
      return `Invalid ObjectAddress namespace: ${namespace}`;
    }
    if (
      !OBJECT_ADDRESS_ENCODED_NAME_PATTERN.test(encodedName) ||
      encodedName.includes("/")
    ) {
      return `Invalid ObjectAddress encoded name: ${encodedName}`;
    }
    try {
      decodeURIComponent(encodedName);
    } catch {
      return `Invalid ObjectAddress percent encoding: ${encodedName}`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shared scalar enums (descriptor / binding / resource semantics)
// ---------------------------------------------------------------------------

export type CoreSensitivity = "public" | "internal" | "secret" | "credential";
export type CoreEnforcement = "enforced" | "advisory" | "unsupported";
export type CoreNetworkBoundary =
  | "internal"
  | "provider-internal"
  | "external";
export type CorePolicyDecisionOutcome = "allow" | "deny" | "require-approval";
export type CorePolicyGateGroup =
  | "resolution"
  | "planning"
  | "execution"
  | "recovery"
  | string;
export type CorePolicyGate =
  | "descriptor-resolution"
  | "authoring-expansion"
  | "graph-projection"
  | "provider-selection"
  | "binding-resolution"
  | "access-path-selection"
  | "operation-planning"
  | "activation-preview"
  | "apply-phase-revalidation"
  | "repair-planning"
  | string;
export type CoreBindingSource =
  | "resource"
  | "output"
  | "secret"
  | "provider-output";

// ---------------------------------------------------------------------------
// Condition reason catalog. Single-source-of-truth via `as const`; the type
// union and the runtime list are derived together.
// ---------------------------------------------------------------------------

export const CORE_CONDITION_REASONS = [
  "PlanStale", "ReadSetChanged",
  "DescriptorPinned", "DescriptorChanged", "DescriptorUnavailable", "DescriptorUntrusted",
  "DescriptorCompatibilityUnknown", "DescriptorAliasAmbiguous", "DescriptorContextChanged",
  "DescriptorBootstrapTrustMissing", "ResolvedGraphChanged", "PolicyDenied",
  "ApprovalRequired", "ApprovalMissing", "ApprovalInvalidated", "BreakGlassRequired",
  "BreakGlassDenied", "BindingCollision", "BindingResolutionFailed", "BindingTargetUnsupported",
  "BindingRebindRequired", "BindingSourceWithdrawn", "BindingSourceUnavailable",
  "InjectionModeUnsupported", "AccessModeUnsupported", "SecretResolutionFailed",
  "SecretVersionRevoked", "CredentialVisibilityUnsupported", "CredentialRawEnvDenied",
  "CredentialOutputRequiresApproval", "RawCredentialInjectionDenied",
  "AccessPathUnsupported", "AccessPathAmbiguous", "AccessPathMaterializationFailed",
  "AccessPathExternalBoundaryRequiresPolicy", "AccessPathCredentialBoundaryFailed",
  "ResourceCompatibilityFailed", "ResourceBindingFailed", "ResourceRestoreUnsupported",
  "ResourceRebindRequired", "ActivationCommitted", "ActivationPreviewFailed",
  "ActivationAssignmentInvalid", "ActivationPrimaryMissing", "RouterConfigIncompatible",
  "RouteDescriptorIncompatible", "InterfaceDescriptorIncompatible", "RouterAssignmentUnsupported", "RouterProtocolUnsupported",
  "ServingMaterializing", "ServingConverged", "ServingDegraded", "ServingConvergenceUnknown",
  "ProviderMaterializing", "ProviderMaterializationFailed", "ProviderObjectMissing",
  "ProviderConfigDrift", "ProviderStatusDrift", "ProviderSecurityDrift",
  "ProviderOwnershipDrift", "ProviderCacheDrift", "ProviderRateLimited",
  "ProviderCredentialDenied", "ProviderPartialSuccess", "ProviderOperationTimedOut",
  "OutputWithdrawn", "OutputUnavailable", "OutputResolutionFailed",
  "OutputProjectionFailed", "OutputRouteUnavailable", "OutputAuthUnavailable",
  "OutputConsumerRebindRequired", "OutputConsumerGrantMissing",
  "OutputInjectionDenied",
  "RollbackIncompatible", "RollbackDescriptorUnavailable",
  "RollbackArtifactUnavailable", "RollbackResourceIncompatible", "RepairPlanRequired",
  "RepairMaterializationRequired", "RepairAccessPathRequired",
  "RepairOutputProjectionRequired",
  "ArtifactUnavailable", "ArtifactRetentionMissing",
  "RuntimeNotReady", "RuntimeReadinessUnknown", "RuntimeLiveRebindUnsupported",
  "RuntimeShutdownFailed", "RuntimeDrainTimeout",
] as const;

export type CoreConditionReason = typeof CORE_CONDITION_REASONS[number];

const CORE_CONDITION_REASON_SET: ReadonlySet<string> = new Set(
  CORE_CONDITION_REASONS,
);

export function isCoreConditionReason(
  value: unknown,
): value is CoreConditionReason {
  return typeof value === "string" && CORE_CONDITION_REASON_SET.has(value);
}

// ---------------------------------------------------------------------------
// 4. Component and binding helper shapes.
// ---------------------------------------------------------------------------

export interface CoreComponentSpec {
  contracts: Record<string, CoreContractInstanceSpec>;
  bindings?: Record<string, CoreComponentBindingSpec>;
  /** Component-level Output declarations, equivalent to App-scope `outputs`. */
  outputs?: Record<string, CoreOutputSpec>;
  requirements?: JsonObject;
  previousAddresses?: readonly ObjectAddress[];
}

export interface CoreContractInstanceSpec {
  ref: string;
  config?: unknown;
}

export interface CoreExposureSpec {
  target: { component: string; contract: string };
  visibility?: "public" | "internal" | string;
}

export interface CoreAccessModeRef {
  contract: string;
  mode: string;
}

export interface CoreInjectionTarget {
  mode: string;
  target: string;
}

/**
 * Component-level binding declaration for explicitly requesting that a
 * selected source field be injected into a component.
 */
export interface CoreComponentBindingSpec {
  from: CoreComponentBindingSource;
  inject: CoreInjectionTarget;
}

export type CoreComponentBindingSource =
  | {
    resource: string;
    access: CoreAccessModeRef;
  }
  | {
    output: string;
    field: string;
  }
  | {
    secret: string;
  }
  | {
    providerOutput: string;
    field: string;
  };

/** Authoring shape for an Output declaration. */
export interface CoreOutputSpec {
  contract: string;
  from?: { exposure?: string; path?: string } | unknown;
  outputs?: Record<string, unknown>;
  visibility?: "private" | "explicit" | "space" | "public" | string;
}

export interface CoreProviderTargetSpec {
  provider: string;
  region?: string;
  config?: JsonObject;
}

// ---------------------------------------------------------------------------
// 6. Descriptor resolution (closure is inlined into Deployment.resolution)
// ---------------------------------------------------------------------------

export interface CoreDescriptorResolution {
  id: DescriptorId;
  alias?: string;
  documentUrl?: string;
  mediaType: string;
  rawDigest: Digest;
  expandedDigest?: Digest;
  contextDigests?: Digest[];
  canonicalization?: { algorithm: string; version: string };
  policyDecisionId?: string;
  resolvedAt: IsoTimestamp;
}

export interface CoreDescriptorDependency {
  fromDescriptorId: DescriptorId;
  toDescriptorId: DescriptorId;
  reason:
    | "schema"
    | "compatibility-rule"
    | "permission-scope"
    | "resolver"
    | "shape-derivation"
    | "access-mode"
    | "policy"
    | string;
}

export interface CoreDescriptorClosure {
  id: string;
  digest: Digest;
  resolutions: readonly CoreDescriptorResolution[];
  dependencies?: readonly CoreDescriptorDependency[];
  createdAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// 5. Components and 8. resolved_graph projections
// ---------------------------------------------------------------------------

export interface CoreComponent {
  address: ObjectAddress;
  contractInstances: readonly CoreContractInstance[];
  shapeRefs?: readonly string[];
}

export interface CoreContractInstance {
  address: ObjectAddress;
  localName: string;
  descriptorId: DescriptorId;
  descriptorDigest: Digest;
  configDigest?: Digest;
  lifecycleDomain?: string;
  changeEffects?: readonly CoreChangeEffectRule[];
}

export interface CoreChangeEffectRule {
  path: string;
  effect: string;
}

export interface CoreProjectionRecord {
  projectionType: string;
  objectAddress: ObjectAddress;
  sourceComponentAddress: ObjectAddress;
  sourceContractInstance: string;
  descriptorResolutionId: string;
  digest: Digest;
}

// ---------------------------------------------------------------------------
// 12. Resource access path (recorded inline alongside bindings)
// ---------------------------------------------------------------------------

export interface CoreAccessPathStage {
  kind: string;
  role?: "access-mediator" | "resource-host" | "credential-source";
  providerTarget?: string;
  owner?: "takosumi" | "provider" | "operator";
  lifecycle?: "per-component" | "per-resource" | "shared";
  readiness?: "required" | "optional";
  credentialBoundary?:
    | "none"
    | "provider-credential"
    | "resource-credential";
  credentialVisibility?:
    | "consumer-runtime"
    | "mediator-only"
    | "provider-only"
    | "control-plane-only"
    | "none";
}

export interface CoreResourceAccessPath {
  id?: string;
  resourceBindingId?: string;
  bindingName?: string;
  componentAddress: ObjectAddress;
  access: CoreAccessModeRef;
  injection: CoreInjectionTarget;
  stages: readonly CoreAccessPathStage[];
  networkBoundary: CoreNetworkBoundary;
  enforcement: CoreEnforcement;
  limitations?: readonly string[];
}

// ---------------------------------------------------------------------------
// Space helper records shared by the resource/output service implementation.
// ---------------------------------------------------------------------------

export type CorePolicyDecision = CorePolicyDecisionOutcome;
export type CoreMaterializationStatus =
  | "preparing"
  | "ready"
  | "failed"
  | "retired";

export interface CoreDescriptorClosure {
  id: string;
  digest: Digest;
  resolutions: readonly CoreDescriptorResolution[];
  dependencies?: readonly CoreDescriptorDependency[];
  createdAt: IsoTimestamp;
}

export type CoreResolvedComponent = CoreComponent;
export type CoreResolvedContractInstance = CoreContractInstance;

export interface CoreResolvedGraph {
  id: string;
  digest: Digest;
  deploySpecDigest: Digest;
  envSpecDigest: Digest;
  policySpecDigest: Digest;
  descriptorClosureDigest: Digest;
  components: readonly CoreResolvedComponent[];
  projections?: readonly CoreProjectionRecord[];
}

export interface CorePolicyDecisionRecord {
  id: string;
  gateGroup: CorePolicyGateGroup;
  gate: CorePolicyGate;
  decision: CorePolicyDecision;
  ruleRef?: string;
  subjectAddress?: ObjectAddress;
  subjectDigest: Digest;
  decidedAt: IsoTimestamp;
}

export interface CoreApprovalRecord {
  id: string;
  policyDecisionId: string;
  subjectDigest: Digest;
  approvedBy: string;
  approvedAt: IsoTimestamp;
  expiresAt?: IsoTimestamp;
}

export interface CoreBindingResolutionReport {
  componentAddress: ObjectAddress;
  bindingSetRevisionId?: string;
  inputs: readonly CoreBindingResolutionInput[];
  blockers: readonly string[];
  warnings: readonly string[];
}

export interface CoreBindingResolutionInput {
  bindingName: string;
  source: CoreBindingSource;
  sourceAddress: string;
  access?: CoreAccessModeRef;
  injection: CoreInjectionTarget;
  sensitivity: CoreSensitivity;
  enforcement: CoreEnforcement;
}

/**
 * Producer-side typed-output declaration. An Output is a typed value the
 * producer publishes through an explicit Output contract; it does not by
 * itself imply that any consumer will receive the value.
 *
 * Output does not imply Binding. Binding is explicit (see
 * {@link CoreBindingDeclaration}).
 */
export interface CoreOutputDeclaration {
  /** `output:<group>/<name>` */
  address: ObjectAddress;
  producerGroupId: string;
  /** Output contract id (for example output.http-endpoint@v1). */
  contract: DescriptorId;
  /** Descriptor-defined source projection, e.g. exposure / path / lookup. */
  source: unknown;
  visibility: "private" | "explicit" | "space" | "public";
  status?: "declared" | "withdrawn";
}

export type CoreOutputValueType =
  | "string"
  | "url"
  | "json"
  | "secret-ref"
  | "service-ref"
  | "endpoint";

export interface CoreOutputValue {
  valueType: CoreOutputValueType;
  sensitivity: CoreSensitivity;
  /** Plain by-value payload; absent for secret / credential outputs. */
  value?: unknown;
  /**
   * Address of the secret material backing this output. Required when
   * sensitivity is `secret` or `credential`; raw env injection of these
   * outputs requires explicit contract + grant + policy + approval.
   */
  secretRef?: string;
}

export type CoreOutputRevisionStatus = "ready" | "unavailable" | "withdrawn";

export interface CoreOutputRevision {
  outputAddress: ObjectAddress;
  revisionId: string;
  /** Optional reference to the activation that materialised the revision. */
  activationRecordId?: string;
  /** Descriptor that resolved the values, when distinct from the contract. */
  resolverDescriptorId?: DescriptorId;
  inputDigests: readonly Digest[];
  values: Record<string, CoreOutputValue>;
  status: CoreOutputRevisionStatus;
  digest: Digest;
  createdAt: IsoTimestamp;
}

/**
 * Discovery / catalog projection for an Output. Catalog visibility does NOT
 * imply Binding or grant — it is metadata only.
 */
export interface CoreOutputProjection {
  /** `output.projection:<...>` */
  address: ObjectAddress;
  outputAddress: ObjectAddress;
  projectionType: string;
  projectionDigest: Digest;
}

export type CoreBindingSourceRef =
  | {
    kind: "resource";
    resource: ObjectAddress;
    access: CoreAccessModeRef;
  }
  | {
    kind: "output";
    output: ObjectAddress;
    field: string;
  }
  | {
    kind: "secret";
    secret: string;
  }
  | {
    kind: "provider-output";
    materialization: ObjectAddress;
    field: string;
  };

/**
 * Consumer-side explicit injection request: this component requests source
 * field X to be injected into target Y.
 *
 * Binding does not imply raw env. Raw env injection of secret / credential
 * outputs requires an explicit policy decision and approval (see
 * `CredentialOutputRequiresApproval` / `RawCredentialInjectionDenied`).
 */
export interface CoreBindingDeclaration {
  /** `app.binding:<component>/<bindingName>` */
  address: ObjectAddress;
  componentAddress: ObjectAddress;
  bindingName: string;
  source: CoreBindingSourceRef;
  inject: CoreInjectionTarget;
}

export type CoreBindingResolutionStatus =
  | "ready"
  | "blocked"
  | "stale"
  | "withdrawn"
  | "unavailable";

/**
 * Resolved + authorized binding record. BindingResolution captures policy,
 * grant, approval, compatibility, and the resolved source revision for a
 * single CoreBindingDeclaration. Plan / Apply produce these.
 */
export interface CoreBindingResolution {
  bindingDeclarationAddress: ObjectAddress;
  /**
   * Resolved source revision: an OutputRevision id, ResourceAccessPath id,
   * secret version, or provider materialization id depending on
   * `source.kind` of the underlying CoreBindingDeclaration.
   */
  resolvedSourceRevision?: string;
  policyDecisionId: string;
  approvalRecordId?: string;
  grantRef?: string;
  sensitivity: CoreSensitivity;
  status: CoreBindingResolutionStatus;
  blockers?: readonly string[];
  warnings?: readonly string[];
  digest: Digest;
}

/**
 * Immutable per-component binding snapshot consumed by AppRelease at
 * activation time. Output changes never mutate existing BindingSetRevisions;
 * a new BindingSetRevision is produced for a rebind plan.
 *
 * - `inputs` carries the per-binding {@link CoreBindingResolutionInput} surface.
 * - `bindingDeclarations` records the declared shape per binding.
 * - `bindingResolutions` records the resolved + authorized binding state.
 * - `bindingValueResolutions` retains value-level resolution (secret version
 *   etc.) and remains the per-value snapshot.
 */
export interface CoreBindingSetRevision {
  id: string;
  groupId: string;
  componentAddress: ObjectAddress;
  structureDigest: Digest;
  inputs: readonly CoreBindingResolutionInput[];
  bindingDeclarations?: readonly CoreBindingDeclaration[];
  bindingResolutions?: readonly CoreBindingResolution[];
  bindingValueResolutions?: readonly CoreBindingValueResolution[];
  conditions?: readonly { reason: CoreConditionReason; message?: string }[];
}

export interface CoreBindingValueResolution {
  bindingSetRevisionId: string;
  bindingName: string;
  sourceAddress: string;
  resolutionPolicy:
    | "latest-at-activation"
    | "pinned-version"
    | "latest-at-invocation";
  resolvedVersion?: string;
  resolvedAt: IsoTimestamp;
  sensitivity: CoreSensitivity;
}

export interface CoreAppRelease {
  id: string;
  groupId: string;
  resolvedGraphDigest: Digest;
  componentRevisionRefs: readonly string[];
  bindingSetRevisionRefs: readonly string[];
  status: CoreMaterializationStatus;
}

export interface CoreRouterConfig {
  id: string;
  groupId: string;
  routeRefs: readonly string[];
  status: CoreMaterializationStatus;
}

/**
 * Operation-side record of an OutputRevision computation. Distinct from the
 * persisted {@link CoreOutputRevision} record: this captures the raw resolver
 * inputs/output digests used by the planner.
 */
export interface CoreOutputResolution {
  /** `output:<group>/<name>` */
  outputAddress: ObjectAddress;
  resolverRef: string;
  inputDigests: readonly Digest[];
  outputDigest: Digest;
  values: Record<string, unknown>;
}

export interface CoreApplyPhase {
  id: string;
  applyRunId: string;
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  revalidationRequired: boolean;
}

// ---------------------------------------------------------------------------
// Removed deploy record names are intentionally not exported from this module.
// ---------------------------------------------------------------------------
