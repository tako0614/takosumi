/**
 * Platform-worker binding self-check (operator first-run aid).
 *
 * The platform worker requires ~a dozen durable bindings (D1 ×2, R2 ×5,
 * Durable Objects ×3, the run queue, and the dashboard ASSETS) declared in
 * `deploy/platform/wrangler.toml`. A `wrangler deploy` succeeds even when a
 * binding is missing, so a misconfigured operator only discovers it when a real
 * install/apply fails deep in the run pipeline. This check names the missing
 * bindings up front so `/readyz` fails loudly instead.
 *
 * Cloud-only extension service bindings are listed separately. They are not
 * required for OSS/operator readiness, but Takosumi Cloud GA evidence that
 * claims AI Gateway or Cloudflare compatibility support must wire them in the
 * realized operator-private config.
 *
 * It validates PRESENCE (the binding object exists on `env`), not liveness — it
 * never touches D1/R2/DO so it is cheap and side-effect-free. ASSETS is treated
 * as required for the platform worker (it serves the dashboard SPA); an
 * API-only deploy that intentionally omits ASSETS can pass `requireAssets:
 * false`.
 */

/** Required binding names, grouped by kind, for the platform worker. */
export const REQUIRED_PLATFORM_BINDINGS = {
  d1: ["TAKOSUMI_ACCOUNTS_DB", "TAKOSUMI_CONTROL_DB"],
  r2: [
    "TAKOSUMI_ACCOUNTS_EXPORTS",
    "R2_ARTIFACTS",
    "R2_SOURCE",
    "R2_STATE",
    "R2_BACKUPS",
  ],
  durableObjects: ["COORDINATION", "RUN_OWNER", "RUNNER"],
  queues: ["RUN_QUEUE"],
  assets: ["ASSETS"],
  cloudExtensions: [
    "TAKOSUMI_CLOUD_AI_GATEWAY",
    "TAKOSUMI_CLOUD_CLOUDFLARE_COMPAT",
  ],
} as const;

export interface BindingCheckResult {
  readonly ok: boolean;
  /** Binding names that are absent from `env`, in declaration order. */
  readonly missing: readonly string[];
}

/**
 * Validates that every required platform binding is present on `env`. Returns
 * the named missing bindings (empty when fully configured).
 */
export function checkPlatformBindings(
  env: Record<string, unknown>,
  options: {
    readonly requireAssets?: boolean;
    readonly requireCloudExtensions?: boolean;
  } = {},
): BindingCheckResult {
  const requireAssets = options.requireAssets ?? true;
  const requireCloudExtensions = options.requireCloudExtensions ?? false;
  const required: string[] = [
    ...REQUIRED_PLATFORM_BINDINGS.d1,
    ...REQUIRED_PLATFORM_BINDINGS.r2,
    ...REQUIRED_PLATFORM_BINDINGS.durableObjects,
    ...REQUIRED_PLATFORM_BINDINGS.queues,
    ...(requireAssets ? REQUIRED_PLATFORM_BINDINGS.assets : []),
    ...(requireCloudExtensions
      ? REQUIRED_PLATFORM_BINDINGS.cloudExtensions
      : []),
  ];
  const missing = required.filter(
    (name) => env[name] === undefined || env[name] === null,
  );
  return { ok: missing.length === 0, missing };
}
