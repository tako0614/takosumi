import type { Condition, JsonObject, JsonValue } from "./types.ts";
import { TAKOSUMI_API_VERSION } from "./capabilities.ts";

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

export type InterfaceOwnerKind = "Workspace" | "Capsule";

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
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type InterfaceVisibility = "private" | "workspace" | "public";

export interface InterfaceAccessSpec {
  readonly visibility: InterfaceVisibility;
  readonly policyRef?: string;
  /** Resolved input whose value is the token audience/resource URI. */
  readonly resourceUriInput?: string;
}

/**
 * App-facing runtime declaration. The document stays opaque to Takosumi;
 * protocol consumers interpret it together with `status.resolvedInputs`.
 */
export interface InterfaceSpec {
  readonly type: string;
  readonly version: string;
  readonly document: JsonValue;
  /** Optional portable schema for the opaque document. */
  readonly documentSchema?: JsonObject;
  readonly access: InterfaceAccessSpec;
}

export type InterfacePhase =
  "Pending" | "Resolved" | "NotReady" | "Unknown" | "Terminating" | "Retired";

export interface InterfaceStatus {
  readonly phase: InterfacePhase;
  readonly observedGeneration: number;
  readonly resolvedRevision: number;
  readonly resolvedInputs?: Readonly<Record<string, JsonValue>>;
  /**
   * Canonical credential-free HTTPS audience resolved by the host. It is
   * discovery metadata, not a grant.
   */
  readonly resourceUri?: string;
  readonly conditions?: readonly Condition[];
}

export interface Interface {
  readonly apiVersion: typeof TAKOSUMI_API_VERSION;
  readonly kind: "Interface";
  readonly metadata: InterfaceMetadata;
  readonly spec: InterfaceSpec;
  readonly status: InterfaceStatus;
}

export type InterfaceSubjectKind = "Principal" | "ServiceAccount" | "Capsule";

export interface InterfaceSubjectRef {
  readonly kind: InterfaceSubjectKind;
  readonly id: string;
}

export interface InterfaceBindingDelivery {
  /**
   * Open delivery capability token. Current public values include `none` and
   * `oauth2`; unknown values remain valid for versioned extensions.
   */
  readonly type: string;
  /** Opaque credential reference; never the credential value. */
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
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly spec: InterfaceBindingSpec;
  readonly status: InterfaceBindingStatus;
}
