// AUTO-GENERATED FROM package-owned kind descriptor spec/kind.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface KvStoreSpec {
  /** Store name. */
  readonly name: string;
}

export interface KvStoreOutputs {
  /** Implementation-scoped store identifier. */
  readonly storeId: string;
  /** Store name. */
  readonly name: string;
  /** Connection URL if the implementation exposes one. */
  readonly url?: string;
  /** Secret reference for clients that need token-based access. */
  readonly tokenSecretRef?: string;
}

export type KvStoreCapabilityTerm =
  | "kv-read-write"
  | "kv-list";

export type KvStoreOutputFieldName =
  | "storeId"
  | "name"
  | "url"
  | "tokenSecretRef";

export type KvStoreOutputSlotName = "store";

export type KvStoreOutputSlotContract = "service-binding";

export interface KvStoreOutputSlotDescriptor {
  readonly name: KvStoreOutputSlotName;
  readonly contract: KvStoreOutputSlotContract;
  readonly exampleMaterialMapping?: Readonly<Record<string, unknown>>;
}

export interface KvStoreListenSlotDescriptor {
  readonly name: string;
  readonly accepts?: readonly string[];
  readonly projectionFamilies?: readonly string[];
  readonly projectionMatrix?: Readonly<Record<string, readonly string[]>>;
  readonly requiredWhenReferencedBy?: string;
  readonly minimumAccess?: string;
  readonly safeDefaultAccess?: string | null;
}

export const KV_STORE_CAPABILITY_TERMS: readonly KvStoreCapabilityTerm[] = [
  "kv-read-write",
  "kv-list",
];

export const KV_STORE_OUTPUT_FIELDS: readonly KvStoreOutputFieldName[] = [
  "storeId",
  "name",
  "url",
  "tokenSecretRef",
];

// referenceAliases are catalog suggestions only; operator distributions activate aliases explicitly.
export const KV_STORE_ALIASES: readonly string[] = [
  "kv-store",
  "kv",
];

export const KV_STORE_OUTPUT_SLOTS: readonly KvStoreOutputSlotName[] = [
  "store",
];

export const KV_STORE_OUTPUT_SLOT_DESCRIPTORS:
  readonly KvStoreOutputSlotDescriptor[] = [
    {
      name: "store",
      contract: "service-binding",
      exampleMaterialMapping: {
        "service": "$outputs.storeId",
        "protocol": "kv",
        "connectionUrl": "$outputs.url",
        "tokenRef": {
          "secretRef": "$outputs.tokenSecretRef",
        },
      },
    },
  ];

export const KV_STORE_LISTEN_SLOTS: readonly KvStoreListenSlotDescriptor[] = [];
// Legacy connector-local Shape.id. AppSpec kind identity is the KIND_URI.
export const KV_STORE_KIND_SHAPE_ID = "kv-store";
/** @deprecated Use KV_STORE_KIND_URI for AppSpec kind identity, or KV_STORE_KIND_SHAPE_ID for legacy Shape.id. */
export const KV_STORE_KIND_ID = KV_STORE_KIND_SHAPE_ID;
export const KV_STORE_KIND_NAME = "kv-store";
// Official catalog descriptor URI used in AppSpec kind resolution.
export const KV_STORE_KIND_URI = "https://takosumi.com/kinds/v1/kv-store";
export const KV_STORE_KIND_VERSION = "v1";
export const KV_STORE_DESCRIPTION = "Key-value store for small keyed values.";
