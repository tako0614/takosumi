/**
 * Provider-source and runner env-name syntax helpers.
 *
 * This generic contract intentionally contains no provider catalog, credential
 * env table, auth-mode inference, or partition mapping. Provider-owned
 * descriptors and installed Credential Recipes carry those declarations.
 */

/** Uppercase environment-variable identifier rule (`FOO`, `FOO_BAR`, `_BAR`). */
export const PROVIDER_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

export function isProviderEnvName(value: string): boolean {
  return PROVIDER_ENV_NAME_PATTERN.test(value);
}

const RESERVED_PROVIDER_ENV_NAMES = new Set([
  "ALL_PROXY",
  "GIT_ASKPASS",
  "HOME",
  "HOSTNAME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LOGNAME",
  "NO_PROXY",
  "OLDPWD",
  "PATH",
  "PWD",
  "SHELL",
  "SSH_AUTH_SOCK",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
]);

const RESERVED_PROVIDER_ENV_PREFIXES = [
  "BUN_",
  "DYLD_",
  "LD_",
  "NODE_",
  "NPM_",
  "OPENTOFU_",
  "TAKOSUMI_",
  "TF_",
] as const;

/** Runner/runtime-owned env names that Credential Recipes may not override. */
export function isReservedProviderEnvName(value: string): boolean {
  return (
    RESERVED_PROVIDER_ENV_NAMES.has(value) ||
    RESERVED_PROVIDER_ENV_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

const DEFAULT_OPENTOFU_REGISTRY = "registry.opentofu.org/";
const DEFAULT_REGISTRY_IDENTITY_PATTERN = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u;

/**
 * Generic provider-source normalization. Only an explicit `namespace/type`
 * source receives the default OpenTofu registry host; bare local names remain
 * bare and custom registry hosts remain unchanged.
 */
export function normalizeProviderSourceAddress(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return DEFAULT_REGISTRY_IDENTITY_PATTERN.test(normalized)
    ? `${DEFAULT_OPENTOFU_REGISTRY}${normalized}`
    : normalized;
}

export function canonicalProviderSource(provider: string): string {
  return normalizeProviderSourceAddress(provider);
}

/** Exact source comparison after default-registry qualification. */
export function sameProviderSource(left: string, right: string): boolean {
  return (
    normalizeProviderSourceAddress(left) ===
    normalizeProviderSourceAddress(right)
  );
}

/**
 * One-directional policy match without local-name or vendor inference. Exact
 * sources match; `namespace/type` rules also match their fully-qualified
 * default-registry spelling. Wildcards are handled by the policy caller.
 */
export function providerMatches(provider: string, rule: string): boolean {
  return sameProviderSource(provider, rule);
}
