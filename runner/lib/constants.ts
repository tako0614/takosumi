// runner/lib/constants.ts
//
// Shared constants and precompiled patterns for the OpenTofu runner.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.

export const CAPSULE_COMPATIBILITY_MAX_FILES = 256;
export const CAPSULE_COMPATIBILITY_MAX_FILE_BYTES = 1024 * 1024;
export const CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const DEFAULT_PROVIDER_MIRROR_PATH = "/opt/opentofu/provider-mirror";
export const PROVIDER_PLUGIN_CACHE_DIR_ENV =
  "TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR";
export const RUNNER_START_SERVER_ENV = "TAKOSUMI_RUNNER_START_SERVER";
export const PROVIDER_SNAPSHOT_COMMAND_ENV = "TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND";
export const PROVIDER_SNAPSHOT_COMMAND_ENV_PREFIX =
  "TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND_";
export const PROVIDER_SNAPSHOT_POINTER_DIR_ENV =
  "TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR";

export const port = Number(Bun.env.PORT ?? "8080");
export const RUN_ROOT = Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT ?? "/tmp/takosumi-runs";
export const DEFAULT_PREPARED_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_PREPARED_SOURCE_MAX_DECOMPRESSED_BYTES =
  10 * DEFAULT_PREPARED_SOURCE_MAX_BYTES;
export const BASE_COMMAND_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "REQUESTS_CA_BUNDLE",
  // Baked CLI config pointing at the offline provider filesystem mirror (see
  // runner/tofu.rc). Plan/apply/compatibility phases replace it with a per-run
  // generated config that also sets an isolated plugin_cache_dir.
  "TF_CLI_CONFIG_FILE",
] as const;
// Default cap for the produced source archive when the runner profile does not
// pin `resourceLimits.maxSourceArchiveBytes`. Source repos are small modules.
export const DEFAULT_SOURCE_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
export const RUNNER_REDACTED_VALUE = "[redacted]";
export const RUNNER_SECRET_WORD =
  "(?:secret|token|password|passwd|pwd|credential|credentials|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token|auth[_-]?token|bearer[_-]?token|connection[_-]?string|database[_-]?url|dsn)";
export const RUNNER_AUTH_HEADER_PATTERN =
  /\b(Authorization\s*:\s*(?:Bearer|Basic|Digest|Token)?\s*)[^\s,;]+/gi;
export const RUNNER_AUTH_SCHEME_PATTERN =
  /\b(Bearer|Basic|Digest|Token)\s+[-._~+/=a-zA-Z0-9]+/g;
export const RUNNER_URL_CREDENTIAL_PATTERN =
  /\b([a-z][a-z0-9+.\-]*:\/\/[^:/?#\s@]+:)([^@/?#\s]+)@/gi;
export const RUNNER_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `\\b((${RUNNER_SECRET_WORD})|(?:[A-Za-z_][A-Za-z0-9_.-]*${RUNNER_SECRET_WORD}[A-Za-z0-9_.-]*))(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,&;]+)`,
  "gi",
);
export const RUNNER_TF_VAR_ASSIGNMENT_PATTERN =
  /\b(TF_VAR_[A-Za-z_][A-Za-z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,&;]+)/g;
export const RUNNER_SECRET_ENV_NAME_PATTERN = new RegExp(
  `(^|[_-])${RUNNER_SECRET_WORD}($|[_-])`,
  "i",
);
export const RUNNER_SECRET_VALUE_PATTERN = new RegExp(
  `${RUNNER_SECRET_WORD}|(?:postgres(?:ql)?|mysql|mariadb|redis|mongo|mongodb|libsql|sqlite):\\/\\/|:\\/\\/[^/\\s:@]+:[^@\\s]+@`,
  "i",
);

export const SOURCE_CREDENTIAL_ENV_NAMES = new Set(["GIT_HTTPS_TOKEN"]);

export const INTERNAL_NAME_SUFFIXES =
  /(\.internal|\.local|\.localdomain|\.intranet|\.lan|\.corp|\.home|\.svc|\.cluster\.local)$/;
