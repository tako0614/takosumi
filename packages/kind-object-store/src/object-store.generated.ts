// AUTO-GENERATED FROM package-owned kind descriptor spec/kind.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface ObjectStoreSpec {
  /** Logical bucket name (provider applies its own scoping rules). */
  readonly name: string;
  /** Request anonymous-read policy when true. Operator policy and the selected implementation materialize or reject the request. */
  readonly public?: boolean;
  /** Provider region (when applicable). */
  readonly region?: string;
  /** Request object versioning. Operator policy and the selected implementation materialize or reject the request. */
  readonly versioning?: boolean;
  readonly [extension: string]: unknown;
}

export interface ObjectStoreOutputs {
  /** Provider-scope bucket name. */
  readonly bucket: string;
  /** S3-class endpoint URL. */
  readonly endpoint: string;
  /** Bucket region. */
  readonly region: string;
  /** Reference to secret store entry holding access key id. */
  readonly accessKeyRef: string;
  /** Reference to secret store entry holding secret access key. */
  readonly secretKeyRef: string;
}

export type ObjectStoreCapabilityTerm =
  | "versioning"
  | "presigned-urls"
  | "server-side-encryption"
  | "public-access"
  | "event-notifications"
  | "lifecycle-rules"
  | "multipart-upload";

export type ObjectStorePublicationName = "bucket";

export type ObjectStorePublicationContract = "object-store";

export interface ObjectStorePublicationDescriptor {
  readonly name: ObjectStorePublicationName;
  readonly contract: ObjectStorePublicationContract;
  readonly exampleMaterialMapping?: Readonly<Record<string, unknown>>;
}

export const OBJECT_STORE_CAPABILITY_TERMS:
  readonly ObjectStoreCapabilityTerm[] = [
    "versioning",
    "presigned-urls",
    "server-side-encryption",
    "public-access",
    "event-notifications",
    "lifecycle-rules",
    "multipart-upload",
  ];

export const OBJECT_STORE_OUTPUT_FIELDS: readonly string[] = [
  "bucket",
  "endpoint",
  "region",
  "accessKeyRef",
  "secretKeyRef",
];

// referenceAliases are catalog suggestions only; operator profiles activate aliases explicitly.
export const OBJECT_STORE_ALIASES: readonly string[] = [
  "object-store",
];

export const OBJECT_STORE_PUBLICATIONS: readonly ObjectStorePublicationName[] =
  [
    "bucket",
  ];

export const OBJECT_STORE_PUBLICATION_DESCRIPTORS:
  readonly ObjectStorePublicationDescriptor[] = [
    {
      name: "bucket",
      contract: "object-store",
      exampleMaterialMapping: {
        "bucket": "$outputs.bucket",
        "endpoint": "$outputs.endpoint",
        "region": "$outputs.region",
        "accessKeyIdRef": {
          "secretRef": "$outputs.accessKeyRef",
        },
        "secretAccessKeyRef": {
          "secretRef": "$outputs.secretKeyRef",
        },
      },
    },
  ];
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
  "Bucket-style object storage intended to be bindable across compatible S3-class providers. Publishes endpoint + credential refs as a local publication.";
