/**
 * Source URL policy (Core Specification §7.1).
 *
 * Allowed forms:
 *   - `https://host/path` (optionally `.git`)
 *   - `ssh://git@host/path`
 *   - scp-style `git@host:path`
 *
 * Forbidden forms (each for a security reason):
 *   - `file://`          — local filesystem access from the runner
 *   - absolute path      — `/etc/...` local filesystem access
 *   - relative path      — `./x`, `../x`, bare `x` local filesystem access
 *   - `git://`           — unauthenticated, MITM-prone transport
 *   - `ext::`            — arbitrary command execution transport
 *   - embedded creds     — `user:pass@host` credential leakage in the URL
 *
 * The policy is shape-only: it never performs DNS / network resolution (that
 * happens in the untrusted runner during a `source_sync` run).
 */

import {
  assertHostNotBlocked,
  BlockedHostError,
} from "takosumi-contract/reference/host-blocklist";

export type SourceUrlScheme = "https" | "ssh" | "scp";

export interface SourceUrlPolicyOk {
  readonly ok: true;
  readonly scheme: SourceUrlScheme;
  /** Normalized host (lowercased, no port stripped — kept as authored host). */
  readonly host: string;
}

export type SourceUrlPolicyReason =
  | "empty"
  | "embedded_credentials"
  | "forbidden_scheme_file"
  | "forbidden_scheme_git"
  | "forbidden_scheme_ext"
  | "forbidden_scheme_other"
  | "absolute_path"
  | "relative_path"
  | "missing_host"
  | "blocked_host"
  | "malformed";

export interface SourceUrlPolicyDenied {
  readonly ok: false;
  readonly reason: SourceUrlPolicyReason;
}

export type SourceUrlPolicyResult = SourceUrlPolicyOk | SourceUrlPolicyDenied;

const SCP_LIKE = /^(?<user>[^@/:]+)@(?<host>[^:/]+):(?<path>.+)$/;

/**
 * Evaluates a Source URL against the §7.1 allow/forbid policy. Returns a typed
 * result with the matched scheme/host on success or a precise reason on denial.
 */
export function evaluateSourceUrl(raw: string): SourceUrlPolicyResult {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: "empty" };

  // file:// — local filesystem access.
  if (/^file:\/\//i.test(value)) {
    return { ok: false, reason: "forbidden_scheme_file" };
  }
  // git:// — unauthenticated transport.
  if (/^git:\/\//i.test(value)) {
    return { ok: false, reason: "forbidden_scheme_git" };
  }
  // ext:: — arbitrary command execution transport.
  if (/^ext::/i.test(value)) {
    return { ok: false, reason: "forbidden_scheme_ext" };
  }
  // Absolute filesystem path.
  if (value.startsWith("/")) {
    return { ok: false, reason: "absolute_path" };
  }
  // Relative filesystem path.
  if (value.startsWith("./") || value.startsWith("../")) {
    return { ok: false, reason: "relative_path" };
  }

  if (/^https:\/\//i.test(value)) {
    return evaluateUrlForm(value, "https");
  }
  if (/^ssh:\/\//i.test(value)) {
    return evaluateUrlForm(value, "ssh");
  }

  // Any other explicit `scheme://` is an unknown/forbidden transport.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return { ok: false, reason: "forbidden_scheme_other" };
  }

  // scp-style `git@host:path`. Reject if it actually carries another scheme.
  const scp = SCP_LIKE.exec(value);
  if (scp?.groups) {
    const user = scp.groups.user;
    const host = scp.groups.host;
    // Embedded credentials in scp form: `user:pass@host:path` -> user contains ':'.
    if (user.includes(":")) {
      return { ok: false, reason: "embedded_credentials" };
    }
    if (host.length === 0) return { ok: false, reason: "missing_host" };
    return okHost("scp", host);
  }

  // A bare word / dotted path with no scheme and no scp form is relative.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    // `scheme:something` without `//` and not scp-form — forbidden transport.
    return { ok: false, reason: "forbidden_scheme_other" };
  }
  return { ok: false, reason: "relative_path" };
}

function evaluateUrlForm(
  value: string,
  scheme: Extract<SourceUrlScheme, "https" | "ssh">,
): SourceUrlPolicyResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // Embedded credentials: `https://user:pass@host` or `https://user@host`.
  if (url.username.length > 0 || url.password.length > 0) {
    // ssh://git@host is the canonical, allowed form: a bare username with no
    // password is the git transport user, not embedded credentials.
    const bareGitUser = scheme === "ssh" && url.password.length === 0;
    if (!bareGitUser) {
      return { ok: false, reason: "embedded_credentials" };
    }
  }
  if (url.hostname.length === 0) {
    return { ok: false, reason: "missing_host" };
  }
  return okHost(scheme, url.hostname);
}

function okHost(
  scheme: SourceUrlScheme,
  host: string,
): SourceUrlPolicyResult {
  const normalized = host.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "metadata.google.internal"
  ) {
    return { ok: false, reason: "blocked_host" };
  }
  try {
    assertHostNotBlocked(normalized, "source URL host");
  } catch (error) {
    if (error instanceof BlockedHostError) {
      return { ok: false, reason: "blocked_host" };
    }
    throw error;
  }
  return { ok: true, scheme, host: normalized };
}

/** Convenience boolean wrapper. */
export function isAllowedSourceUrl(raw: string): boolean {
  return evaluateSourceUrl(raw).ok;
}
