/**
 * Git source connection classification + env-name constants for the git
 * credential driver.
 *
 * The git "provider" is not a tofu provider: it backs the `source` phase only
 * (clone / fetch of the OpenTofu Capsule repo) and is excluded from
 * plan / apply / destroy. This module re-exports the canonical source-git
 * connection kinds and value env names from the contract and provides the
 * `isSourceGitKind` predicate the registry / vault use to keep git connections
 * out of the tofu phases.
 */
import {
  GIT_HTTPS_TOKEN_ENV,
  GIT_SSH_PRIVATE_KEY_ENV,
  type SourceGitConnectionKind,
} from "takosumi-contract/sources";
import type { ProviderConnectionKind } from "takosumi-contract/connections";

export {
  GIT_HTTPS_TOKEN_ENV,
  GIT_SSH_PRIVATE_KEY_ENV,
  type SourceGitConnectionKind,
};

/**
 * Narrows a connection kind to a {@link SourceGitConnectionKind}. A git
 * connection backs the `source` phase only and is never minted for a tofu
 * phase. Mirrors the vault's `isSourceGitKind` byte-for-byte.
 */
export function isSourceGitKind(
  kind: ProviderConnectionKind | undefined,
): kind is SourceGitConnectionKind {
  return kind === "source_git_https_token" || kind === "source_git_ssh_key";
}
