import { log } from "../shared/log.ts";

/**
 * Single dev-mode opt-out flag for Takosumi self-host.
 *
 * Replaces the historical trio of `*_ALLOW_PLAINTEXT_SECRETS` /
 * `*_ALLOW_UNENCRYPTED_DB` / `*_ALLOW_UNSAFE_DEFAULTS` flags with one
 * canonical switch: `TAKOSUMI_DEV_MODE=1`.
 *
 * When `TAKOSUMI_DEV_MODE=1`:
 *  - plaintext secret storage is allowed (memory secret store falls back
 *    to the placeholder crypto if no encryption key is configured)
 *  - unencrypted databases are allowed
 *  - unsafe production-shaped defaults are allowed (reference / noop
 *    plugin selections, in-memory adapters, missing audit replication
 *    sink in non-production environments)
 *  - the kernel logs a single startup warning so operators are aware
 *    that the running process is not production-hardened
 *
 * When unset (the production default) every guard remains strict.
 *
 * Production / staging environments always fail-closed regardless of
 * `TAKOSUMI_DEV_MODE` — the dev-mode flag only relaxes guards on
 * non-production environments. Each call site is responsible for
 * enforcing the production gate; this helper only normalises the
 * boolean read from the environment.
 */

export type DevModeEnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Returns true when the operator has opted into Takosumi dev mode by
 * setting `TAKOSUMI_DEV_MODE=1` (also accepts `true`, `yes`, `on`).
 */
export function isDevMode(env: DevModeEnvLike): boolean {
  const raw = env.TAKOSUMI_DEV_MODE;
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" ||
    normalized === "yes" || normalized === "on" || normalized === "enabled";
}

/**
 * Logs a single startup warning when dev mode is active. Safe to call
 * unconditionally — when dev mode is off, this is a no-op.
 *
 * Callers can pass an optional `logger` for testability; defaults to a
 * single structured `kernel.boot.dev_mode_enabled` warning emitted via
 * the kernel logger.
 */
export function warnIfDevMode(
  env: DevModeEnvLike,
  logger?: (message: string) => void,
): void {
  if (!isDevMode(env)) return;
  if (logger) {
    logger(
      "[takosumi] TAKOSUMI_DEV_MODE is on; do not use for production. " +
        "Plaintext secrets, unencrypted databases, and unsafe defaults are " +
        "permitted in this process.",
    );
    return;
  }
  log.warn("kernel.boot.dev_mode_enabled", {
    hint:
      "TAKOSUMI_DEV_MODE is on; do not use for production. Plaintext " +
      "secrets, unencrypted databases, and unsafe defaults are permitted " +
      "in this process.",
  });
}
