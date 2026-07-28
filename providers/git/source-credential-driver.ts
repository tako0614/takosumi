/**
 * Git Source credential contribution for the reference host compositions.
 *
 * The Vault opens and state-validates secret material before invoking this
 * driver. This module owns Git-specific credential names, optional settings,
 * live verification, and runner materialization.
 */
import {
  GIT_HTTPS_TOKEN_ENV,
  GIT_SSH_PRIVATE_KEY_ENV,
  type SourceGitConnectionKind,
} from "takosumi-contract/sources";
import type {
  SourceCredentialDriverRegistry,
  SourceCredentialRuntimeDriver,
  SourceCredentialVerifyDriver,
} from "../../core/adapters/vault/driver_ports.ts";
import { mintGitSourceCredential } from "./credentials.ts";
import { gitHostScope, gitProviderSettings } from "./settings.ts";

export const verifyGitHttps: SourceCredentialVerifyDriver = async ({
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
  const repoUrl = gitProbeUrl(connection.scopeHints);
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

export const verifyGitSsh: SourceCredentialVerifyDriver = async ({
  connection,
}) => {
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

export const gitHttpsSourceCredentialDriver: SourceCredentialRuntimeDriver = {
  validateRegistration({ kind, scopeHints, values }) {
    const valueResult = validateSingleValue(
      kind,
      values,
      GIT_HTTPS_TOKEN_ENV,
    );
    if (!valueResult.ok) return valueResult;
    if (!gitHostScope(gitProviderSettings(scopeHints).repositoryUrl)) {
      return {
        ok: false,
        detail:
          "source_git_https_token requires scopeHints.providerSettings.repositoryUrl to bind the token to one host",
      };
    }
    return { ok: true };
  },
  verify: verifyGitHttps,
  mint({ connection, values, sourceUrl }) {
    if (connection.kind !== "source_git_https_token") {
      throw new Error(
        `git HTTPS driver cannot mint connection kind ${connection.kind ?? "(unknown)"}`,
      );
    }
    const settings = gitProviderSettings(connection.scopeHints);
    const boundHost = gitHostScope(settings.repositoryUrl);
    if (!boundHost) {
      throw new Error(
        `connection ${connection.id} has no repositoryUrl host binding`,
      );
    }
    if (gitHostScope(sourceUrl) !== boundHost) {
      throw new Error(
        `connection ${connection.id} is bound to ${boundHost} and must not be minted for another host`,
      );
    }
    return mintGitSourceCredential(values, {
      connectionId: connection.id,
      kind: connection.kind,
      ...(settings.username ? { username: settings.username } : {}),
    });
  },
};

export const gitSshSourceCredentialDriver: SourceCredentialRuntimeDriver = {
  validateRegistration({ kind, scopeHints, values }) {
    const valueResult = validateSingleValue(
      kind,
      values,
      GIT_SSH_PRIVATE_KEY_ENV,
    );
    if (!valueResult.ok) return valueResult;
    if (!gitProviderSettings(scopeHints).knownHostsEntry) {
      return {
        ok: false,
        detail:
          "source_git_ssh_key requires scopeHints.providerSettings.knownHostsEntry (the known_hosts line for the host)",
      };
    }
    return { ok: true };
  },
  verify: verifyGitSsh,
  mint({ connection, values }) {
    if (connection.kind !== "source_git_ssh_key") {
      throw new Error(
        `git SSH driver cannot mint connection kind ${connection.kind ?? "(unknown)"}`,
      );
    }
    const settings = gitProviderSettings(connection.scopeHints);
    return mintGitSourceCredential(values, {
      connectionId: connection.id,
      kind: connection.kind,
      ...(settings.knownHostsEntry
        ? { knownHostsEntry: settings.knownHostsEntry }
        : {}),
    });
  },
};

export const REFERENCE_SOURCE_CREDENTIAL_DRIVERS = Object.freeze({
  source_git_https_token: gitHttpsSourceCredentialDriver,
  source_git_ssh_key: gitSshSourceCredentialDriver,
}) satisfies SourceCredentialDriverRegistry;

function validateSingleValue(
  kind: SourceGitConnectionKind,
  values: Readonly<Record<string, string>>,
  expectedEnv: string,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  const envNames = Object.keys(values);
  if (envNames.length !== 1 || envNames[0] !== expectedEnv) {
    return {
      ok: false,
      detail: `${kind} requires exactly one value: ${expectedEnv}`,
    };
  }
  if (
    typeof values[expectedEnv] !== "string" ||
    values[expectedEnv].length === 0
  ) {
    return {
      ok: false,
      detail: `value for ${expectedEnv} must be a non-empty string`,
    };
  }
  return { ok: true };
}

function gitProbeUrl(
  scopeHints: Parameters<typeof gitProviderSettings>[0],
): string | undefined {
  const repoUrl = gitProviderSettings(scopeHints).repositoryUrl;
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
