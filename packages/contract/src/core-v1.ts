// Takosumi Deploy Core Contract — TypeScript canonical types.
//
// Canonical spec: /docs/core/01-core-contract-v1.0.md.
// Core is organized around three records:
//   - Deployment            (input + resolution + desired state + status)
//   - ProviderObservation   (observed provider state, never canonical)
//   - GroupHead             (space/group-scoped pointer to the current Deployment)
// Every other deploy meta-record is collapsed onto a field of `Deployment`,
// or onto one of the other two records.

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

// ---------------------------------------------------------------------------
// Condition reason catalog. Single-source-of-truth via `as const`; the type
// union and the runtime list are derived together.
// ---------------------------------------------------------------------------

// deno-fmt-ignore
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
// 4. AppSpec / EnvSpec / PolicySpec authoring shapes
// ---------------------------------------------------------------------------

export interface CoreAppSpec {
  apiVersion: "takosumi.dev/v1";
  kind: "App";
  name: string;
  components: Record<string, CoreComponentSpec>;
  exposures?: Record<string, CoreExposureSpec>;
  /** App-scope Output declarations. */
  outputs?: Record<string, CoreOutputSpec>;
  requirements?: JsonObject;
}

export interface CoreEnvSpec {
  apiVersion: "takosumi.dev/v1";
  kind: "Environment";
  providerTargets?: Record<string, CoreProviderTargetSpec>;
  router?: JsonObject;
  runtimeNetworkPolicy?: JsonObject;
  accessPathPreferences?: JsonObject;
}

export interface CorePolicySpec {
  apiVersion: "takosumi.dev/v1";
  kind: "Policy";
  descriptorPolicy?: JsonObject;
  bindingPolicy?: JsonObject;
  routerPolicy?: JsonObject;
  resourcePolicy?: JsonObject;
  approvals?: JsonObject;
}

export interface CoreComponentSpec {
  contracts: Record<string, CoreContractInstanceSpec>;
  /**
   * Canonical authoring surface for explicitly requesting that a typed source
   * field be injected into a component.
   */
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
 * Component-level binding declaration — the canonical, non-legacy authoring
 * shape for explicitly requesting that a selected source field be injected
 * into a component. Compiles to a CoreBindingDeclaration.
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
    | "jsonld-context"
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
// 13. Deployment record (the canonical core record)
// ---------------------------------------------------------------------------

export type DeploymentStatus =
  | "preview"
  | "resolved"
  | "applying"
  | "applied"
  | "failed"
  | "rolled-back";

/**
 * Resolve mode — controls whether `resolveDeployment` persists the resulting
 * Deployment record:
 *   - "resolve" (default): write the Deployment to the store, return it.
 *   - "preview": do NOT write to the store; return the in-memory record so
 *     authors / dashboards can inspect the resolution without producing a
 *     persisted record. Mirrors `kubectl --dry-run=client` semantics.
 */
export type DeploymentMode = "preview" | "resolve";

export type DeploymentSourceKind =
  | "git"
  | "registry"
  | "inline"
  | "store"
  | string;

export interface DeploymentInput {
  manifest_snapshot: string;
  source_kind: DeploymentSourceKind;
  source_ref?: string;
  env?: string;
  group?: string;
}

export interface DeploymentDescriptorClosure {
  resolutions: readonly CoreDescriptorResolution[];
  dependencies?: readonly CoreDescriptorDependency[];
  closureDigest: Digest;
  createdAt: IsoTimestamp;
}

export interface DeploymentResolvedGraph {
  digest: Digest;
  components: readonly CoreComponent[];
  projections: readonly CoreProjectionRecord[];
  appSpecDigest?: Digest;
  envSpecDigest?: Digest;
  policySpecDigest?: Digest;
}

export interface DeploymentResolution {
  descriptor_closure: DeploymentDescriptorClosure;
  resolved_graph: DeploymentResolvedGraph;
}

export type DeploymentBindingSource =
  | "resource"
  | "output"
  | "secret"
  | "provider-output";

export type DeploymentBindingResolutionPolicy =
  | "latest-at-activation"
  | "pinned-version"
  | "latest-at-invocation";

export interface DeploymentBinding {
  bindingName: string;
  componentAddress: ObjectAddress;
  source: DeploymentBindingSource;
  sourceAddress: string;
  access?: CoreAccessModeRef;
  injection: CoreInjectionTarget;
  sensitivity: CoreSensitivity;
  enforcement: CoreEnforcement;
  resolutionPolicy: DeploymentBindingResolutionPolicy;
  resolvedVersion?: string;
  resolvedAt?: IsoTimestamp;
  grantRef?: string;
  accessPath?: CoreResourceAccessPath;
}

export interface DeploymentRoute {
  id: string;
  exposureAddress: ObjectAddress;
  routeDescriptorId: DescriptorId;
  match: Record<string, unknown>;
  transport?: { security?: string; tls?: Record<string, unknown> };
}

export interface DeploymentResourceClaim {
  claimAddress: ObjectAddress;
  contract: string;
  bindingNames: readonly string[];
  resourceInstanceId?: string;
}

export interface DeploymentEgressRule {
  effect: "allow" | "deny";
  protocol?: "http" | "https" | "tcp" | "udp";
  to?: readonly Record<string, unknown>[];
  ports?: readonly number[];
}

export interface DeploymentRuntimeNetworkPolicy {
  policyDigest: Digest;
  defaultEgress: "allow" | "deny" | "deny-by-default";
  egressRules?: readonly DeploymentEgressRule[];
  serviceIdentity?: Record<string, unknown>;
}

export interface DeploymentAssignment {
  componentAddress: ObjectAddress;
  weight: number;
  labels?: Record<string, string>;
}

export interface DeploymentRouteAssignment {
  routeId: string;
  protocol?: string;
  assignments: readonly {
    componentAddress: ObjectAddress;
    weightPermille: number;
    /**
     * Optional labels carried with the assignment. The rollout-canary service
     * uses `labels.release` to project the canary app-release id onto the
     * route assignment so dashboards / observability can attribute traffic
     * weights to the underlying release lineage.
     */
    labels?: Record<string, string>;
  }[];
}

export interface DeploymentNonRoutedDefaults {
  events?: { componentAddress: ObjectAddress; reason?: string };
  /** Default producing component for Outputs that have no explicit route. */
  outputs?: { componentAddress: ObjectAddress; reason?: string };
}

export interface DeploymentRolloutStrategy {
  kind: "immediate" | "blue-green" | "canary" | string;
  steps?: readonly unknown[];
}

export interface DeploymentActivationEnvelope {
  primary_assignment: DeploymentAssignment;
  assignments?: readonly DeploymentAssignment[];
  route_assignments?: readonly DeploymentRouteAssignment[];
  rollout_strategy?: DeploymentRolloutStrategy;
  non_routed_defaults?: DeploymentNonRoutedDefaults;
  envelopeDigest: Digest;
}

export interface DeploymentDesired {
  routes: readonly DeploymentRoute[];
  bindings: readonly DeploymentBinding[];
  resources: readonly DeploymentResourceClaim[];
  runtime_network_policy: DeploymentRuntimeNetworkPolicy;
  activation_envelope: DeploymentActivationEnvelope;
}

export type DeploymentConditionScopeKind = "operation" | "phase" | "deployment";
export type DeploymentConditionStatus = "true" | "false" | "unknown";

export interface DeploymentConditionScope {
  kind: DeploymentConditionScopeKind;
  ref?: string;
}

export interface DeploymentCondition {
  type: string;
  status: DeploymentConditionStatus;
  reason?: CoreConditionReason | string;
  message?: string;
  observed_generation: number;
  last_transition_time: IsoTimestamp;
  scope?: DeploymentConditionScope;
  /**
   * Phase 18.2 multi-cloud provider tag. When a Deployment is materialised
   * across more than one provider (e.g. a composite where compute lives on
   * Cloudflare Workers and the database lives on AWS RDS) per-provider
   * conditions carry the provider id so the status projector can mark the
   * AWS layer outage independently of the Cloudflare layer.
   */
  provider_id?: string;
  /**
   * Phase 18.2 optional-provider flag. When `true`, a `false` condition for
   * this provider degrades the Deployment but never escalates it to a full
   * `outage`. This is the contract surface for `composite.web-app-with-cdn`
   * style descriptors where the CDN can fail without taking the core compute
   * path down.
   */
  optional?: boolean;
}

export type DeploymentPolicyGateGroup =
  | "resolution"
  | "planning"
  | "execution"
  | "recovery"
  | string;

export type DeploymentPolicyGate =
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
  | "rollback-planning"
  | string;

export interface DeploymentPolicyDecision {
  id: string;
  gateGroup: DeploymentPolicyGateGroup;
  gate: DeploymentPolicyGate;
  decision: CorePolicyDecisionOutcome;
  ruleRef?: string;
  subjectAddress?: ObjectAddress;
  subjectDigest: Digest;
  decidedAt: IsoTimestamp;
}

export interface DeploymentApproval {
  approved_by: string;
  approved_at: IsoTimestamp;
  policy_decision_id: string;
  expires_at?: IsoTimestamp;
}

export interface Deployment {
  id: string;
  group_id: string;
  space_id: string;
  input: DeploymentInput;
  resolution: DeploymentResolution;
  desired: DeploymentDesired;
  status: DeploymentStatus;
  conditions: readonly DeploymentCondition[];
  policy_decisions?: readonly DeploymentPolicyDecision[];
  approval?: DeploymentApproval | null;
  rollback_target?: string | null;
  created_at: IsoTimestamp;
  applied_at?: IsoTimestamp | null;
  finalized_at?: IsoTimestamp | null;
}

// ---------------------------------------------------------------------------
// 14. ProviderObservation (observed-side stream, never canonical)
// ---------------------------------------------------------------------------

export type ProviderObservationState =
  | "present"
  | "missing"
  | "drifted"
  | "unknown";

export type ProviderObservationDriftStatus =
  | "provider-object-missing"
  | "config-drift"
  | "status-drift"
  | "security-drift"
  | "ownership-drift"
  | "cache-drift";

export interface ProviderObservation {
  id: string;
  deployment_id: string;
  provider_id: string;
  object_address: ObjectAddress;
  observed_state: ProviderObservationState;
  drift_status?: ProviderObservationDriftStatus;
  observed_digest?: Digest;
  observed_at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// 15. GroupHead (strongly consistent space/group pointer to the current Deployment)
// ---------------------------------------------------------------------------

export interface GroupHead {
  space_id: string;
  group_id: string;
  current_deployment_id: string;
  previous_deployment_id?: string | null;
  generation: number;
  advanced_at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Core v1 records shared by the deploy-domain implementation and docs.
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
  appSpecDigest: Digest;
  envSpecDigest: Digest;
  policySpecDigest: Digest;
  descriptorClosureDigest: Digest;
  components: readonly CoreResolvedComponent[];
  projections?: readonly CoreProjectionRecord[];
}

export interface CorePolicyDecisionRecord {
  id: string;
  gateGroup: "resolution" | "planning" | "execution" | "recovery";
  gate: DeploymentPolicyGate;
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
  source: DeploymentBindingSource;
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
  /** Canonical id of the Output contract (e.g. output.mcp-server@v1). */
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
  /** Public-by-value payload; absent for secret / credential outputs. */
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
 * Consumer-side explicit injection request — the canonical Core record for
 * "this component requests source field X be injected into target Y".
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
 * - `bindingDeclarations` records the canonical declared shape per binding.
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

export interface CoreRuntimeNetworkPolicy {
  id: string;
  groupId: string;
  policyDigest: Digest;
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

export interface CoreProviderMaterialization {
  id: string;
  role: "router" | "runtime" | "resource" | "access";
  desiredObjectRef: string;
  providerTarget: string;
  objectAddress: ObjectAddress;
  createdByOperationId: string;
}

export interface CoreProviderObservation {
  materializationId: string;
  observedState: ProviderObservationState;
  driftReason?: ProviderObservationDriftStatus;
  observedDigest?: Digest;
  observedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Removed deploy record names are intentionally not exported from this module.
// ---------------------------------------------------------------------------
