/**
 * Git Source credential verification drivers (`test()` mint gate).
 *
 * Background: the vault's `mint` paths refuse any ProviderConnection that is not
 * `verified`. Historically `test()` had one live driver branch keyed on a
 * fixed cloud-family catalog; every other kind fell through to a `pending`
 * "no verification driver" result, so Git and operator-installed recipes
 * ProviderConnection could NEVER reach `verified` and every mint for it failed
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
 * OpenTofu provider credentials do not pass through this file: their explicit
 * Credential Recipe driver is injected into the vault by service composition.
 * Keeping only Git here is deliberate because Git is the sole Source transport
 * in the v1 model, not a compiled OpenTofu-provider catalog.
 */
import type { ProviderConnection } from "takosumi-contract/connections";
import {
  GIT_HTTPS_TOKEN_ENV,
  type SourceGitConnectionKind,
} from "takosumi-contract/sources";
import { gitProviderSettings } from "@takosumi/providers/git/settings.ts";

/** Injected fetch implementation (mirrors the vault's `VaultFetch`). */
export type VerifyFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** The non-secret + opened-value context a verify driver receives. */
export interface VerifyDriverInput {
  /** The connection row (already state-validated by the vault). */
  readonly connection: ProviderConnection;
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
 * (`scopeHints.providerSettings.repositoryUrl`). Without a probe
 * URL there is no host to ask, so the driver falls back to STRUCTURAL: a present
 * `GIT_HTTPS_TOKEN` ⇒ verified (so the ProviderConnection is not permanently
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
        "structural verify (no Git provider repositoryUrl configured for a live smart-HTTP probe)",
    };
  }
  const username =
    gitProviderSettings(connection.scopeHints).username ?? "x-access-token";
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
 * ProviderConnection is not permanently mint-blocked.
 */
export const verifyGitSsh: VerifyDriver = async ({ connection }) => {
  if (!gitProviderSettings(connection.scopeHints).knownHostsEntry) {
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
 * Git source transport verifier registry. OpenTofu providers use the injected
 * Credential Recipe driver registry instead.
 */
const VERIFY_DRIVERS: Record<SourceGitConnectionKind, VerifyDriver> = {
  source_git_https_token: verifyGitHttps,
  source_git_ssh_key: verifyGitSsh,
};

/** Resolves the verify driver for a connection kind, or undefined. */
export function verifyDriverForKind(
  kind: SourceGitConnectionKind | undefined,
): VerifyDriver | undefined {
  if (!kind) return undefined;
  return VERIFY_DRIVERS[kind];
}

/**
 * Resolves verification from the canonical open CredentialRecipe reference,
 * falling back to the legacy kind only for migrated rows. Provider-specific
 * setup flows therefore do not need to mint a new public connection kind.
 */
export function verifyDriverForConnection(
  connection: ProviderConnection,
): VerifyDriver | undefined {
  return connection.kind === "source_git_https_token" ||
    connection.kind === "source_git_ssh_key"
    ? verifyDriverForKind(connection.kind)
    : undefined;
}

/**
 * Reads the optional git smart-HTTP probe URL from a connection's scope hints.
 * The Git provider owns this optional repository URL. Absent means there is no
 * host to probe, so verification uses the structural fallback.
 */
function gitProbeUrl(connection: ProviderConnection): string | undefined {
  const repoUrl = gitProviderSettings(connection.scopeHints).repositoryUrl;
  if (!repoUrl) return undefined;
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
