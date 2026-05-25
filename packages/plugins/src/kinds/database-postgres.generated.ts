// AUTO-GENERATED FROM packages/plugins/spec/kinds/v1/postgres.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface DatabasePostgresStorage {
  readonly sizeGiB: number;
}

export interface DatabasePostgresSpec {
  /** Instance size class. */
  readonly size: "small" | "medium" | "large" | "xlarge";
  /** PostgreSQL major version string (e.g. `15`, `16`). */
  readonly version: string;
  /** Request provider-managed HA when supported. Operator policy and the selected implementation materialize or reject the request. */
  readonly highAvailability?: boolean;
  /** Persistent volume sizing. */
  readonly storage?: DatabasePostgresStorage;
  readonly [extension: string]: unknown;
}

export interface DatabasePostgresOutputs {
  /** Database hostname. */
  readonly host: string;
  /** TCP port (typically 5432). */
  readonly port: number;
  /** Database name. */
  readonly database: string;
  /** Connection username (role name). */
  readonly username: string;
  /** Reference to secret store entry holding password. */
  readonly passwordSecretRef: string;
  /** Passwordless client connection URL. Credentials are supplied through passwordSecretRef. */
  readonly connectionString: string;
}

export type DatabasePostgresCapabilityTerm =
  | "pitr"
  | "read-replicas"
  | "high-availability"
  | "backups"
  | "ssl-required"
  | "ipv6"
  | "extensions";

export type DatabasePostgresPublicationName = "connection";

export const DATABASE_POSTGRES_CAPABILITY_TERMS:
  readonly DatabasePostgresCapabilityTerm[] = [
    "pitr",
    "read-replicas",
    "high-availability",
    "backups",
    "ssl-required",
    "ipv6",
    "extensions",
  ];

export const DATABASE_POSTGRES_OUTPUT_FIELDS: readonly string[] = [
  "host",
  "port",
  "database",
  "username",
  "passwordSecretRef",
  "connectionString",
];

// referenceAliases are catalog suggestions only; operator profiles activate aliases explicitly.
export const DATABASE_POSTGRES_ALIASES: readonly string[] = [
  "postgres",
];

export const DATABASE_POSTGRES_PUBLICATIONS:
  readonly DatabasePostgresPublicationName[] = [
    "connection",
  ];
// Legacy connector-local Shape.id. AppSpec kind identity is the KIND_URI.
export const DATABASE_POSTGRES_KIND_SHAPE_ID = "postgres";
/** @deprecated Use DATABASE_POSTGRES_KIND_URI for AppSpec kind identity, or DATABASE_POSTGRES_KIND_SHAPE_ID for legacy Shape.id. */
export const DATABASE_POSTGRES_KIND_ID = DATABASE_POSTGRES_KIND_SHAPE_ID;
export const DATABASE_POSTGRES_KIND_NAME = "postgres";
// Official catalog descriptor URI used in AppSpec kind resolution.
export const DATABASE_POSTGRES_KIND_URI =
  "https://takosumi.com/kinds/v1/postgres";
export const DATABASE_POSTGRES_KIND_VERSION = "v1";
export const DATABASE_POSTGRES_DESCRIPTION =
  "Managed PostgreSQL instance intended to be bindable across compatible providers through the standard wire protocol. Publishes connection material as a local publication.";
