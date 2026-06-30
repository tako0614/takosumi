// Target / TargetPool / SpacePolicy vocabulary (`takosumi.dev/v1alpha1`).
//
// Field shapes are verbatim from `docs/final-plan.md` §7 (Target, Credential,
// And Policy). A Target names a place a resource can be materialized; a
// TargetPool ranks the candidate Targets for a Space; a SpacePolicy constrains
// and biases which Target the Resolver may pick.

import { TAKOSUMI_API_VERSION } from "./capabilities.ts";
import type { JsonObject } from "./types.ts";

/** Well-known Target backend types. Operators may add plugin-defined tokens. */
export type KnownTargetType =
  | "aws"
  | "cloudflare"
  | "gcp"
  | "azure"
  | "kubernetes"
  | "vm"
  | "proxmox"
  | "libvirt"
  | "ssh"
  | "takosumi_native"
  | "opentofu";

/** Target backend type token. Not a closed enum; plugin-defined tokens are allowed. */
export type TargetType = KnownTargetType | (string & {});

export const TARGET_TYPES: readonly KnownTargetType[] = [
  "aws",
  "cloudflare",
  "gcp",
  "azure",
  "kubernetes",
  "vm",
  "proxmox",
  "libvirt",
  "ssh",
  "takosumi_native",
  "opentofu",
] as const;

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

// --- TargetPool (`docs/final-plan.md` §7.2) -----------------------------------

/**
 * One ranked Target entry. `ref` carries the type-specific reference
 * (cloudflare/aws -> accountRef, kubernetes -> clusterRef); `takosumi_native`
 * has no ref and uses `region`. Higher `priority` wins.
 */
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
   * Optional operator/admin implementation declarations for this Target. When
   * omitted, the resolver uses the built-in seed mapping for the Target type.
   * When present, these entries are the capability evidence the resolver uses
   * for the named shape. This keeps provider/vendor breadth in operator config
   * instead of hard-coding every backend into the `takosumi` OpenTofu provider.
   */
  readonly implementations?: readonly TargetPoolImplementation[];
}

export type TargetCapabilityLevel =
  "native" | "shim" | "emulated" | "unsupported";

export interface TargetPoolImplementation {
  readonly shape: string;
  readonly implementation: string;
  readonly interfaces: Readonly<Record<string, TargetCapabilityLevel>>;
  readonly nativeResourceType?: string;
  /** Optional Vite-style plugin id that handles this implementation. */
  readonly plugin?: string;
  /** Plugin-local configuration. Secrets must stay in Credential/ProviderConnection. */
  readonly options?: JsonObject;
}

export interface TargetPoolSpec {
  readonly targets: readonly TargetPoolEntry[];
}

export interface TargetPool {
  readonly apiVersion: typeof TAKOSUMI_API_VERSION;
  readonly kind: "TargetPool";
  readonly metadata: TargetMetadata;
  readonly spec: TargetPoolSpec;
}

// --- SpacePolicy (`docs/final-plan.md` §7.3 / §14.1) --------------------------

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

/** Resolution toggles. These gate ResolutionLock behavior in Phase 2. */
export interface SpacePolicyResolution {
  readonly lockAfterCreate: boolean;
  readonly allowAutoMigration: boolean;
}

export interface SpacePolicyApprovals {
  readonly requireForApply: boolean;
  readonly requireForDestroy: boolean;
}

export interface SpacePolicySpec {
  /**
   * Allowed/denied Targets. An entry is matched against both the Target `type`
   * and the TargetPool entry `name`, so the §7.3 example mixing `aws` (type)
   * and `kubernetes_prod` (name) both work.
   */
  readonly allowedTargets?: readonly string[];
  readonly deniedTargets?: readonly string[];
  readonly constraints?: SpacePolicyConstraints;
  readonly preferences?: SpacePolicyPreferences;
  readonly resolution: SpacePolicyResolution;
  readonly approvals?: SpacePolicyApprovals;
}

export interface SpacePolicy {
  readonly apiVersion: typeof TAKOSUMI_API_VERSION;
  readonly kind: "SpacePolicy";
  readonly metadata: { readonly name: string };
  readonly spec: SpacePolicySpec;
}
