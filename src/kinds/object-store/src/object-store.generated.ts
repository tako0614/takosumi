// AUTO-GENERATED FROM package-owned kind descriptor spec/kind.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface ObjectStoreSpec {
  /** Logical bucket name (operator applies implementation scoping rules). */
  readonly name: string;
}

export interface ObjectStoreOutputs {
  /** Implementation-scoped bucket name. */
  readonly bucket: string;
  /** S3-class endpoint URL. */
  readonly endpoint: string;
  /** Bucket region. */
  readonly region?: string;
  /** Reference to secret store entry holding the access key id. */
  readonly accessKeyIdRef?: string;
  /** Reference to secret store entry holding the secret access key. */
  readonly secretAccessKeyRef?: string;
}

export type ObjectStoreCapabilityTerm = "s3-compatible";

export type ObjectStoreOutputFieldName =
  | "bucket"
  | "endpoint"
  | "region"
  | "accessKeyIdRef"
  | "secretAccessKeyRef";

export type ObjectStoreOutputSlotName = "bucket";

export type ObjectStoreOutputSlotContract = "object-store";

export interface ObjectStoreOutputSlotDescriptor {
  readonly name: ObjectStoreOutputSlotName;
  readonly contract: ObjectStoreOutputSlotContract;
  readonly exampleMaterialMapping?: Readonly<Record<string, unknown>>;
}

export interface ObjectStoreListenSlotDescriptor {
  readonly name: string;
  readonly accepts?: readonly string[];
  readonly projectionFamilies?: readonly string[];
  readonly projectionMatrix?: Readonly<Record<string, readonly string[]>>;
  readonly requiredWhenReferencedBy?: string;
  readonly minimumAccess?: string;
  readonly safeDefaultAccess?: string | null;
}

export const OBJECT_STORE_CAPABILITY_TERMS:
  readonly ObjectStoreCapabilityTerm[] = [
    "s3-compatible",
  ];

export const OBJECT_STORE_OUTPUT_FIELDS: readonly ObjectStoreOutputFieldName[] =
  [
    "bucket",
    "endpoint",
    "region",
    "accessKeyIdRef",
    "secretAccessKeyRef",
  ];

// referenceAliases are catalog suggestions only; operator distributions activate aliases explicitly.
export const OBJECT_STORE_ALIASES: readonly string[] = [
  "object-store",
];

export const OBJECT_STORE_OUTPUT_SLOTS: readonly ObjectStoreOutputSlotName[] = [
  "bucket",
];

export const OBJECT_STORE_OUTPUT_SLOT_DESCRIPTORS:
  readonly ObjectStoreOutputSlotDescriptor[] = [
    {
      name: "bucket",
      contract: "object-store",
      exampleMaterialMapping: {
        "bucket": "$outputs.bucket",
        "endpoint": "$outputs.endpoint",
        "region": "$outputs.region",
        "accessKeyIdRef": {
          "secretRef": "$outputs.accessKeyIdRef",
        },
        "secretAccessKeyRef": {
          "secretRef": "$outputs.secretAccessKeyRef",
        },
      },
    },
  ];

export const OBJECT_STORE_LISTEN_SLOTS:
  readonly ObjectStoreListenSlotDescriptor[] = [];
// Legacy connector-local Shape.id. AppSpec kind identity is the KIND_URI.
export const OBJECT_STORE_KIND_SHAPE_ID = "object-store";
/** @deprecated Use OBJECT_STORE_KIND_URI for AppSpec kind identity, or OBJECT_STORE_KIND_SHAPE_ID for legacy Shape.id. */
export const OBJECT_STORE_KIND_ID = OBJECT_STORE_KIND_SHAPE_ID;
export const OBJECT_STORE_KIND_NAME = "object-store";
// Official catalog descriptor URI used in AppSpec kind resolution.
export const OBJECT_STORE_KIND_URI =
  "https://takosumi.com/kinds/v1/object-store";
export const OBJECT_STORE_KIND_VERSION = "v1";
export const OBJECT_STORE_DESCRIPTION =
  "Bucket-style object storage intended to be bindable across compatible S3-class providers. Backend-specific placement, versioning, and public access controls belong to native object-store kinds.";
