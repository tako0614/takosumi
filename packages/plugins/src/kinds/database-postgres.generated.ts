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
  /** Enable provider-managed HA replica. */
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

export type DatabasePostgresCapability =
  | "pitr"
  | "read-replicas"
  | "high-availability"
  | "backups"
  | "ssl-required"
  | "ipv6"
  | "extensions";

export type DatabasePostgresPublicationName = "connection";

export type DatabasePostgresListenBindingName = never;

export const DATABASE_POSTGRES_CAPABILITIES:
  readonly DatabasePostgresCapability[] = [
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

export const DATABASE_POSTGRES_ALIASES: readonly string[] = [
  "postgres",
];

export const DATABASE_POSTGRES_PUBLICATIONS:
  readonly DatabasePostgresPublicationName[] = [
    "connection",
  ];

export const DATABASE_POSTGRES_LISTEN_BINDINGS:
  readonly DatabasePostgresListenBindingName[] = [];

export const DATABASE_POSTGRES_KIND_ID = "postgres";
export const DATABASE_POSTGRES_KIND_NAME = "postgres";
export const DATABASE_POSTGRES_KIND_URI =
  "https://takosumi.com/kinds/v1/postgres";
export const DATABASE_POSTGRES_KIND_VERSION = "v1";
export const DATABASE_POSTGRES_DESCRIPTION =
  "Managed PostgreSQL instance. Provider-portable via standard wire protocol. Publishes connection material as a local publication.";
