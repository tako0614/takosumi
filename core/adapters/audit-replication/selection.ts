import type { AuditExternalReplicationSink } from "../../domains/audit-replication/external_log.ts";

const PRODUCTION_LIKE_ENVIRONMENTS = new Set([
  "production",
  "prod",
  "staging",
  "stage",
]);

export class AuditReplicationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditReplicationConfigurationError";
  }
}

/**
 * Validates an explicitly composed sink. Provider-specific selection and
 * credentials are deliberately absent: the operator host creates an adapter
 * and injects the generic sink into Takosumi core.
 */
export function requireAuditExternalReplicationSink(input: {
  readonly environment?: string;
  readonly sink?: AuditExternalReplicationSink;
}): AuditExternalReplicationSink | undefined {
  const environment = normalizeEnvironment(input.environment);
  if (!PRODUCTION_LIKE_ENVIRONMENTS.has(environment)) return input.sink;
  if (!input.sink) {
    throw new AuditReplicationConfigurationError(
      `audit-replication sink missing in ${environment}: inject an external immutable AuditExternalReplicationSink`,
    );
  }
  if (input.sink.assurance !== "immutable") {
    throw new AuditReplicationConfigurationError(
      `audit-replication sink ${input.sink.kind} is not immutable and cannot be used in ${environment}`,
    );
  }
  return input.sink;
}

function normalizeEnvironment(raw: string | undefined): string {
  return (raw ?? "local").trim().toLowerCase() || "local";
}
