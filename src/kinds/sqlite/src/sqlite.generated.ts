// AUTO-GENERATED FROM package-owned kind descriptor spec/kind.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface SqliteSpec {
  /** Database name. */
  readonly name: string;
}

export interface SqliteOutputs {
  /** Implementation-scoped database identifier. */
  readonly databaseId: string;
  /** Database name. */
  readonly name: string;
  /** Connection URL if the implementation exposes one. */
  readonly url?: string;
  /** Secret reference for clients that need token-based access. */
  readonly tokenSecretRef?: string;
}

export type SqliteCapabilityTerm =
  | "sqlite-wire"
  | "managed-credentials";

export type SqliteOutputFieldName =
  | "databaseId"
  | "name"
  | "url"
  | "tokenSecretRef";

export type SqliteOutputSlotName = "connection";

export type SqliteOutputSlotContract = "service-binding";

export interface SqliteOutputSlotDescriptor {
  readonly name: SqliteOutputSlotName;
  readonly contract: SqliteOutputSlotContract;
  readonly exampleMaterialMapping?: Readonly<Record<string, unknown>>;
}

export interface SqliteListenSlotDescriptor {
  readonly name: string;
  readonly accepts?: readonly string[];
  readonly projectionFamilies?: readonly string[];
  readonly projectionMatrix?: Readonly<Record<string, readonly string[]>>;
  readonly requiredWhenReferencedBy?: string;
  readonly minimumAccess?: string;
  readonly safeDefaultAccess?: string | null;
}

export const SQLITE_CAPABILITY_TERMS: readonly SqliteCapabilityTerm[] = [
  "sqlite-wire",
  "managed-credentials",
];

export const SQLITE_OUTPUT_FIELDS: readonly SqliteOutputFieldName[] = [
  "databaseId",
  "name",
  "url",
  "tokenSecretRef",
];

// referenceAliases are catalog suggestions only; operator distributions activate aliases explicitly.
export const SQLITE_ALIASES: readonly string[] = [
  "sqlite",
];

export const SQLITE_OUTPUT_SLOTS: readonly SqliteOutputSlotName[] = [
  "connection",
];

export const SQLITE_OUTPUT_SLOT_DESCRIPTORS:
  readonly SqliteOutputSlotDescriptor[] = [
    {
      name: "connection",
      contract: "service-binding",
      exampleMaterialMapping: {
        "service": "$outputs.databaseId",
        "protocol": "sqlite",
        "connectionUrl": "$outputs.url",
        "tokenRef": {
          "secretRef": "$outputs.tokenSecretRef",
        },
      },
    },
  ];

export const SQLITE_LISTEN_SLOTS: readonly SqliteListenSlotDescriptor[] = [];
// Legacy connector-local Shape.id. AppSpec kind identity is the KIND_URI.
export const SQLITE_KIND_SHAPE_ID = "sqlite";
/** @deprecated Use SQLITE_KIND_URI for AppSpec kind identity, or SQLITE_KIND_SHAPE_ID for legacy Shape.id. */
export const SQLITE_KIND_ID = SQLITE_KIND_SHAPE_ID;
export const SQLITE_KIND_NAME = "sqlite";
// Official catalog descriptor URI used in AppSpec kind resolution.
export const SQLITE_KIND_URI = "https://takosumi.com/kinds/v1/sqlite";
export const SQLITE_KIND_VERSION = "v1";
export const SQLITE_DESCRIPTION =
  "SQLite-compatible database for relational state in small and edge-oriented workloads.";
