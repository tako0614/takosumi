// Shared per-deployment session-hash-salt resolution for the account-session
// hash-at-rest scheme (F7). The postgres (`PostgresAccountsStore`) and D1
// (`D1AccountsStore`) stores both persist `session_id` as the SHA-256 of
// `<salt>:<rawSessionId>` so a read-only storage leak cannot be replayed
// against the API. The salt MUST be a high-entropy operator secret in
// production; the dev fallback below is public and predictable, which would
// defeat hash-at-rest if it ever shipped to production.
//
// G13 fix: when the salt env is unset AND a production marker env is set, this
// resolver throws a clear startup error instead of silently using the public
// dev fallback. In non-production it keeps the dev fallback but warns once.
//
// G13 follow-up (Workers fail-closed): on the Cloudflare Workers (D1) reference
// distribution `process.env` is absent, so process-level markers
// (NODE_ENV / TAKOSUMI_ENV) AND the salt env are ALL invisible to this resolver.
// Relying on those markers therefore failed OPEN on Workers — a Workers
// operator who forgot to wire the salt silently served real sessions hashed
// with the public dev salt. To fix-close that, the Workers entry MUST register
// its salt (and, for dev/test, an explicit dev-fallback opt-in) via
// `registerSessionHashSaltConfig` before the store hashes any session id. When
// running on Workers with no registered salt and no explicit dev opt-in, the
// resolver throws instead of using the dev fallback.

import { isWorkersRuntime, readEnvVar } from "./read-env.ts";
import { sha256Text } from "./encoding.ts";

const DEV_ONLY_SESSION_HASH_SALT = "takosumi:dev-only-session-hash-salt";

/**
 * Env var holding the per-deployment session hash salt. Shared by the Postgres
 * and D1 stores so they read the same name.
 */
export const SESSION_HASH_SALT_ENV = "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT";

/**
 * Hashes a raw `session_id` for at-rest storage as `sha256:<base64url>` of
 * `<salt>:<rawSessionId>`. This is the SINGLE shared implementation used by
 * both the Postgres and D1 stores so the two reference distributions provably
 * hash identically (previously each store carried a byte-for-byte copy). The
 * salt comes from {@link resolveSessionHashSalt}, which fails closed in
 * production when unset.
 */
export async function hashSessionId(sessionId: string): Promise<string> {
  const salt = resolveSessionHashSalt(SESSION_HASH_SALT_ENV);
  return await sha256Text(`${salt}:${sessionId}`);
}

interface RegisteredSaltConfig {
  /** Explicit salt injected from a Worker env binding (preferred on Workers). */
  readonly salt?: string;
  /**
   * Explicit opt-in to the public dev fallback when no salt is configured.
   * Must be set deliberately by dev/test Workers entries; production Workers
   * entries leave it false so a missing salt fails closed.
   */
  readonly allowDevFallback?: boolean;
}

let registeredSaltConfig: RegisteredSaltConfig | undefined;

/**
 * Register the per-deployment session hash salt from a runtime that cannot
 * expose process-level env (e.g. Cloudflare Workers, which surface secrets via
 * `env` bindings). Call this once during Worker bootstrap with the salt parsed
 * from the Worker `env` binding. Pass `allowDevFallback: true` ONLY in
 * dev/test Workers entries; production Workers entries must register a real
 * salt (or nothing, which then fails closed on Workers).
 */
export function registerSessionHashSaltConfig(
  config: RegisteredSaltConfig,
): void {
  registeredSaltConfig = config;
}

/** @internal Test-only reset of the registered Workers salt config. */
export function __resetSessionHashSaltConfigForTesting(): void {
  registeredSaltConfig = undefined;
}

/**
 * Resolves the per-deployment session hash salt for `saltEnvName`.
 *
 * Resolution order:
 *  1. An explicitly registered salt (`registerSessionHashSaltConfig`) wins.
 *  2. The process env var `saltEnvName`, when readable and non-empty.
 *  3. Otherwise the resolver must decide between the dev fallback and a
 *     fail-closed throw:
 *     - On the Bun/server runtime: throw when a production marker
 *       (`NODE_ENV=production`, `TAKOSUMI_ENV=production`)
 *       is present; otherwise use the dev fallback with a one-time warning.
 *     - On Workers (no `process.env`, so markers are invisible): throw UNLESS the
 *       Workers entry registered `allowDevFallback: true`. This keeps the
 *       guard fail-closed on the serverless production target.
 */
export function resolveSessionHashSalt(saltEnvName: string): string {
  const registeredSalt = registeredSaltConfig?.salt;
  if (registeredSalt && registeredSalt.length > 0) return registeredSalt;

  const configured = readEnvVar(saltEnvName);
  if (configured && configured.length > 0) return configured;

  if (isWorkersRuntime()) {
    if (registeredSaltConfig?.allowDevFallback) {
      warnDevFallbackOnce(saltEnvName);
      return DEV_ONLY_SESSION_HASH_SALT;
    }
    throw new Error(
      `session hash salt must be configured on Cloudflare Workers: register a ` +
        `high-entropy operator secret via registerSessionHashSaltConfig() from ` +
        `the Worker env binding (process-level production markers are not ` +
        `visible on Workers, so the dev fallback salt is refused unless the ` +
        `Workers entry explicitly opts in with allowDevFallback)`,
    );
  }

  if (isProductionMarkerPresent()) {
    throw new Error(
      `session hash salt must be configured in production: set ${saltEnvName} ` +
        `to a high-entropy operator secret (a production marker env such as ` +
        `NODE_ENV=production / TAKOSUMI_ENV=production is ` +
        `set, so the dev fallback salt is refused)`,
    );
  }
  warnDevFallbackOnce(saltEnvName);
  return DEV_ONLY_SESSION_HASH_SALT;
}

function isProductionMarkerPresent(): boolean {
  if (readEnvVar("NODE_ENV") === "production") return true;
  if (readEnvVar("TAKOSUMI_ENV") === "production") return true;
  return false;
}

const warnedSaltEnvNames = new Set<string>();

function warnDevFallbackOnce(saltEnvName: string): void {
  if (warnedSaltEnvNames.has(saltEnvName)) return;
  warnedSaltEnvNames.add(saltEnvName);
  console.warn(
    `[takosumi] ${saltEnvName} is not set; using a public dev-only ` +
      `session hash salt. Set ${saltEnvName} to a high-entropy secret before ` +
      `serving real sessions.`,
  );
}
