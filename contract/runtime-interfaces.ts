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


/** Explicit app-shared data delegation; never implied by ordinary oauth2. */
export const INTERFACE_APP_DATA_DELIVERY = "oauth2.app-data.v1" as const;
export const INTERFACE_APP_DATA_SCOPE = "app-shared.v1" as const;
export const INTERFACE_APP_DATA_CONTRACT = "takosumi.interface-app-data/v1" as const;

/** Authenticated issuer evidence. Parsing this object alone does not authenticate it. */
export interface InterfaceAppDataAuthority {
  readonly contract: typeof INTERFACE_APP_DATA_CONTRACT;
  readonly namespace_id: string;
  readonly consumer_capsule_id: string;
  readonly provider_capsule_id: string;
  readonly ownership_epoch: number;
  readonly provider_ownership_epoch: number;
  readonly app_role: "owner" | "member";
  readonly interface_link_id: string;
  readonly interface_link_generation: number;
  readonly interface_binding_generation: number;
  readonly interface_generation: number;
}

export function isInterfaceAppDataAuthority(value: unknown): value is InterfaceAppDataAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = ["contract", "namespace_id", "consumer_capsule_id", "provider_capsule_id", "ownership_epoch",
    "provider_ownership_epoch", "app_role", "interface_link_id", "interface_link_generation", "interface_binding_generation", "interface_generation"];
  const text = (field: string) => typeof record[field] === "string" && (record[field] as string).length > 0 &&
    (record[field] as string).length <= 512 && !/\s/u.test(record[field] as string);
  return Object.keys(record).length === keys.length && Object.keys(record).every(key => keys.includes(key)) &&
    record.contract === INTERFACE_APP_DATA_CONTRACT && typeof record.namespace_id === "string" &&
    /^appd_[0-9a-f]{64}$/u.test(record.namespace_id) &&
    ["consumer_capsule_id", "provider_capsule_id", "interface_link_id"].every(text) &&
    (record.app_role === "owner" || record.app_role === "member") &&
    ["ownership_epoch", "provider_ownership_epoch"].every(key => typeof record[key] === "number" &&
      Number.isSafeInteger(record[key]) && (record[key] as number) >= 0) &&
    ["interface_link_generation", "interface_binding_generation", "interface_generation"].every(key =>
      typeof record[key] === "number" && Number.isSafeInteger(record[key]) && (record[key] as number) > 0);
}
