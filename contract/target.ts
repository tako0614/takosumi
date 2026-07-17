// Target / TargetPool / SpacePolicy vocabulary (`takosumi.dev/v1alpha1`).
//
// Field shapes are verbatim from `docs/internal/final-plan.md` §7 (Target, Credential,
// And Policy). A Target names a place a resource can be materialized; a
// TargetPool ranks the candidate Targets for a Space; a SpacePolicy constrains
// and biases which Target the Resolver may pick.

import { TAKOSUMI_API_VERSION } from "./capabilities.ts";
import type { JsonObject, JsonValue } from "./types.ts";
import type { OutputValueType } from "./install-configs.ts";
import type { ResourceShapeKind } from "./resource-shape.ts";

/** Opaque operator-owned Target type token. Core has no vendor type enum. */
export type TargetType = string;

/**
 * Who owns the Target's credential lifecycle. `user_managed` reuses a
 * caller-owned ProviderConnection (the opentofu-adapter credential path);
 * `managed` uses operator/Cloud-managed credentials.
 */
export type TargetManagementMode = "user_managed" | "managed";

export interface TargetSpec {
  readonly type: TargetType;
  /**
   * ProviderConnection / Credential id used when the resolved implementation
   * runs through the opentofu-adapter. Optional until a credential is bound.
   */
  readonly credentialRef?: string;
  readonly region?: string;
  readonly mode: TargetManagementMode;
}

export interface Target {
  readonly apiVersion: typeof TAKOSUMI_API_VERSION;
  readonly kind: "Target";
  readonly metadata: TargetMetadata;
  readonly spec: TargetSpec;
}

export interface TargetMetadata {
  readonly name: string;
  readonly space: string;
}

// --- TargetPool (`docs/internal/final-plan.md` §7.2) -----------------------------------

/** One ranked Target entry. `ref` is an opaque operator target reference. */
export interface TargetPoolEntry {
  readonly name: string;
  readonly type: TargetType;
  readonly ref?: string;
  /**
   * ProviderConnection / Credential id used by the opentofu-adapter. Kept
   * separate from `ref`: `ref` is the target-native reference such as a
   * Cloudflare account id or Kubernetes cluster ref.
   */
  readonly credentialRef?: string;
  readonly region?: string;
  readonly priority: number;
  /**
   * Operator/admin implementation descriptors for this Target. Omission means
   * the Target advertises no Resource Shape implementation; Core never derives
   * one from `type`, `ref`, `region`, or a vendor name.
   */
  readonly implementations?: readonly TargetImplementationDescriptor[];
}

export type TargetCapabilityLevel =
  "native" | "shim" | "emulated" | "unsupported";

export type TargetModuleInputSource = "spec" | "target" | "literal";

/**
 * Declarative projection from a Resource spec/Target snapshot into one child
 * module variable. `path` is an RFC 6901 JSON Pointer for `spec`/`target`;
 * `value` is used only by `literal`. Missing optional values are omitted.
 */
export interface TargetModuleInputMapping {
  readonly source: TargetModuleInputSource;
  readonly path?: string;
  readonly value?: JsonValue;
  readonly required?: boolean;
  readonly default?: JsonValue;
}

export interface TargetModuleOutput {
  readonly name: string;
  readonly type: OutputValueType;
}

/**
 * Complete, non-secret implementation descriptor owned by operator config.
 *
 * Exactly one execution path is selected: `plugin`, or an explicit
 * `providerSource` + `moduleTemplate`. Provider arguments and module-variable
 * projections are data; Resolver/Planner never infer them from target/shape or
 * implementation names.
 */
export interface TargetImplementationDescriptor {
  readonly shape: ResourceShapeKind;
  readonly implementation: string;
  readonly interfaces: Readonly<Record<string, TargetCapabilityLevel>>;
  readonly nativeResourceType?: string;
  /** Optional Vite-style plugin id that handles this implementation. */
  readonly plugin?: string;
  /** Explicit OpenTofu provider source for module-backed implementations. */
  readonly providerSource?: string;
  readonly providerAlias?: string;
  /** Explicit non-secret provider block configuration. */
  readonly providerConfig?: Readonly<Record<string, JsonValue>>;
  /** Bundled module id selected by the operator, never by implementation name. */
  readonly moduleTemplate?: string;
  /**
   * Child-module resource address used by reviewed config-driven import, for
   * example `cloudflare_r2_bucket.this`. Core prefixes `module.child.` and
   * never derives this address from a provider or implementation token.
   */
  readonly moduleImportAddress?: string;
  /** Explicit child-module variable projection. */
  readonly moduleInputMappings?: Readonly<
    Record<string, TargetModuleInputMapping>
  >;
  /** Public child outputs captured for the Resource. */
  readonly moduleOutputs?: readonly TargetModuleOutput[];
  /** Plugin-local configuration. Secrets must stay in Credential/ProviderConnection. */
  readonly options?: JsonObject;
}

export interface TargetPoolSpec {
  /**
   * Public placement-class tokens used by FormActivation. They deliberately
   * do not expose Target names, credentials, regions, manager identity, or
   * capacity. An empty/omitted list keeps the pool usable by unconstrained
   * activations but gives discovery no class token to publish.
   */
  readonly classes?: readonly string[];
  readonly targets: readonly TargetPoolEntry[];
}

export interface TargetPool {
  readonly apiVersion: typeof TAKOSUMI_API_VERSION;
  readonly kind: "TargetPool";
  readonly metadata: TargetMetadata;
  readonly spec: TargetPoolSpec;
}

// --- SpacePolicy (`docs/internal/final-plan.md` §7.3 / §14.1) --------------------------

export interface SpacePolicyConstraints {
  readonly dataResidency?: string;
  readonly encryptionAtRest?: "required" | "optional";
  readonly publicExposureRequiresTls?: boolean;
  readonly auditLog?: "required" | "optional";
}

export type CostPreference = "low" | "balanced" | "high";
export type OperationsPreference = "managed" | "self";
export type PortabilityPreference = "low" | "balanced" | "high";

export interface SpacePolicyPreferences {
  readonly cost?: CostPreference;
  readonly operations?: OperationsPreference;
  readonly portability?: PortabilityPreference;
}

export interface SpacePolicyApprovals {
  readonly requireForApply: boolean;
  readonly requireForDestroy: boolean;
}

export interface SpacePolicySpec {
  /**
   * Allowed/denied Targets. An entry is matched against both the Target `type`
   * and the TargetPool entry `name`.
   */
  readonly allowedTargets?: readonly string[];
  readonly deniedTargets?: readonly string[];
  readonly constraints?: SpacePolicyConstraints;
  readonly preferences?: SpacePolicyPreferences;
  readonly approvals?: SpacePolicyApprovals;
}

export interface SpacePolicy {
  readonly apiVersion: typeof TAKOSUMI_API_VERSION;
  readonly kind: "SpacePolicy";
  readonly metadata: { readonly name: string };
  readonly spec: SpacePolicySpec;
}
