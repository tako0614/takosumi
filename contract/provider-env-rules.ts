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
  // `tofu init` fetches `git::`/`ssh://` module sources by spawning git, which
  // inherits the run env. Every git knob below is a command or a config
  // override that git executes through a shell, so a declared provider
  // variable named after one of them would be arbitrary code execution in the
  // credentialed plan/apply phase.
  "GIT_ALLOW_PROTOCOL",
  "GIT_ASKPASS",
  "GIT_EDITOR",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_PROXY_COMMAND",
  "GIT_SEQUENCE_EDITOR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSL_CAINFO",
  "GIT_SSL_NO_VERIFY",
  "GIT_TERMINAL_PROMPT",
  "HOME",
  "HOSTNAME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LOGNAME",
  "NO_PROXY",
  "OLDPWD",
  "PATH",
  "PWD",
  "REQUESTS_CA_BUNDLE",
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
  // GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n and
  // GIT_CONFIG_GLOBAL|SYSTEM|NOSYSTEM inject arbitrary git config into the
  // spawned git, which reaches core.sshCommand / core.fsmonitor /
  // url.*.insteadOf — the same execution surface as GIT_SSH_COMMAND.
  "GIT_CONFIG",
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
