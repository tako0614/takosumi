/**
 * Per-ConnectionKind verification drivers (`test()` mint gate).
 *
 * Background: the vault's `mint` paths refuse any Connection that is not
 * `verified`. Historically `test()` had ONE live driver branch keyed on cloud
 * family (Cloudflare / AWS); every other kind fell through to a `pending`
 * "no verification driver" result, so a git source / generic-env / GCP
 * Connection could NEVER reach `verified` and every mint for it failed
 * permanently. This module makes verification per-kind so those Connections can
 * reach `verified` and unblock mint.
 *
 * Security boundary (identical to the credential drivers): the crypto /
 * secret-opening stays in core — the vault opens the sealed blob and validates
 * connection state (scope ownership, revoked, expired) BEFORE calling here. A
 * driver receives the already-opened plaintext `values`, the non-secret
 * connection context, and (for live drivers) the injected `fetch` seam only. A
 * driver never touches the store or the secret-boundary crypto, and never logs
 * the values.
 *
 * Driver families:
 *   - `live`       — an authenticated network probe (200 ⇒ verified;
 *                    401/403 ⇒ pending "bad credential"). Cloudflare token verify
 *                    and AWS AssumeRole stay live and are routed by provider id
 *                    in the vault (they predate this registry); git_https does a
 *                    smart-HTTP probe HERE when a probe URL is configured.
 *   - `structural` — verification is satisfied by the opened values' shape
 *                    (e.g. a generic-env Connection whose declared env names are all
 *                    present). No network call.
 *   - `reserved`   — no driver is wired yet. Git SSH can be structurally verified
 *                    with pinned known_hosts because the runner owns the live SSH
 *                    probe. GCP OAuth / impersonation remain pending until real
 *                    live verifier and mint drivers are wired.
 */
import type { Connection, ConnectionKind } from "takosumi-contract/connections";
import { sameProviderFamily } from "takosumi-contract/provider-env-rules";
import { GIT_HTTPS_TOKEN_ENV } from "takosumi-contract/sources";

/** Injected fetch implementation (mirrors the vault's `VaultFetch`). */
export type VerifyFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** The non-secret + opened-value context a verify driver receives. */
export interface VerifyDriverInput {
  /** The connection row (already state-validated by the vault). */
  readonly connection: Connection;
  /** The already-opened plaintext credential values. Never log these. */
  readonly values: Readonly<Record<string, string>>;
  /** Injected network seam (used by live drivers only). */
  readonly fetch: VerifyFetch;
}

/** A verify driver result. `ok` true ⇒ the connection may be marked verified. */
export interface VerifyDriverResult {
  readonly ok: boolean;
  readonly detail?: string;
}

/** A per-kind verify driver. */
export type VerifyDriver = (
  input: VerifyDriverInput,
) => Promise<VerifyDriverResult>;

/**
 * git_https: an authenticated smart-HTTP probe of
 * `<repo>/info/refs?service=git-upload-pack`.
 *
 *   - 200 ⇒ verified.
 *   - 401 / 403 ⇒ pending "bad credential" (the token is rejected by the host).
 *   - other http ⇒ pending with the status.
 *
 * The probe runs only when a repo URL is configured on the connection
 * (`scopeHints.repoUrl`, a future wiring seam read defensively). Without a probe
 * URL there is no host to ask, so the driver falls back to STRUCTURAL: a present
 * `GIT_HTTPS_TOKEN` ⇒ verified (so the Connection is not permanently
 * mint-blocked), a missing token ⇒ pending.
 */
export const verifyGitHttps: VerifyDriver = async ({
  connection,
  values,
  fetch,
}) => {
  const token = values[GIT_HTTPS_TOKEN_ENV];
  if (!token) {
    return {
      ok: false,
      detail: `git https connection has no ${GIT_HTTPS_TOKEN_ENV}`,
    };
  }
  const repoUrl = gitProbeUrl(connection);
  if (!repoUrl) {
    return {
      ok: true,
      detail:
        "structural verify (no scopeHints.repoUrl configured for a live smart-HTTP probe)",
    };
  }
  const username = connection.scopeHints?.username ?? "x-access-token";
  const probeUrl = `${repoUrl.replace(/\/$/, "")}/info/refs?service=git-upload-pack`;
  let response: Response;
  try {
    response = await fetch(probeUrl, {
      method: "GET",
      headers: {
        authorization: `Basic ${basicAuth(username, token)}`,
        "user-agent": "git/2.40 takosumi-vault-verify",
      },
    });
  } catch (error) {
    return {
      ok: false,
      detail: `git smart-http probe failed: ${errorMessage(error)}`,
    };
  }
  if (response.status === 200) return { ok: true };
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      detail: "bad credential (git host rejected the token)",
    };
  }
  return {
    ok: false,
    detail: `git smart-http probe returned http ${response.status}`,
  };
};

/**
 * git_ssh: there is no runner-sandbox `ls-remote` seam reachable from the vault
 * (an SSH probe would need a runner call we must NOT invent here). RESERVED:
 * structural-verified when the key + pinned known_hosts are present so the
 * Connection is not permanently mint-blocked.
 */
export const verifyGitSsh: VerifyDriver = async ({ connection }) => {
  if (!connection.scopeHints?.knownHostsEntry) {
    return {
      ok: false,
      detail: "git ssh connection is missing its pinned known_hosts entry",
    };
  }
  return {
    ok: true,
    detail:
      "reserved structural verify (no in-vault ls-remote seam; live SSH probe needs a runner call)",
  };
};

/**
 * generic_env_provider: STRUCTURAL. The Connection declares its env names in
 * `connection.envNames`; verification is satisfied when every declared name is
 * present in the opened values (and there is at least one). Missing any declared
 * name ⇒ pending.
 */
export const verifyGenericEnvProvider: VerifyDriver = async ({
  connection,
  values,
  fetch,
}) => {
  if (isReservedGcpConnection(connection)) {
    return verifyGcpReserved({ connection, values, fetch });
  }
  const declared = connection.envNames;
  if (declared.length === 0) {
    return { ok: false, detail: "generic-env provider declares no env names" };
  }
  const missing = declared.filter(
    (name) => typeof values[name] !== "string" || values[name].length === 0,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      detail: `generic-env provider is missing values for: ${missing.join(", ")}`,
    };
  }
  return { ok: true };
};

/**
 * gcp_service_account_json: STRUCTURAL. Service account JSON is a static
 * provider credential recipe, not a live OAuth / impersonation helper. We avoid
 * a network probe here because the OpenTofu provider will use the JSON during
 * plan/apply; the vault only verifies that the opened value is a plausible
 * service-account credential and that a project is known.
 */
export const verifyGcpServiceAccountJson: VerifyDriver = async ({
  values,
}) => {
  const raw = values.GOOGLE_CREDENTIALS;
  if (!raw) {
    return { ok: false, detail: "gcp service account JSON is missing" };
  }
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return { ok: false, detail: "gcp service account JSON is invalid JSON" };
  }
  if (parsed.type !== "service_account") {
    return {
      ok: false,
      detail: "gcp credential JSON must have type service_account",
    };
  }
  for (const field of ["client_email", "private_key"] as const) {
    if (typeof parsed[field] !== "string" || parsed[field].length === 0) {
      return {
        ok: false,
        detail: `gcp service account JSON is missing ${field}`,
      };
    }
  }
  const project =
    stringValue(values.GOOGLE_CLOUD_PROJECT) ??
    stringValue(values.GOOGLE_PROJECT) ??
    stringValue(parsed.project_id);
  if (!project) {
    return {
      ok: false,
      detail:
        "gcp service account JSON requires GOOGLE_CLOUD_PROJECT or project_id",
    };
  }
  return { ok: true };
};

/**
 * gcp reserved helpers. The GCP impersonation / OAuth driver wiring is
 * reserved, so a live probe is not available. Keep these Connections pending
 * instead of marking them verified; a reserved helper must never become
 * runnable until a real verify + mint driver exists.
 */
export const verifyGcpReserved: VerifyDriver = async () => ({
  ok: false,
  detail:
    "reserved (gcp live verification and credential mint drivers pending)",
});

/**
 * Per-ConnectionKind verify driver registry. The vault routes `test()` through
 * `verifyDriverForKind` for kinds NOT already handled by the live
 * Cloudflare / AWS provider-id branches. A kind with no entry returns
 * `undefined`, and the vault keeps its existing `pending` "no verification
 * driver" fallback for it.
 */
const VERIFY_DRIVERS: Partial<Record<ConnectionKind, VerifyDriver>> = {
  source_git_https_token: verifyGitHttps,
  source_git_ssh_key: verifyGitSsh,
  generic_env_provider: verifyGenericEnvProvider,
  gcp_service_account_json: verifyGcpServiceAccountJson,
  gcp_oauth_bootstrap: verifyGcpReserved,
  gcp_service_account_impersonation: verifyGcpReserved,
};

/** Resolves the verify driver for a connection kind, or undefined. */
export function verifyDriverForKind(
  kind: ConnectionKind | undefined,
): VerifyDriver | undefined {
  if (!kind) return undefined;
  return VERIFY_DRIVERS[kind];
}

function isReservedGcpConnection(connection: Connection): boolean {
  if (
    connection.kind === "gcp_oauth_bootstrap" ||
    connection.kind === "gcp_service_account_impersonation"
  ) {
    return true;
  }
  // Folded from the former `gcp_oauth_bootstrap` credentialDriver: a gcp OAuth
  // credential is registered with kind generic_env_provider + materialization
  // oauth; it stays reserved (pending) until the gcp mint driver is wired.
  return (
    connection.materialization === "oauth" &&
    sameProviderFamily(connection.provider, "google")
  );
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Reads the optional git smart-HTTP probe URL from a connection's scope hints.
 * `repoUrl` is a forward-looking wiring seam (a Source/InstallConfig may surface
 * the repo to probe); it is read defensively so the contract type need not carry
 * it yet. Absent ⇒ no live probe (structural fallback).
 */
function gitProbeUrl(connection: Connection): string | undefined {
  const hints = connection.scopeHints as
    | (Connection["scopeHints"] & { readonly repoUrl?: unknown })
    | undefined;
  const repoUrl = hints?.repoUrl;
  if (typeof repoUrl !== "string") return undefined;
  const trimmed = repoUrl.trim();
  return trimmed.length > 0 && /^https?:\/\//.test(trimmed)
    ? trimmed
    : undefined;
}

function basicAuth(username: string, token: string): string {
  return btoa(`${username}:${token}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
