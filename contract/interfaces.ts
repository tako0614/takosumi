import type { NativeResourceRef } from "./resolution.ts";
import type { Condition, JsonObject, JsonValue } from "./types.ts";
import { TAKOSUMI_API_VERSION } from "./capabilities.ts";
export { TAKOSUMI_INTERFACES_CAPABILITY } from "./capabilities.ts";

export type InterfaceOwnerKind = "Workspace" | "Capsule" | "Resource";

/**
 * Immutable declaration/materialization owner. Capsule declarations converge
 * from exactly two authoring sources; compatibility profiles retain their
 * separately scoped canonical http.route ownership.
 */
export type InterfaceMaterializedFrom =
  | { readonly source: "capsule_blueprint"; readonly key: string }
  | { readonly source: "capsule_resource" }
  | {
      readonly source: "compatibility_profile";
      readonly profile: string;
      readonly key: string;
    }
  | {
      /** Portable Form descriptor; authorization remains host-owned. */
      readonly source: "form_descriptor";
      readonly formRefKey: string;
      readonly formSchemaDigest: string;
      readonly descriptorName: string;
      readonly descriptorVersion: string;
    };

/** Stable lexical contract shared by Interface producers and consumers. */
export const INTERFACE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
/** RFC 6749 scope-token (`NQCHAR`): printable ASCII except `"` and `\\`. */
export const INTERFACE_PERMISSION_TOKEN_PATTERN =
  /^[\x21\x23-\x5b\x5d-\x7e]+$/u;
export const INTERFACE_PERMISSION_TOKEN_MAX_LENGTH = 256;

export function isValidInterfaceName(value: unknown): value is string {
  return typeof value === "string" && INTERFACE_NAME_PATTERN.test(value);
}

export function isValidInterfacePermissionToken(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= INTERFACE_PERMISSION_TOKEN_MAX_LENGTH &&
    INTERFACE_PERMISSION_TOKEN_PATTERN.test(value)
  );
}

export interface InterfaceOwnerRef {
  readonly kind: InterfaceOwnerKind;
  readonly id: string;
}

export interface InterfaceMetadata {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly ownerRef: InterfaceOwnerRef;
  readonly generation: number;
  readonly labels?: Readonly<Record<string, string>>;
  /**
   * Immutable declaration-source marker. A Capsule blueprint and a module
   * resource never adopt or rewrite each other's record.
   */
  readonly materializedFrom?: InterfaceMaterializedFrom;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InterfaceLiteralInput {
  readonly source: "literal";
  /** Public, non-secret runtime material. */
  readonly value: JsonValue;
}

export interface InterfaceCapsuleOutputInput {
  readonly source: "capsule_output";
  readonly capsuleId: string;
  readonly outputName: string;
  /** Optional RFC 6901 pointer into the ordinary root Output value. */
  readonly pointer?: string;
}

export interface InterfaceResourceOutputInput {
  readonly source: "resource_output";
  readonly resourceId: string;
  /** Omitted selects the complete public Resource output document. */
  readonly outputName?: string;
  /** Optional RFC 6901 pointer into the Resource observed public output. */
  readonly pointer?: string;
}

export type InterfaceInput =
  | InterfaceLiteralInput
  | InterfaceCapsuleOutputInput
  | InterfaceResourceOutputInput;

export type InterfaceVisibility = "private" | "workspace" | "public";

export interface InterfaceAccessSpec {
  readonly visibility: InterfaceVisibility;
  readonly policyRef?: string;
  /** Input whose resolved value is the token audience/resource URI. */
  readonly resourceUriInput?: string;
}

/**
 * Desired runtime declaration. `document` is deliberately opaque to Core;
 * protocol consumers interpret it together with `status.resolvedInputs`.
 */
export interface InterfaceSpec {
  readonly type: string;
  readonly version: string;
  readonly document: JsonValue;
  readonly inputs?: Readonly<Record<string, InterfaceInput>>;
  readonly access: InterfaceAccessSpec;
}

export type InterfacePhase =
  "Pending" | "Resolved" | "NotReady" | "Unknown" | "Terminating" | "Retired";

export interface InterfaceCapsuleOutputProvenance {
  readonly source: "capsule_output";
  readonly runId?: string;
  readonly stateVersionId?: string;
  readonly outputId: string;
  readonly outputDigest: string;
  readonly outputName: string;
  readonly pointer?: string;
}

export interface InterfaceResourceOutputProvenance {
  readonly source: "resource_output";
  readonly resourceId: string;
  readonly resourceGeneration: number;
  readonly outputName?: string;
  readonly pointer?: string;
}

export interface InterfaceLiteralProvenance {
  readonly source: "literal";
  readonly specGeneration: number;
}

export type InterfaceInputProvenance =
  | InterfaceCapsuleOutputProvenance
  | InterfaceResourceOutputProvenance
  | InterfaceLiteralProvenance;

export interface InterfaceStatus {
  readonly phase: InterfacePhase;
  readonly observedGeneration: number;
  readonly resolvedRevision: number;
  readonly resolvedInputs?: Readonly<Record<string, JsonValue>>;
  readonly provenance?: Readonly<Record<string, InterfaceInputProvenance>>;
  readonly conditions?: readonly Condition[];
}

export interface Interface {
  readonly apiVersion: typeof TAKOSUMI_API_VERSION;
  readonly kind: "Interface";
  readonly metadata: InterfaceMetadata;
  readonly spec: InterfaceSpec;
  readonly status: InterfaceStatus;
}

export type InterfaceSubjectKind =
  "Principal" | "ServiceAccount" | "Capsule" | "Resource";

export interface InterfaceSubjectRef {
  readonly kind: InterfaceSubjectKind;
  readonly id: string;
}

export interface InterfaceBindingDelivery {
  /**
   * Open capability token. Core implements `none` and `oauth2`;
   * `workload_token` is reserved and remains NotReady in v1alpha1.
   */
  readonly type: string;
  /** `secret/...` or `credential/...` reference; never the credential value. */
  readonly credentialRef?: string;
  readonly options?: JsonObject;
}

export type InterfaceBindingPhase =
  "Pending" | "Ready" | "NotReady" | "Revoked";

export interface InterfaceBindingSpec {
  readonly interfaceId: string;
  readonly subjectRef: InterfaceSubjectRef;
  readonly permissions: readonly string[];
  readonly delivery: InterfaceBindingDelivery;
}

export interface InterfaceBindingStatus {
  readonly phase: InterfaceBindingPhase;
  readonly observedInterfaceRevision: number;
  readonly conditions?: readonly Condition[];
}

export interface InterfaceBinding {
  readonly apiVersion: typeof TAKOSUMI_API_VERSION;
  readonly kind: "InterfaceBinding";
  readonly metadata: {
    readonly id: string;
    readonly workspaceId: string;
    readonly generation: number;
    /** Immutable service-side one-shot materialization marker. */
    readonly materializedFrom?:
      | {
          readonly source: "capsule_blueprint";
          readonly interfaceKey: string;
          readonly key: string;
        }
      | {
          /** Scoped compatibility control translated into this canonical Binding. */
          readonly source: "compatibility_profile";
          readonly profile: string;
          readonly key: string;
        };
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly spec: InterfaceBindingSpec;
  readonly status: InterfaceBindingStatus;
}

/**
 * Canonical snapshot delivered to an operator-owned runtime projector after an
 * Interface or one of its Bindings changes. The Interface/Binding stores stay
 * lifecycle authority; a sink may only materialize a recoverable routing or
 * activation projection and must fence writes by the supplied generations.
 */
export interface InterfaceProjectionSnapshot {
  readonly interface: Interface;
  readonly bindings: readonly InterfaceBinding[];
  /**
   * Canonical Resource evidence attached by Core for a Resource-owned
   * Interface. Hosts may cache this evidence, but must re-resolve the current
   * Resource/Interface before serving runtime traffic.
   */
  readonly ownerResource?: {
    readonly id: string;
    readonly generation: number;
    readonly nativeResources: readonly NativeResourceRef[];
  };
}

/**
 * Optional host projection port. Delivery is best-effort after the canonical
 * write, so hosts must make `project` idempotent and run a bounded repair scan
 * from the canonical Interface list. Projection failure never rolls back the
 * Interface or turns the projection into a second lifecycle ledger.
 */
export interface InterfaceProjectionSink {
  project(snapshot: InterfaceProjectionSnapshot): Promise<void>;
}

export interface CreateInterfaceRequest {
  readonly workspaceId: string;
  readonly name: string;
  readonly ownerRef: InterfaceOwnerRef;
  readonly labels?: Readonly<Record<string, string>>;
  readonly spec: InterfaceSpec;
}

export type CapsuleInterfaceBlueprintInput =
  | InterfaceLiteralInput
  | Omit<InterfaceCapsuleOutputInput, "capsuleId">
  | InterfaceResourceOutputInput;

interface CapsuleInterfaceBindingProposalBase {
  /** Stable identity within the parent Interface blueprint. */
  readonly key: string;
  readonly permissions: readonly string[];
  readonly delivery: InterfaceBindingDelivery;
}

/**
 * Install-time subject placeholder for a service-owned Interface blueprint.
 * The Capsule create path resolves this to the authenticated installing
 * Principal before it persists the Workspace-scoped InstallConfig. It is never
 * written to an InterfaceBinding and never means a wildcard grant.
 */
export interface CapsuleInterfaceInstallingPrincipalSubject {
  readonly source: "installing_principal";
}

export type CapsuleInterfaceBindingProposal =
  | (CapsuleInterfaceBindingProposalBase & {
      /** Fixed service-side subject, used for non-interactive compositions. */
      readonly subjectRef: InterfaceSubjectRef;
      readonly subject?: never;
    })
  | (CapsuleInterfaceBindingProposalBase & {
      /** Resolve to `{ kind: "Principal", id: installingPrincipalId }`. */
      readonly subject: CapsuleInterfaceInstallingPrincipalSubject;
      readonly subjectRef?: never;
    });

/**
 * Service-side proposal attached to an InstallConfig. It is not repository
 * metadata: Takosumi materializes it into an ordinary Interface record only
 * after a successful Capsule apply, substituting the created Capsule id into
 * `capsule_output` inputs.
 */
export interface CapsuleInterfaceBlueprint {
  /** Stable service-side identity, independent from the editable display name. */
  readonly key: string;
  readonly name: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly spec: Omit<InterfaceSpec, "inputs"> & {
    readonly inputs?: Readonly<Record<string, CapsuleInterfaceBlueprintInput>>;
  };
  /** One-shot, service-side binding proposals; never repository metadata. */
  readonly bindings?: readonly CapsuleInterfaceBindingProposal[];
}

/** True when a blueprint still needs the authenticated installer identity. */
export function capsuleInterfaceBlueprintsNeedInstallingPrincipal(
  blueprints: readonly CapsuleInterfaceBlueprint[] | undefined,
): boolean {
  return (blueprints ?? []).some((blueprint) =>
    (blueprint.bindings ?? []).some(
      (proposal) => proposal.subject?.source === "installing_principal",
    ),
  );
}

/**
 * Resolve installer placeholders while cloning an InstallConfig for one
 * Workspace. SourceSnapshot/apply repair later sees only durable, exact
 * Principal ids, so a restart can never reinterpret "installer" as whoever
 * happened to trigger a later Run.
 */
export function resolveCapsuleInterfaceBlueprintInstallingPrincipal(
  blueprints: readonly CapsuleInterfaceBlueprint[] | undefined,
  installingPrincipalId: string,
): readonly CapsuleInterfaceBlueprint[] | undefined {
  if (blueprints === undefined) return undefined;
  const principalId = installingPrincipalId.trim();
  if (principalId === "") {
    throw new TypeError("installingPrincipalId must be a non-empty string");
  }
  if (!capsuleInterfaceBlueprintsNeedInstallingPrincipal(blueprints)) {
    return blueprints;
  }
  return blueprints.map((blueprint) => ({
    ...blueprint,
    ...(blueprint.bindings
      ? {
          bindings: blueprint.bindings.map((proposal) => {
            if (proposal.subject?.source !== "installing_principal") {
              return proposal;
            }
            const { subject: _subject, ...fixedProposal } = proposal;
            return {
              ...fixedProposal,
              subjectRef: { kind: "Principal", id: principalId },
            } satisfies CapsuleInterfaceBindingProposal;
          }),
        }
      : {}),
  }));
}

export interface UpdateInterfaceRequest {
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly spec?: InterfaceSpec;
}

/**
 * Status-plane self-report body. Conditions merge by type while desired spec,
 * phase, resolved inputs, provenance, and resolved revision remain fenced.
 */
export interface ReportInterfaceStatusRequest {
  readonly conditions: readonly Condition[];
}

export interface ListInterfacesResponse {
  readonly interfaces: readonly Interface[];
}

export interface CreateInterfaceBindingRequest {
  readonly subjectRef: InterfaceSubjectRef;
  readonly permissions: readonly string[];
  readonly delivery: InterfaceBindingDelivery;
}

export interface IssueInterfaceTokenRequest {
  readonly permission: string;
}

/** OAuth-style response for an invocation-time Principal credential. */
export interface IssueInterfaceTokenResponse {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly expires_at: string;
  readonly scope: string;
  readonly resource: string;
}

export interface ListInterfaceBindingsResponse {
  readonly bindings: readonly InterfaceBinding[];
}
