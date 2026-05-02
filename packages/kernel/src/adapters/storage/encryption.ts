/**
 * DB encryption-at-rest enforcement (Phase 18.3 M7).
 *
 * The kernel previously left at-rest encryption to the operator. M7 hardens
 * the boot path so production / staging refuses to start when the configured
 * database connection is missing the encryption flag (TLS in transit + a
 * provider that encrypts at rest).
 *
 * Recognized signals (any one is sufficient):
 *
 *   - Postgres URI with `sslmode=require` / `verify-ca` / `verify-full`
 *   - Postgres URI with `ssl=true`
 *   - Generic `?encrypted=true` query parameter
 *   - Cloudflare D1 (`d1://...` or D1 binding URL): D1 is encrypted at rest
 *     by the provider unconditionally
 *   - SQLCipher / encrypted SQLite (`sqlcipher://...` or
 *     `sqlite://...?key=...`)
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
 * Returns the database URL the kernel will actually use, in the same
 * priority order as `maybeApplyDatabaseMigrations` / `maybeApplyAuditRetention`.
 */
export function resolveBootDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const environment = normalizeEnvironment(
    env.TAKOS_ENVIRONMENT ?? env.NODE_ENV ?? env.ENVIRONMENT,
  );
  return env.TAKOS_DATABASE_URL ?? env.DATABASE_URL ??
    (environment === "production"
      ? env.TAKOS_PRODUCTION_DATABASE_URL
      : undefined) ??
    (environment === "staging" ? env.TAKOS_STAGING_DATABASE_URL : undefined) ??
    env.TAKOS_PRODUCTION_DATABASE_URL ??
    env.TAKOS_STAGING_DATABASE_URL;
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
    env.TAKOS_ENVIRONMENT ?? env.NODE_ENV ?? env.ENVIRONMENT,
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

  const evidence = detectEncryptionEvidence(databaseUrl);
  if (evidence) {
    return {
      required: productionLike,
      satisfied: true,
      evidence,
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
      `expected sslmode=require / ssl=true / encrypted=true on Postgres, ` +
      `a managed-encrypted backend (D1, sqlcipher, encrypted SQLite), ` +
      `or the local override TAKOSUMI_DEV_MODE=1 (non-production only). ` +
      `Refusing to boot with plaintext at-rest storage.`,
  );
}

function detectEncryptionEvidence(databaseUrl: string): string | undefined {
  const trimmed = databaseUrl.trim();
  if (trimmed === "") return undefined;
  const lower = trimmed.toLowerCase();

  // Cloudflare D1: managed encrypted at rest by Cloudflare.
  if (
    lower.startsWith("d1://") ||
    lower.startsWith("d1+") ||
    lower.includes("cloudflare-d1")
  ) {
    return "d1-managed-encryption";
  }
  // SQLCipher: explicit encrypted SQLite distribution.
  if (lower.startsWith("sqlcipher://") || lower.startsWith("sqlcipher:")) {
    return "sqlcipher";
  }
  // Encrypted SQLite via PRAGMA key.
  if (lower.startsWith("sqlite://") || lower.startsWith("sqlite:")) {
    if (/[?&](?:key|cipher_key|cipher)=/i.test(trimmed)) {
      return "sqlite-with-key";
    }
    // Plain sqlite:// without a key has no at-rest encryption.
    return undefined;
  }
  // Generic encrypted=true override.
  if (/[?&]encrypted=true\b/i.test(trimmed)) return "encrypted-flag";
  // Postgres-style sslmode.
  const sslMatch = /[?&]sslmode=([a-zA-Z\-]+)/i.exec(trimmed);
  if (sslMatch) {
    const mode = sslMatch[1]!.toLowerCase();
    if (
      mode === "require" || mode === "verify-ca" || mode === "verify-full"
    ) {
      return `sslmode=${mode}`;
    }
    return undefined;
  }
  if (/[?&]ssl=true\b/i.test(trimmed)) return "ssl=true";

  // Some managed backends advertise tls/encryption as part of the scheme.
  if (
    lower.startsWith("postgres+tls://") ||
    lower.startsWith("postgresql+tls://")
  ) {
    return "postgres-tls-scheme";
  }

  return undefined;
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
