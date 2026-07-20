import type { IsoTimestamp, JsonObject, JsonValue } from "./types.ts";
import type {
  OfferingContextReference,
  OfferingRequirementReference,
  OfferingSubjectReference,
} from "./offerings.ts";

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

export function isInstalledFormReference(
  value: unknown,
): value is InstalledFormReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("formRef") ||
    !keys.includes("packageDigest")
  ) {
    return false;
  }
  const candidate = value as Partial<
    Record<keyof InstalledFormReference, unknown>
  >;
  return (
    isFormRef(candidate.formRef) && isSha256Digest(candidate.packageDigest)
  );
}

export type FormOperation =
  "create" | "read" | "update" | "delete" | "import" | "refresh";

/** Portable, data-only mapping sources every conforming host understands. */
export const PORTABLE_INTERFACE_INPUT_SOURCES = ["literal", "output"] as const;
export type PortableInterfaceInputSource =
  (typeof PORTABLE_INTERFACE_INPUT_SOURCES)[number];

export function isPortableInterfaceInputSource(
  value: unknown,
): value is PortableInterfaceInputSource {
  return (
    typeof value === "string" &&
    (PORTABLE_INTERFACE_INPUT_SOURCES as readonly string[]).includes(value)
  );
}

/** One deterministic, non-executable input mapping declared by a Form. */
export interface FormInterfaceInputDeclaration {
  readonly name: string;
  readonly source: string;
  /** RFC 6901 pointer into the source document. Empty selects the whole value. */
  readonly pointer?: string;
  /** Exact JSON literal. Valid only for `source: literal`. */
  readonly value?: JsonValue;
}

/**
 * One portable runtime-interface declaration. Its exact identity is
 * `(name, version)`. It grants no access and owns no host lifecycle state.
 */
export interface FormInterfaceDescriptor {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly required?: boolean;
  /** Exact non-secret document copied by a host; omitted means `{}`. */
  readonly document?: JsonObject;
  /** Portable schema already verified with the containing Form Package. */
  readonly documentSchema?: JsonObject;
  readonly inputs?: readonly FormInterfaceInputDeclaration[];
}

/** Portable, data-only definition metadata exposed by the host registry. */
export interface FormDefinition {
  readonly identity: InstalledFormReference;
  readonly displayName?: string;
  readonly description?: string;
  readonly operations: readonly FormOperation[];
  readonly metadata?: JsonObject;
  readonly interfaceDescriptors?: readonly FormInterfaceDescriptor[];
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

/** Open Offering subject type installed by the portable Form host adapter. */
export const SERVICE_FORM_OFFERING_SUBJECT_TYPE =
  "forms.takoform.com/v1alpha1/Form" as const;

/** Exact OSS prerequisite type used by a Form-backed Offering. */
export const FORM_ACTIVATION_OFFERING_REQUIREMENT_TYPE =
  "takosumi.dev/v1alpha1/FormActivation" as const;

/** Exact Resource namespace context consumed by the built-in Form resolver. */
export const FORM_HOST_RESOURCE_NAMESPACE_OFFERING_CONTEXT_TYPE =
  "takosumi.dev/v1alpha1/ResourceNamespace" as const;

export function formHostResourceNamespaceOfferingContext(
  id: string,
): OfferingContextReference {
  if (
    typeof id !== "string" ||
    id.trim() === "" ||
    id.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(id)
  ) {
    throw new TypeError("invalid Form host Resource namespace context");
  }
  return {
    type: FORM_HOST_RESOURCE_NAMESPACE_OFFERING_CONTEXT_TYPE,
    id,
  };
}

/**
 * Projects an installed Form into the generic Offering subject vocabulary.
 * The opaque ref retains the full FormRef (including schema digest), while the
 * subject digest pins the containing immutable package.
 */
export function formOfferingSubject(
  identity: InstalledFormReference,
): OfferingSubjectReference {
  if (!isInstalledFormReference(identity)) {
    throw new TypeError("invalid installed Form identity for Offering");
  }
  return {
    type: SERVICE_FORM_OFFERING_SUBJECT_TYPE,
    ref: formRefKey(identity.formRef),
    version: identity.formRef.definitionVersion,
    digest: identity.packageDigest,
  };
}

/** Exact activation revision re-read by the Form Offering resolver. */
export function formActivationOfferingRequirement(
  activation: Pick<FormActivation, "id" | "revision">,
): OfferingRequirementReference {
  if (
    typeof activation.id !== "string" ||
    activation.id.trim() === "" ||
    !Number.isSafeInteger(activation.revision) ||
    activation.revision < 1
  ) {
    throw new TypeError("invalid FormActivation reference for Offering");
  }
  return {
    type: FORM_ACTIVATION_OFFERING_REQUIREMENT_TYPE,
    ref: activation.id,
    version: String(activation.revision),
  };
}

export type FormAvailabilityReason =
  | "definition_unknown"
  | "package_not_installed"
  | "package_deprecated"
  | "package_revoked"
  | "schema_unavailable"
  | "interface_capability_missing"
  | "implementation_unavailable"
  | "adapter_unavailable"
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
  readonly executableReason?: FormAvailabilityReason;
  readonly activated: boolean;
  readonly availableToPrincipal: boolean;
  readonly availabilityReason?: FormAvailabilityReason;
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

/** Reverses the opaque exact FormRef key without accepting partial identity. */
export function parseFormRefKey(value: string): FormRef | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split("|");
  if (parts.length !== 4) return undefined;
  try {
    const ref: FormRef = {
      apiVersion: decodeURIComponent(parts[0]!),
      kind: decodeURIComponent(parts[1]!),
      definitionVersion: decodeURIComponent(parts[2]!),
      schemaDigest: decodeURIComponent(parts[3]!),
    };
    return isFormRef(ref) && formRefKey(ref) === value ? ref : undefined;
  } catch {
    return undefined;
  }
}

export function installedFormReferenceKey(
  identity: InstalledFormReference,
): string {
  if (!isInstalledFormReference(identity)) {
    throw new TypeError("invalid exact installed Form reference");
  }
  return `${formRefKey(identity.formRef)}|${identity.packageDigest}`;
}
