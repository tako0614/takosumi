import type { IsoTimestamp, JsonObject } from "./types.ts";

/**
 * Exact, immutable identity of one portable Service Form definition.
 *
 * `packageDigest` is deliberately not part of this tuple. It identifies the
 * containing immutable package envelope and is persisted beside a FormRef.
 */
export interface FormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
}

/** Exact installed identity used by Resources, locks, Runs, and activations. */
export interface InstalledFormReference {
  readonly formRef: FormRef;
  readonly packageDigest: string;
}

export type FormOperation =
  "create" | "read" | "update" | "delete" | "import" | "refresh";

/** Portable, data-only definition metadata exposed by the host registry. */
export interface FormDefinition {
  readonly identity: InstalledFormReference;
  readonly displayName?: string;
  readonly description?: string;
  readonly operations: readonly FormOperation[];
  readonly metadata?: JsonObject;
  readonly installedAt: IsoTimestamp;
}

export type FormPackageLifecycleStatus = "installed" | "deprecated" | "revoked";

/**
 * Host record for one verified, immutable, data-only package.
 * `artifactRef` is opaque to Core; an injected reader/verifier owns its format.
 */
export interface FormPackage {
  readonly packageDigest: string;
  readonly artifactRef: string;
  readonly verifierId: string;
  readonly status: FormPackageLifecycleStatus;
  readonly definitionRefs: readonly FormRef[];
  readonly installedAt: IsoTimestamp;
  readonly installedBy: string;
  readonly updatedAt: IsoTimestamp;
  readonly deprecatedAt?: IsoTimestamp;
  readonly revokedAt?: IsoTimestamp;
}

export type FormActivationStatus = "active" | "inactive";

export type FormActivationScope =
  | { readonly type: "operator" }
  | { readonly type: "workspace"; readonly id: string }
  | { readonly type: "space"; readonly id: string };

/** Principal-facing audience policy; it contains no runtime credentials. */
export interface FormActivationAudience {
  readonly public?: boolean;
  readonly principalIds?: readonly string[];
  readonly roles?: readonly string[];
}

/**
 * Generic OSS activation policy. Commercial offerings, price, SKU, SLA,
 * region inventory, and managed capacity remain outside this contract.
 */
export interface FormActivation {
  readonly id: string;
  readonly identity: InstalledFormReference;
  readonly scope: FormActivationScope;
  readonly audience: FormActivationAudience;
  readonly policy: JsonObject;
  readonly eligibleTargetPoolClasses: readonly string[];
  readonly status: FormActivationStatus;
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: string;
  readonly updatedAt: IsoTimestamp;
  readonly updatedBy: string;
}

export type FormAvailabilityReason =
  | "definition_unknown"
  | "package_not_installed"
  | "package_deprecated"
  | "package_revoked"
  | "implementation_unavailable"
  | "activation_missing"
  | "activation_inactive"
  | "principal_not_allowed"
  | "target_pool_class_unavailable";

/** Structured discovery state for one exact FormRef. */
export interface FormAvailability {
  readonly identity: InstalledFormReference;
  readonly definitionKnown: boolean;
  readonly installed: boolean;
  readonly executable: boolean;
  readonly activated: boolean;
  readonly availableToPrincipal: boolean;
  readonly reasons: readonly FormAvailabilityReason[];
  readonly operations: readonly FormOperation[];
  readonly compatibleAdapterIds: readonly string[];
  readonly eligibleTargetPoolClasses: readonly string[];
  readonly deprecated: boolean;
}

const FORM_TOKEN_RE = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/u;
const FORM_KIND_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const FORM_VERSION_RE =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

export function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && SHA256_DIGEST_RE.test(value);
}

export function isFormRef(value: unknown): value is FormRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !["apiVersion", "kind", "definitionVersion", "schemaDigest"].every((key) =>
      keys.includes(key),
    )
  ) {
    return false;
  }
  const candidate = value as Partial<Record<keyof FormRef, unknown>>;
  return (
    typeof candidate.apiVersion === "string" &&
    FORM_TOKEN_RE.test(candidate.apiVersion) &&
    typeof candidate.kind === "string" &&
    FORM_KIND_RE.test(candidate.kind) &&
    typeof candidate.definitionVersion === "string" &&
    FORM_VERSION_RE.test(candidate.definitionVersion) &&
    isSha256Digest(candidate.schemaDigest)
  );
}

export function formRefKey(ref: FormRef): string {
  if (!isFormRef(ref)) throw new TypeError("invalid exact FormRef");
  return [ref.apiVersion, ref.kind, ref.definitionVersion, ref.schemaDigest]
    .map(encodeURIComponent)
    .join("|");
}

export function installedFormReferenceKey(
  identity: InstalledFormReference,
): string {
  if (!isSha256Digest(identity.packageDigest)) {
    throw new TypeError("invalid Form Package digest");
  }
  return `${formRefKey(identity.formRef)}|${identity.packageDigest}`;
}
