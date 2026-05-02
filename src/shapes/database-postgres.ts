import type { Shape, ShapeValidationIssue } from "takosumi-contract";
import {
  isNonEmptyString,
  isPositiveInteger,
  isRecord,
  optionalBoolean,
  optionalPositiveInteger,
  requireNonEmptyString,
  requirePositiveInteger,
  requireRoot,
} from "./_validators.ts";

export type DatabasePostgresCapability =
  | "pitr"
  | "read-replicas"
  | "high-availability"
  | "backups"
  | "ssl-required"
  | "ipv6"
  | "extensions";

export type DatabasePostgresSize = "small" | "medium" | "large" | "xlarge";

export interface DatabasePostgresStorage {
  readonly sizeGiB: number;
  readonly type?: "ssd" | "hdd";
}

export interface DatabasePostgresBackups {
  readonly enabled: boolean;
  readonly retentionDays?: number;
}

export interface DatabasePostgresSpec {
  readonly version: string;
  readonly size: DatabasePostgresSize;
  readonly storage?: DatabasePostgresStorage;
  readonly backups?: DatabasePostgresBackups;
  readonly highAvailability?: boolean;
  readonly extensions?: readonly string[];
}

export interface DatabasePostgresOutputs {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly passwordSecretRef: string;
  readonly connectionString: string;
}

const CAPABILITIES: readonly DatabasePostgresCapability[] = [
  "pitr",
  "read-replicas",
  "high-availability",
  "backups",
  "ssl-required",
  "ipv6",
  "extensions",
];

const OUTPUT_FIELDS: readonly string[] = [
  "host",
  "port",
  "database",
  "username",
  "passwordSecretRef",
  "connectionString",
];

const SIZES: ReadonlySet<string> = new Set([
  "small",
  "medium",
  "large",
  "xlarge",
]);

export const DatabasePostgresShape: Shape<
  DatabasePostgresSpec,
  DatabasePostgresOutputs,
  DatabasePostgresCapability
> = {
  id: "database-postgres",
  version: "v1",
  description:
    "Managed PostgreSQL instance. Provider-portable via standard wire protocol.",
  capabilities: CAPABILITIES,
  outputFields: OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.version, "$.version", issues);
    if (typeof value.size !== "string" || !SIZES.has(value.size)) {
      issues.push({
        path: "$.size",
        message: `must be one of: ${Array.from(SIZES).join(", ")}`,
      });
    }
    if (value.storage !== undefined) validateStorage(value.storage, issues);
    if (value.backups !== undefined) validateBackups(value.backups, issues);
    optionalBoolean(value.highAvailability, "$.highAvailability", issues);
    if (value.extensions !== undefined) {
      if (!Array.isArray(value.extensions)) {
        issues.push({ path: "$.extensions", message: "must be an array" });
      } else if (!value.extensions.every(isNonEmptyString)) {
        issues.push({
          path: "$.extensions",
          message: "must contain only non-empty strings",
        });
      }
    }
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.host, "$.host", issues);
    requirePositiveInteger(value.port, "$.port", issues);
    requireNonEmptyString(value.database, "$.database", issues);
    requireNonEmptyString(value.username, "$.username", issues);
    requireNonEmptyString(
      value.passwordSecretRef,
      "$.passwordSecretRef",
      issues,
    );
    requireNonEmptyString(
      value.connectionString,
      "$.connectionString",
      issues,
    );
  },
};

function validateStorage(value: unknown, issues: ShapeValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path: "$.storage", message: "must be an object" });
    return;
  }
  if (!isPositiveInteger(value.sizeGiB)) {
    issues.push({
      path: "$.storage.sizeGiB",
      message: "must be a positive integer",
    });
  }
  if (
    value.type !== undefined && value.type !== "ssd" && value.type !== "hdd"
  ) {
    issues.push({ path: "$.storage.type", message: "must be 'ssd' or 'hdd'" });
  }
}

function validateBackups(value: unknown, issues: ShapeValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path: "$.backups", message: "must be an object" });
    return;
  }
  if (typeof value.enabled !== "boolean") {
    issues.push({
      path: "$.backups.enabled",
      message: "must be a boolean",
    });
  }
  optionalPositiveInteger(
    value.retentionDays,
    "$.backups.retentionDays",
    issues,
  );
}
