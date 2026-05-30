// AUTO-GENERATED FROM package-owned kind descriptor spec/kind.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface VectorStoreSpec {
  /** Vector dimensions. */
  readonly dimensions: number;
  /** Distance metric. */
  readonly metric: "cosine" | "euclidean" | "dot-product";
  /** Index name. */
  readonly name: string;
}

export interface VectorStoreOutputs {
  /** Implementation-scoped index identifier. */
  readonly indexId: string;
  /** Index name. */
  readonly name: string;
  /** Index endpoint URL if available. */
  readonly url?: string;
  /** Secret reference for clients that need token-based access. */
  readonly tokenSecretRef?: string;
}

export type VectorStoreCapabilityTerm =
  | "vector-upsert"
  | "vector-query"
  | "vector-delete";

export type VectorStoreOutputFieldName =
  | "indexId"
  | "name"
  | "url"
  | "tokenSecretRef";

export type VectorStoreOutputSlotName = "index";

export type VectorStoreOutputSlotContract = "service-binding";

export interface VectorStoreOutputSlotDescriptor {
  readonly name: VectorStoreOutputSlotName;
  readonly contract: VectorStoreOutputSlotContract;
  readonly exampleMaterialMapping?: Readonly<Record<string, unknown>>;
}

export interface VectorStoreListenSlotDescriptor {
  readonly name: string;
  readonly accepts?: readonly string[];
  readonly projectionFamilies?: readonly string[];
  readonly projectionMatrix?: Readonly<Record<string, readonly string[]>>;
  readonly requiredWhenReferencedBy?: string;
  readonly minimumAccess?: string;
  readonly safeDefaultAccess?: string | null;
}

export const VECTOR_STORE_CAPABILITY_TERMS:
  readonly VectorStoreCapabilityTerm[] = [
    "vector-upsert",
    "vector-query",
    "vector-delete",
  ];

export const VECTOR_STORE_OUTPUT_FIELDS: readonly VectorStoreOutputFieldName[] =
  [
    "indexId",
    "name",
    "url",
    "tokenSecretRef",
  ];

// referenceAliases are catalog suggestions only; operator distributions activate aliases explicitly.
export const VECTOR_STORE_ALIASES: readonly string[] = [
  "vector-store",
];

export const VECTOR_STORE_OUTPUT_SLOTS: readonly VectorStoreOutputSlotName[] = [
  "index",
];

export const VECTOR_STORE_OUTPUT_SLOT_DESCRIPTORS:
  readonly VectorStoreOutputSlotDescriptor[] = [
    {
      name: "index",
      contract: "service-binding",
      exampleMaterialMapping: {
        "service": "$outputs.indexId",
        "protocol": "vector",
        "connectionUrl": "$outputs.url",
        "tokenRef": {
          "secretRef": "$outputs.tokenSecretRef",
        },
      },
    },
  ];

export const VECTOR_STORE_LISTEN_SLOTS:
  readonly VectorStoreListenSlotDescriptor[] = [];
// Legacy connector-local Shape.id. AppSpec kind identity is the KIND_URI.
export const VECTOR_STORE_KIND_SHAPE_ID = "vector-store";
/** @deprecated Use VECTOR_STORE_KIND_URI for AppSpec kind identity, or VECTOR_STORE_KIND_SHAPE_ID for legacy Shape.id. */
export const VECTOR_STORE_KIND_ID = VECTOR_STORE_KIND_SHAPE_ID;
export const VECTOR_STORE_KIND_NAME = "vector-store";
// Official catalog descriptor URI used in AppSpec kind resolution.
export const VECTOR_STORE_KIND_URI =
  "https://takosumi.com/kinds/v1/vector-store";
export const VECTOR_STORE_KIND_VERSION = "v1";
export const VECTOR_STORE_DESCRIPTION =
  "Vector index for embeddings, similarity search, and vector metadata operations.";
