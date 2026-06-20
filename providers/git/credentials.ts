/**
 * Git source credential driver (source phase).
 *
 * This is the provider-specific implementation the provider runtime registry
 * (`@takosumi/providers`) refers to for the git "source" credential: it turns a
 * git source connection's ALREADY-OPENED secret values plus its connection
 * context (kind + scope hints) into the runner-facing {@link MintResponse} — an
 * askpass script (HTTPS token) or the ssh key + pinned known_hosts files (SSH).
 *
 * Security boundary: the crypto / secret-opening stays in core (the vault opens
 * the sealed blob and validates connection state — scope ownership, revoked,
 * expired, verified). This driver receives the plaintext `values` and the
 * non-secret context only, and never touches the store, crypto, or network. Its
 * outputs are secret material (the askpass script embeds the token, the key file
 * embeds the private key) and must never be logged or persisted to the public
 * ledger — the vault wraps the {@link MintResponse} in its opaque bundle.
 */
import {
  GIT_HTTPS_TOKEN_ENV,
  GIT_SSH_PRIVATE_KEY_ENV,
  type MintResponse,
  type SourceGitConnectionKind,
} from "takosumi-contract/sources";

/** Raised for a git source credential the opened values can't satisfy. */
export class GitCredentialMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCredentialMintError";
  }
}

/**
 * The non-secret connection context the git driver needs. Mirrors the
 * vault-provided fields read by `#mintSourceGit`: the connection id (for error
 * messages), the source-git kind, and the relevant scope hints. The vault has
 * already validated scope ownership / status / expiry before calling here.
 */
export interface GitCredentialContext {
  /** Connection id (used in error messages only). */
  readonly connectionId: string;
  /** Which git source credential kind this connection is. */
  readonly kind: SourceGitConnectionKind;
  /** HTTPS askpass username (defaults to `x-access-token`). */
  readonly username?: string;
  /** Pinned known_hosts line for the SSH host (required for the ssh kind). */
  readonly knownHostsEntry?: string;
}

/**
 * Mints the runner-facing git source credential from already-opened secret
 * values plus the connection context.
 *
 *   - `source_git_https_token`: `{ GIT_HTTPS_TOKEN }` -> env `GIT_TERMINAL_PROMPT=0`
 *     plus an `askpass.sh` (mode 0o700) echoing the username / token.
 *   - `source_git_ssh_key`: `{ GIT_SSH_PRIVATE_KEY }` (+ required known_hosts) ->
 *     an `id_source` key file (0o600) and a pinned `known_hosts` file (0o600);
 *     the runner constructs StrictHostKeyChecking=yes after materializing them.
 *
 * Throws {@link GitCredentialMintError} when the expected value is missing, or
 * when an ssh connection has no pinned known_hosts entry.
 */
export function mintGitSourceCredential(
  values: Readonly<Record<string, string>>,
  context: GitCredentialContext,
): MintResponse {
  if (context.kind === "source_git_https_token") {
    const token = values[GIT_HTTPS_TOKEN_ENV];
    if (!token) {
      throw new GitCredentialMintError(
        `connection ${context.connectionId} has no ${GIT_HTTPS_TOKEN_ENV}`,
      );
    }
    const username = context.username ?? "x-access-token";
    const askpass = gitAskpassScript(username, token);
    return {
      env: {
        GIT_TERMINAL_PROMPT: "0",
      },
      files: [
        {
          path: "askpass.sh",
          mode: 0o700,
          content: askpass,
        },
      ],
    };
  }

  // source_git_ssh_key
  const key = values[GIT_SSH_PRIVATE_KEY_ENV];
  if (!key) {
    throw new GitCredentialMintError(
      `connection ${context.connectionId} has no ${GIT_SSH_PRIVATE_KEY_ENV}`,
    );
  }
  const knownHosts = context.knownHostsEntry;
  if (!knownHosts) {
    throw new GitCredentialMintError(
      `connection ${context.connectionId} is missing its known_hosts entry`,
    );
  }
  const keyContent = key.endsWith("\n") ? key : `${key}\n`;
  const knownHostsContent = knownHosts.endsWith("\n")
    ? knownHosts
    : `${knownHosts}\n`;
  return {
    env: {},
    files: [
      {
        path: "id_source",
        mode: 0o600,
        content: keyContent,
      },
      {
        path: "known_hosts",
        mode: 0o600,
        content: knownHostsContent,
      },
    ],
  };
}

/**
 * Builds a GIT_ASKPASS script that echoes the username on the first prompt and
 * the token on the password prompt. Git invokes the script with the prompt text
 * as `$1`; a prompt containing "Username" yields the user, anything else (the
 * password prompt) yields the token. Single quotes in the values are escaped so
 * the script cannot break out of the quoting.
 */
export function gitAskpassScript(username: string, token: string): string {
  const u = shellSingleQuote(username);
  const t = shellSingleQuote(token);
  return [
    "#!/bin/sh",
    `case "$1" in`,
    `  *sername*) printf '%s' ${u} ;;`,
    `  *) printf '%s' ${t} ;;`,
    "esac",
    "",
  ].join("\n");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
