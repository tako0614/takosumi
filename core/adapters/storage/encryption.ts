/**
 * DB encryption-at-rest enforcement (Phase 18.3 M7).
 *
 * Production / staging refuses to start unless the storage adapter or operator
 * supplies explicit at-rest-encryption evidence. A database URL is deliberately
 * not inspected: TLS query parameters only prove encryption in transit, while
 * backend names and URL schemes are not portable security attestations.
 *
 * Local / dev environments may opt into unencrypted DBs by setting
 * `TAKOSUMI_DEV_MODE=1`. Production / staging always fail-closed
 * regardless of the override.
 */

import { isDevMode } from "../../config/dev_mode.ts";

export class DatabaseEncryptionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseEncryptionConfigurationError";
  }
}

const PRODUCTION_LIKE_ENVIRONMENTS = new Set([
  "production",
  "prod",
  "staging",
  "stage",
]);

export interface AssertDatabaseEncryptionOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Host-injected evidence from the adapter that owns the configured database.
   * The identifier is opaque to Core and must not contain secret material.
   */
  readonly evidence?: DatabaseEncryptionEvidence;
}

export interface DatabaseEncryptionEvidence {
  readonly id: string;
}

export interface DatabaseEncryptionAssertion {
  readonly required: boolean;
  readonly satisfied: boolean;
  readonly evidence?: string;
  readonly databaseUrl?: string;
  readonly overrideAccepted?: boolean;
  readonly environment: string;
}

/**
 * Returns the database URL the service will actually use, in the same
 * priority order as `maybeApplyDatabaseMigrations` / `maybeApplyAuditRetention`.
 */
export function resolveBootDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const environment = normalizeEnvironment(
    env.TAKOSUMI_ENVIRONMENT ?? env.NODE_ENV ?? env.ENVIRONMENT,
  );
  return (
    env.TAKOSUMI_DATABASE_URL ??
    env.DATABASE_URL ??
    (environment === "production"
      ? env.TAKOSUMI_PRODUCTION_DATABASE_URL
      : undefined) ??
    (environment === "staging"
      ? env.TAKOSUMI_STAGING_DATABASE_URL
      : undefined) ??
    env.TAKOSUMI_PRODUCTION_DATABASE_URL ??
    env.TAKOSUMI_STAGING_DATABASE_URL
  );
}

/**
 * Inspect the configured database URL and return a structured assertion
 * describing whether at-rest encryption is enabled.
 */
export function inspectDatabaseEncryption(
  options: AssertDatabaseEncryptionOptions,
): DatabaseEncryptionAssertion {
  const env = options.env;
  const environment = normalizeEnvironment(
    env.TAKOSUMI_ENVIRONMENT ?? env.NODE_ENV ?? env.ENVIRONMENT,
  );
  const productionLike = PRODUCTION_LIKE_ENVIRONMENTS.has(environment);
  const databaseUrl = resolveBootDatabaseUrl(env);

  if (!databaseUrl) {
    return {
      required: productionLike,
      satisfied: !productionLike,
      environment,
      ...(productionLike
        ? {
            evidence: "no-database-url",
          }
        : {}),
    };
  }

  const evidence = explicitEncryptionEvidence(options);
  if (evidence) {
    return {
      required: productionLike,
      satisfied: true,
      evidence: evidence.id,
      databaseUrl,
      environment,
    };
  }

  // No evidence of encryption - check override.
  const override = isDevMode(env);
  if (override && !productionLike) {
    return {
      required: false,
      satisfied: true,
      databaseUrl,
      environment,
      overrideAccepted: true,
      evidence: "local-override",
    };
  }
  return {
    required: productionLike,
    satisfied: false,
    databaseUrl,
    environment,
    overrideAccepted: override && !productionLike,
  };
}

/**
 * Fail-closed boot guard: throws {@link DatabaseEncryptionConfigurationError}
 * when production / staging is configured with an unencrypted database
 * connection. Local / dev returns silently unless the override flag is
 * missing.
 */
export function assertDatabaseEncryptionAtRest(
  options: AssertDatabaseEncryptionOptions,
): DatabaseEncryptionAssertion {
  const assertion = inspectDatabaseEncryption(options);
  if (assertion.satisfied) return assertion;
  if (!assertion.required) return assertion;
  const url = assertion.databaseUrl;
  throw new DatabaseEncryptionConfigurationError(
    `database encryption-at-rest not configured in ${assertion.environment}: ` +
      (url
        ? `URL ${redactDatabaseUrl(url)} lacks an encryption signal `
        : `no DATABASE_URL set; `) +
      `expected explicit storage-adapter evidence or ` +
      `TAKOSUMI_DATABASE_ENCRYPTION_AT_REST=verified, ` +
      `or the local override TAKOSUMI_DEV_MODE=1 (non-production only). ` +
      `Refusing to boot with plaintext at-rest storage.`,
  );
}

function explicitEncryptionEvidence(
  options: AssertDatabaseEncryptionOptions,
): DatabaseEncryptionEvidence | undefined {
  const injected = normalizeEvidenceId(options.evidence?.id);
  if (injected) return { id: injected };
  if (options.env.TAKOSUMI_DATABASE_ENCRYPTION_AT_REST !== "verified") {
    return undefined;
  }
  const rawConfigured = options.env.TAKOSUMI_DATABASE_ENCRYPTION_EVIDENCE;
  if (rawConfigured === undefined) return { id: "operator-attested" };
  const configured = normalizeEvidenceId(rawConfigured);
  return configured ? { id: configured } : undefined;
}

function normalizeEvidenceId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 160) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)
    ? normalized
    : undefined;
}

function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    if (parsed.username && parsed.username.length > 4) {
      parsed.username = `${parsed.username.slice(0, 2)}***`;
    }
    return parsed.toString();
  } catch {
    // Non-URL form (e.g. d1://binding). Strip query string defensively.
    const queryIndex = url.indexOf("?");
    return queryIndex === -1 ? url : `${url.slice(0, queryIndex)}?***`;
  }
}

function normalizeEnvironment(raw: string | undefined): string {
  return (raw ?? "local").trim().toLowerCase() || "local";
}
