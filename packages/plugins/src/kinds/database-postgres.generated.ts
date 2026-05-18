// AUTO-GENERATED FROM spec/contexts/kinds/v1/database-postgres.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface DatabasePostgresBackups {
  readonly enabled: boolean;
  readonly retentionDays?: number;
}

export interface DatabasePostgresStorage {
  readonly sizeGiB: number;
  readonly type?: "ssd" | "hdd";
}

export interface DatabasePostgresSpec {
  /** Instance size class. */
  readonly size: "small" | "medium" | "large" | "xlarge";
  /** PostgreSQL major version string (e.g. `15`, `16`). */
  readonly version: string;
  /** Managed backup policy. */
  readonly backups?: DatabasePostgresBackups;
  /** PostgreSQL extensions to enable (e.g. `pgvector`). */
  readonly extensions?: readonly string[];
  /** Enable provider-managed HA replica. */
  readonly highAvailability?: boolean;
  /** Persistent volume sizing. */
  readonly storage?: DatabasePostgresStorage;
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
  /** Full client connection URL (secret-bearing). */
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

export const DATABASE_POSTGRES_KIND_ID = "database-postgres";
export const DATABASE_POSTGRES_KIND_VERSION = "v1";
export const DATABASE_POSTGRES_DESCRIPTION =
  "Managed PostgreSQL instance. Provider-portable via standard wire protocol.";
