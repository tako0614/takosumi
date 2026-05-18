// AUTO-GENERATED FROM spec/contexts/kinds/v1/object-store.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface ObjectStoreLifecycle {
  readonly archiveAfterDays?: number;
  readonly expireAfterDays?: number;
}

export interface ObjectStoreSpec {
  /** Logical bucket name (provider applies its own scoping rules). */
  readonly name: string;
  /** Lifecycle rules for stored objects. */
  readonly lifecycle?: ObjectStoreLifecycle;
  /** Allow anonymous reads when true. */
  readonly public?: boolean;
  /** Provider region (when applicable). */
  readonly region?: string;
  /** Enable object versioning when supported. */
  readonly versioning?: boolean;
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

export type ObjectStoreCapability =
  | "versioning"
  | "presigned-urls"
  | "server-side-encryption"
  | "public-access"
  | "event-notifications"
  | "lifecycle-rules"
  | "multipart-upload";

export const OBJECT_STORE_CAPABILITIES: readonly ObjectStoreCapability[] = [
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

export const OBJECT_STORE_KIND_ID = "object-store";
export const OBJECT_STORE_KIND_VERSION = "v1";
export const OBJECT_STORE_DESCRIPTION =
  "Bucket-style object storage. Provider-portable across S3-class APIs.";
